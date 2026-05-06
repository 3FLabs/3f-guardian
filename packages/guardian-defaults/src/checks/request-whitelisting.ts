import { Result } from "better-result";

import { type RequestWhitelistingBody, UpstreamUnavailableError } from "@3flabs/guardian";
import type { CheckEntry, SigningContext } from "@3flabs/guardian";

import { checkDeadline, checkMembership, checkNonceWindow, rollUp } from "./helpers.js";
import {
  type IntentRequestBindingPolicy,
  type RequestContractReader,
} from "./intent-request-binding.js";
import type { CheckRunner, CheckRunnerError } from "./types.js";

/**
 * §A.4 policy. The contract-side policy fields mirror §A.1 because for
 * `operation = "whitelist"` Appendix A.4 says "the checks of §A.1,
 * applied independently to each entry of `requestContracts`. The first
 * three checks are contract-specific; the deadline check is request-
 * wide."
 *
 * `maxNonceAboveFloor` is a bigint to keep the on-chain nonce
 * arithmetic exact.
 */
export type RequestWhitelistingPolicy = IntentRequestBindingPolicy & {
  /** §11 MAX_NONCE_ABOVE_FLOOR. */
  readonly maxNonceAboveFloor: bigint;
};

/**
 * Adapter port for whitelist-book reads.
 *
 *  - `readNonceFloor` returns the on-chain monotonic floor.
 *  - `readNonceConsumed` returns true iff the supplied nonce is
 *    already recorded as consumed by the on-chain whitelist book.
 */
export type WhitelistBookReader = {
  readonly readNonceFloor: (ctx: SigningContext, whitelistBook: string) => Promise<bigint>;
  readonly readNonceConsumed: (
    ctx: SigningContext,
    args: { whitelistBook: string; nonce: bigint },
  ) => Promise<boolean>;
};

/**
 * Builds the §A.4 check runner.
 *
 * For both operations:
 *   - the three nonce checks (consumed / floor / ceiling) apply
 *     verbatim per Appendix A.4.
 *
 * For `operation = "whitelist"`:
 *   - the first three §A.1 contract-specific checks (origin, owner,
 *     puller, consumer) apply to each entry of `requestContracts`. To
 *     keep the §6.4.1 checks array readable, per-contract entries are
 *     suffixed with `for <address>`.
 *
 * For `operation = "unwhitelist"`:
 *   - only the request-wide deadline check applies.
 *
 * The deadline check is request-wide in both modes.
 *
 * Per §A.4, all rejections are 422-class. The §7.6 sentinel rejection
 * (`nonce = 2^256 − 1` ⇒ 400 bad_request) is the schema's job and is
 * not visible here.
 */
export function buildRequestWhitelistingChecks(deps: {
  policy: RequestWhitelistingPolicy;
  requestReader: RequestContractReader;
  bookReader: WhitelistBookReader;
}): CheckRunner<RequestWhitelistingBody, false> {
  const { policy, requestReader, bookReader } = deps;

  return async (ctx, body): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> => {
    const checks: CheckEntry[] = [];
    const nowSec = Math.floor(ctx.now.getTime() / 1000);

    // 1. Per-operation contract-side checks.
    if (body.operation === "whitelist") {
      // For each request contract: origin / owner / puller / consumer.
      // We don't run per-contract deadline checks (deadline is request-wide).
      const acceptedOrigins = policy.acceptedRequestOrigins.get(body.chainId) ?? new Set<string>();
      const acceptedOwners = policy.acceptedOwners.get(body.chainId) ?? new Set<string>();
      const acceptedPullers = policy.acceptedPullers.get(body.chainId) ?? new Set<string>();
      const acceptedConsumers = policy.acceptedConsumers.get(body.chainId) ?? new Set<string>();

      for (const requestContract of body.requestContracts) {
        const onOrigins = checkMembership({
          description: `request contract is on the accepted-origins policy (for ${requestContract})`,
          value: requestContract,
          accepted: acceptedOrigins,
          addressLike: true,
        });
        checks.push(onOrigins);

        if (!onOrigins.passed) {
          // Skip on-chain reads for an off-policy contract.
          continue;
        }

        let owner: string;
        let puller: string;
        let consumer: string;
        try {
          // Sequential per-contract on purpose: the batch may carry
          // many contracts and parallelising N×3 RPCs across the whole
          // batch would flood the upstream node. We do parallelise the
          // three reads per contract, just not across contracts.
          // oxlint-disable-next-line no-await-in-loop
          [owner, puller, consumer] = await Promise.all([
            requestReader.readOwner(ctx, requestContract),
            requestReader.readPuller(ctx, requestContract),
            requestReader.readConsumer(ctx, requestContract),
          ]);
        } catch (e) {
          ctx.logger.error(
            { err: e instanceof Error ? e.message : e, requestContract },
            "A.4: per-contract on-chain read failed",
          );
          return Result.err(
            new UpstreamUnavailableError({
              message: `request-contract read failed for ${requestContract}: ${e instanceof Error ? e.message : "unknown"}`,
              status: 503,
            }),
          );
        }

        checks.push(
          checkMembership({
            description: `owner of request contract is on the accepted-owners list (for ${requestContract})`,
            value: owner,
            accepted: acceptedOwners,
            addressLike: true,
          }),
          checkMembership({
            description: `puller role on request contract is restricted to accepted parties (for ${requestContract})`,
            value: puller,
            accepted: acceptedPullers,
            addressLike: true,
          }),
          checkMembership({
            description: `consumer role on request contract is restricted to accepted parties (for ${requestContract})`,
            value: consumer,
            accepted: acceptedConsumers,
            addressLike: true,
          }),
        );
      }
    }

    // 2. Request-wide deadline check.
    checks.push(
      checkDeadline({
        nowUnixSeconds: nowSec,
        deadline: body.deadline,
        maxSecondsAhead: policy.maxDeadlineSecondsAhead,
      }),
    );

    // 3. Nonce checks (both operations).
    const nonce = BigInt(body.nonce);
    let floor: bigint;
    let consumed: boolean;
    try {
      [floor, consumed] = await Promise.all([
        bookReader.readNonceFloor(ctx, body.whitelistBook),
        bookReader.readNonceConsumed(ctx, { whitelistBook: body.whitelistBook, nonce }),
      ]);
    } catch (e) {
      ctx.logger.error(
        { err: e instanceof Error ? e.message : e, whitelistBook: body.whitelistBook },
        "A.4: whitelist-book read failed",
      );
      return Result.err(
        new UpstreamUnavailableError({
          message: `whitelist-book read failed: ${e instanceof Error ? e.message : "unknown"}`,
          status: 503,
        }),
      );
    }

    checks.push(
      ...checkNonceWindow({
        nonce,
        consumed,
        floor,
        maxAboveFloor: policy.maxNonceAboveFloor,
      }),
    );

    const r = rollUp(checks, "Appendix A.4 checks failed");
    return r.ok ? Result.ok(r.checks) : Result.err(r.error);
  };
}
