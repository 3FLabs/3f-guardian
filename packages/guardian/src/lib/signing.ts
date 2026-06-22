import type {
  GuardianAbstractions,
  SigningContext,
  TokenInfo,
  ValidateAndSign,
} from "../abstractions.js";
import { resolveGuardianTimeouts, withAbstractionDeadline } from "./deadline.js";
import type { Logger } from "./logger.js";
import { unwrapOrThrow } from "./result.js";

export type SigningAbstractions = Pick<
  GuardianAbstractions,
  "getChainClient" | "probeUpstream" | "signTypedData" | "timeouts"
>;

/**
 * Shared pre-amble for every signing endpoint:
 *   1. Consult `abs.probeUpstream` (when supplied) so a host that already
 *      knows its upstream is down fails fast with 502/503.
 *   2. Resolve the chain client (yields `unsupported_chain` if absent).
 *   3. Build a fresh `SigningContext` snapshotted at request time.
 *   4. Hand off to the abstraction's validate-and-sign function, bounded
 *      by the `signMs` deadline (503 on expiry).
 *   5. Throw on `Err` so the global error handler maps it to §6.5.
 *
 * Centralises the §6.4 / §6.6 plumbing so each route file is just a
 * wiring of body schema → abstraction.
 */
export async function runSigning<TBody extends { chainId: number }, TSuccess, TError>(args: {
  abs: SigningAbstractions;
  sign: ValidateAndSign<TBody, TSuccess, TError>;
  body: TBody;
  requestId: string;
  tokenInfo: TokenInfo;
  logger: Logger;
  /**
   * The HTTP request's own abort signal (fires on client disconnect).
   * Joined with the `signMs` deadline signal so a disconnected client's
   * on-chain/KMS work stops at the next cancellation point instead of
   * running to the full budget — every client retry would otherwise
   * stack another full concurrent validate-and-sign.
   */
  requestSignal?: AbortSignal;
}): Promise<TSuccess> {
  const { abs, sign, body, requestId, tokenInfo, logger, requestSignal } = args;
  if (abs.probeUpstream) unwrapOrThrow(abs.probeUpstream());
  const client = unwrapOrThrow(abs.getChainClient(body.chainId));
  const timeouts = resolveGuardianTimeouts(abs.timeouts);
  const signLogger = logger.child({ chainId: body.chainId });
  const result = await withAbstractionDeadline(
    (signal) => {
      const ctx: SigningContext = {
        chainId: body.chainId,
        client,
        requestId,
        tokenId: tokenInfo.tokenId,
        now: new Date(),
        signTypedData: abs.signTypedData,
        logger: signLogger,
        signal: requestSignal !== undefined ? AbortSignal.any([signal, requestSignal]) : signal,
      };
      return sign(ctx, body);
    },
    { ms: timeouts.signMs, abstraction: "sign", logger: signLogger },
  );
  return unwrapOrThrow(result);
}
