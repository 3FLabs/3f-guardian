import { Result } from "better-result";
import { type Address } from "viem";

import {
  type CheckEntry,
  type RequestWhitelistingBody,
  type SigningContext,
  UpstreamUnavailableError,
} from "@3flabs/guardian";

import { whitelistBookAbi } from "../abi/whitelist-book.js";
import { checkDeadline, checkNonceWindow, rollUp } from "./helpers.js";
import { type IntentRequestBindingPolicy, runA1 } from "./intent-request-binding.js";
import type { CheckRunner, CheckRunnerError } from "./types.js";

/**
 * §A.4 policy. The contract-side fields mirror §A.1 because for
 * `operation = "whitelist"` Appendix A.4 says "the §A.1 checks applied
 * independently to each entry of `requestContracts`. The first three
 * checks are contract-specific; the deadline check is request-wide."
 *
 * `maxNonceAboveFloor` is a bigint to keep the on-chain nonce
 * arithmetic exact.
 */
export type RequestWhitelistingPolicy = IntentRequestBindingPolicy & {
  readonly maxNonceAboveFloor: bigint;
};

/**
 * Builds the §A.4 check runner.
 *
 * For both operations the request-wide nonce checks (consumed / floor /
 * ceiling) and deadline check apply. For `operation = "whitelist"` we
 * additionally apply the §A.1 contract-specific checks (factory,
 * owner, puller, consumer) to each entry of `requestContracts`. To
 * keep the §6.4.1 checks array readable, per-contract entries are
 * emitted with their `for <address>` suffix preserved by the runner.
 *
 * The whitelist book uses **per-validator** nonce state, so the runner
 * needs the Guardian's signer address to read its floor and bitmap.
 * Hosts pass it as `guardianSigner` — typically the value from
 * `GuardianAbstractions.metadata.guardianSigner`.
 *
 * Per §A.4 every rejection is 422-class. The §7.6 sentinel rejection
 * (`nonce = 2^256 − 1` ⇒ 400 bad_request) is enforced by the schema and
 * never reaches this runner.
 */
export function buildRequestWhitelistingChecks(deps: {
  policy: RequestWhitelistingPolicy;
  guardianSigner: Address;
}): CheckRunner<RequestWhitelistingBody, false> {
  const { policy, guardianSigner } = deps;

  return async (
    ctx: SigningContext,
    body: RequestWhitelistingBody,
  ): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> => {
    const checks: CheckEntry[] = [];
    const nowSec = Math.floor(ctx.now.getTime() / 1000);

    // 1. Per-contract §A.1 checks (whitelist op only). Sequential per
    //    contract: each one does its own multicall + role-events scan,
    //    and parallelising across N contracts would hammer the upstream
    //    RPC (especially the eth_getLogs windows). We bail on the first
    //    UpstreamUnavailableError so the wire-level state is consistent.
    if (body.operation === "whitelist") {
      for (const requestContract of body.requestContracts) {
        // oxlint-disable-next-line no-await-in-loop
        const r = await runA1(
          ctx,
          { chainId: body.chainId, requestContract, deadline: body.deadline },
          policy,
        );
        if (r.isErr()) {
          // runA1 may emit a ValidationFailedError (rolled-up checks)
          // OR an UpstreamUnavailableError. Validation failures
          // contribute their entries verbatim with the per-contract
          // suffix so the §6.4.1 array describes the full batch; RPC
          // failures bail immediately.
          if (r.error instanceof UpstreamUnavailableError) {
            return Result.err(r.error);
          }
          for (const entry of r.error.checks) {
            checks.push(suffixed(entry, requestContract));
          }
        } else {
          // Drop the §A.1 deadline check — it duplicates the request-
          // wide one we add below — and suffix the rest.
          for (const entry of r.value) {
            if (entry.description.startsWith("deadline within")) continue;
            checks.push(suffixed(entry, requestContract));
          }
        }
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

    // 3. Whitelist-book nonce reads (request-wide, both operations).
    const nonce = BigInt(body.nonce);
    let floor: bigint;
    let consumed: boolean;
    try {
      const [floorResult, consumedResult] = await ctx.client.multicall({
        contracts: [
          {
            address: body.whitelistBook,
            abi: whitelistBookAbi,
            functionName: "validatorNonceFloor",
            args: [guardianSigner],
          },
          {
            address: body.whitelistBook,
            abi: whitelistBookAbi,
            functionName: "isNonceConsumed",
            args: [guardianSigner, nonce],
          },
        ] as const,
        allowFailure: false,
      });
      floor = floorResult;
      consumed = consumedResult;
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

/**
 * Appends `(for <addr>)` to a §A.1 entry's description so the §A.4
 * batch result can disambiguate which request contract each entry
 * belongs to. Preserves the `passed` / `skipped` flags and reason.
 */
function suffixed(entry: CheckEntry, contract: string): CheckEntry {
  const description = `${entry.description} (for ${contract})`;
  if (entry.skipped) return { description, passed: true, skipped: true };
  if (entry.passed) return { description, passed: true, skipped: false };
  return { description, passed: false, skipped: false, reason: entry.reason ?? "failed" };
}
