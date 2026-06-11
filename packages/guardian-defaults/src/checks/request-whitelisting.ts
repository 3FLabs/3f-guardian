import { Result } from "better-result";
import { type Address } from "viem";

import {
  type CheckEntry,
  type RequestWhitelistingBody,
  type SigningContext,
  UpstreamUnavailableError,
} from "@3flabs/guardian";

import type { AsyncCache } from "../cache/types.js";
import { whitelistBookAbi } from "../abi/whitelist-book.js";
import {
  checkDeadline,
  checkMembership,
  checkNonceWindow,
  failed,
  isDeterministicContractCallFailure,
  passed,
  rollUp,
  sanitizeErr,
  skipped,
} from "./helpers.js";
import {
  type A1OnChainData,
  type IntentRequestBindingPolicy,
  runA1,
} from "./intent-request-binding.js";
import type { CheckRunner, CheckRunnerError } from "./types.js";

/**
 * §A.4 policy. The contract-side fields mirror §A.1 because for
 * `operation = "whitelist"` Appendix A.4 says "the §A.1 checks applied
 * independently to each entry of `requestContracts`. The first three
 * checks are contract-specific; the deadline check is request-wide."
 *
 * `maxNonceAboveFloor` is a bigint to keep the on-chain nonce
 * arithmetic exact.
 *
 *  - `acceptedWhitelistBooks` — optional per-chain accepted set for the
 *    client-supplied `whitelistBook`. The book address is bound
 *    verbatim as the EIP-712 `verifyingContract`, so gating it closes
 *    more than a status-code hole: an off-policy book fails a 422-class
 *    check BEFORE any on-chain read (and before the per-contract §A.1
 *    scans). Omitted = any book is read (legacy behaviour).
 *
 *  - `maxRequestContracts` — cap on `requestContracts.length` per
 *    request (default {@link DEFAULT_MAX_REQUEST_CONTRACTS}). Each
 *    whitelist-op entry costs a multicall + block-number read + up to
 *    `ceil(eventScanMaxLookbackBlocks / eventScanBlockRange)` getLogs
 *    calls, so an unbounded batch could stall the handler for hours.
 *    Oversized batches fail a 422-class check before any RPC.
 */
export type RequestWhitelistingPolicy = IntentRequestBindingPolicy & {
  readonly maxNonceAboveFloor: bigint;
  readonly acceptedWhitelistBooks?: ReadonlyMap<number, ReadonlySet<string>>;
  readonly maxRequestContracts?: number;
};

/** Default cap on `requestContracts.length` per §A.4 request. */
export const DEFAULT_MAX_REQUEST_CONTRACTS = 50;

/**
 * §6.4.1 descriptions of the three nonce-window entries emitted by
 * `checkNonceWindow`, used to emit them as `skipped` when the book
 * itself fails a prerequisite check and its nonce state was never read.
 */
const NONCE_CHECK_DESCRIPTIONS = [
  "nonce has not been consumed by the on-chain whitelist book",
  "nonce is at or above the on-chain nonce floor",
  "nonce does not exceed floor + MAX_NONCE_ABOVE_FLOOR",
] as const;

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
 *
 * Two request-shaped guards run BEFORE any on-chain read and fail
 * 422-class: the `requestContracts` batch cap (`maxRequestContracts`,
 * default {@link DEFAULT_MAX_REQUEST_CONTRACTS} — the wire schema is
 * unbounded) and, when `acceptedWhitelistBooks` is configured, the
 * whitelist-book membership gate. A book that deterministically fails
 * the nonce reads (EOA / non-book contract) is likewise a 422 check
 * failure, not a 503.
 */
export function buildRequestWhitelistingChecks(deps: {
  policy: RequestWhitelistingPolicy;
  guardianSigner: Address;
  /**
   * Optional cache shared with the §A.1 runner. A whitelist op over
   * `requestContracts: [a, b, c]` calls {@link runA1} once per entry;
   * supplying a cache amortises repeat hits across that batch (and
   * across separate requests targeting the same contract). See
   * {@link A1Deps} for the storage contract.
   */
  cache?: AsyncCache<A1OnChainData>;
  /** Per-write TTL for cached §A.1 on-chain data. See {@link A1Deps}. */
  cacheTtlMs?: number;
}): CheckRunner<RequestWhitelistingBody, false> {
  const { policy, guardianSigner, cache, cacheTtlMs } = deps;

  const maxRequestContracts = policy.maxRequestContracts ?? DEFAULT_MAX_REQUEST_CONTRACTS;
  if (!Number.isInteger(maxRequestContracts) || maxRequestContracts < 1) {
    throw new TypeError(
      `buildRequestWhitelistingChecks: maxRequestContracts must be a positive integer, ` +
        `got ${policy.maxRequestContracts}`,
    );
  }

  return async (
    ctx: SigningContext,
    body: RequestWhitelistingBody,
  ): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> => {
    const checks: CheckEntry[] = [];
    const nowSec = Math.floor(ctx.now.getTime() / 1000);

    // 0. Batch-size cap, BEFORE any on-chain read. The wire schema has
    //    no upper bound, and each whitelist-op entry can trigger a deep
    //    sequential log scan — an unbounded batch is a DoS vector.
    if (body.requestContracts.length > maxRequestContracts) {
      const r = rollUp(
        [
          failed(
            "requestContracts batch size is within MAX_REQUEST_CONTRACTS",
            `batch of ${body.requestContracts.length} contracts exceeds the maximum of ` +
              `${maxRequestContracts}`,
          ),
        ],
        "Appendix A.4 checks failed",
      );
      return r.ok ? Result.ok(r.checks) : Result.err(r.error);
    }

    // 0b. Whitelist-book policy gate (when configured). The book is the
    //     EIP-712 verifyingContract, so an off-policy book is rejected
    //     up-front — no per-contract scan, no nonce read.
    if (policy.acceptedWhitelistBooks !== undefined) {
      const bookCheck = checkMembership({
        description: "whitelist book is on the accepted-books list",
        value: body.whitelistBook,
        accepted: policy.acceptedWhitelistBooks.get(body.chainId) ?? new Set<string>(),
        addressLike: true,
      });
      checks.push(bookCheck);
      if (!bookCheck.passed) {
        checks.push(
          checkDeadline({
            nowUnixSeconds: nowSec,
            deadline: body.deadline,
            maxSecondsAhead: policy.maxDeadlineSecondsAhead,
          }),
          ...NONCE_CHECK_DESCRIPTIONS.map((d) => skipped(d)),
        );
        const r = rollUp(checks, "Appendix A.4 checks failed");
        return r.ok ? Result.ok(r.checks) : Result.err(r.error);
      }
    }

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
          { policy, cache, cacheTtlMs },
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
      // A deterministic failure (revert / empty return data) means the
      // client-supplied book is an EOA or not a whitelist book at all —
      // a property of the request, not of the upstream. Fail the
      // 422-class check instead of reporting a 503. Transport-level
      // failures keep the 503 path.
      if (isDeterministicContractCallFailure(e, ["validatorNonceFloor", "isNonceConsumed"])) {
        ctx.logger.warn(
          { err: sanitizeErr(e), whitelistBook: body.whitelistBook },
          "A.4: whitelist-book read reverted or returned no data; treating as check failure",
        );
        checks.push(
          failed(
            "whitelist book exposes per-validator nonce state",
            `whitelist book ${body.whitelistBook} did not answer ` +
              "validatorNonceFloor/isNonceConsumed (EOA or non-book contract)",
          ),
          ...NONCE_CHECK_DESCRIPTIONS.map((d) => skipped(d)),
        );
        const r = rollUp(checks, "Appendix A.4 checks failed");
        return r.ok ? Result.ok(r.checks) : Result.err(r.error);
      }
      ctx.logger.error(
        { err: sanitizeErr(e), whitelistBook: body.whitelistBook },
        "A.4: whitelist-book read failed",
      );
      return Result.err(
        new UpstreamUnavailableError({
          message: "whitelist-book read failed upstream",
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
 *
 * The `?? "check failed"` fallback is defensive: by construction every
 * `passed:false` entry the §A.1 runner emits goes through `failed()`
 * and carries a reason, but the schema types `reason` as optional, so
 * we keep a non-empty string to satisfy the wire validator.
 */
function suffixed(entry: CheckEntry, contract: string): CheckEntry {
  const description = `${entry.description} (for ${contract})`;
  if (entry.skipped) return skipped(description);
  if (entry.passed) return passed(description);
  return failed(description, entry.reason ?? "check failed");
}
