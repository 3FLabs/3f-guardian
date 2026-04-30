import type {
  GuardianAbstractions,
  SigningContext,
  TokenInfo,
  ValidateAndSign,
} from "../abstractions.ts";
import { unwrapOrThrow } from "./result.ts";

/**
 * Shared pre-amble for every signing endpoint:
 *   1. Resolve the chain client (yields `unsupported_chain` if absent).
 *   2. Build a fresh `SigningContext` snapshotted at request time.
 *   3. Hand off to the abstraction's validate-and-sign function.
 *   4. Throw on `Err` so the global error handler maps it to §6.5.
 *
 * Centralises the §6.4 / §6.6 plumbing so each route file is just a
 * wiring of body schema → abstraction.
 */
export async function runSigning<TBody extends { chainId: number }, TSuccess, TError>(args: {
  abs: GuardianAbstractions;
  sign: ValidateAndSign<TBody, TSuccess, TError>;
  body: TBody;
  requestId: string;
  tokenInfo: TokenInfo;
}): Promise<TSuccess> {
  const { abs, sign, body, requestId, tokenInfo } = args;
  const client = unwrapOrThrow(abs.getChainClient(body.chainId));
  const ctx: SigningContext = {
    chainId: body.chainId,
    client,
    requestId,
    tokenId: tokenInfo.tokenId,
    now: new Date(),
    signTypedData: abs.signTypedData,
  };
  return unwrapOrThrow(await sign(ctx, body));
}
