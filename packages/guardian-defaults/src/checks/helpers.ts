import {
  AbiDecodingZeroDataError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from "viem";

import { type CheckEntry, failed, passed, skipped, ValidationFailedError } from "@3flabs/guardian";

/**
 * Rolls up a list of check entries into a `Result<checks, ValidationFailedError>`.
 *
 * - All passed (or skipped, which the spec equates to passed): `Ok(checks)`.
 * - Any `passed:false`: `Err(ValidationFailedError({ message, checks }))`.
 *
 * 409-class checks (currently only A.2 fund-state) MUST be evaluated
 * separately — they map to `StateConflictError`, not
 * `ValidationFailedError`, and the spec is explicit (§6.6.1 / Appendix
 * A) that 422 wins when both classes fail in the same request. Use
 * `partitionByClass` for the A.2 orchestrator.
 */
export function rollUp(
  checks: readonly CheckEntry[],
  message = "One or more policy checks failed",
): { ok: true; checks: readonly CheckEntry[] } | { ok: false; error: ValidationFailedError } {
  const anyFailed = checks.some((c) => !c.passed);
  if (!anyFailed) return { ok: true, checks };
  return {
    ok: false,
    error: new ValidationFailedError({ message, checks: [...checks] }),
  };
}

/** Re-export the §6.4.1 entry constructors so consumers don't double-import. */
export { passed, skipped, failed };

/**
 * Classifies an error thrown by a viem `multicall({ allowFailure:
 * false })` (or `readContract`): returns `true` iff one of the named
 * functions failed DETERMINISTICALLY — the call reverted or returned no
 * data (the target is an EOA or an unrelated contract). Such failures
 * are a property of the inputs, not of the upstream's health, so the
 * caller should map them to a 422-class check failure instead of a 503.
 *
 * Transport-level failures never match: an RPC outage / timeout
 * surfaces as a `ContractFunctionExecutionError` for the multicall's
 * own `aggregate3` call (or as a bare `HttpRequestError`), whose
 * `functionName` is not in `functionNames` and whose cause chain
 * carries no revert / zero-data marker.
 */
export function isDeterministicContractCallFailure(
  e: unknown,
  functionNames: readonly string[],
): boolean {
  if (!(e instanceof ContractFunctionExecutionError)) return false;
  if (!functionNames.includes(e.functionName)) return false;
  return (
    e.walk(
      (cause) =>
        cause instanceof AbiDecodingZeroDataError ||
        cause instanceof ContractFunctionZeroDataError ||
        cause instanceof ContractFunctionRevertedError,
    ) !== null
  );
}

/**
 * Classifies a failed `multicall({ allowFailure: true })` slot as a
 * CHUNK-level failure: the aggregate3 call itself failed (transport
 * outage, timeout, or the multicall contract reverting), so every slot
 * in the chunk carries the same error. viem wraps slot-local
 * decode/revert failures with the slot's own `functionName` (`owner`,
 * `isRequest`, …) via `getContractError`, and chunk-level failures with
 * `functionName: "aggregate3"`, so keying on the name is exact. Use it
 * to route logging: a chunk failure is upstream health, never an
 * operator-configuration or client-input problem.
 */
export function isMulticallChunkFailure(e: unknown): boolean {
  return e instanceof ContractFunctionExecutionError && e.functionName === "aggregate3";
}

/**
 * Normalise an unknown thrown value into a log-safe message with
 * absolute URLs redacted. viem's transport errors (`HttpRequestError`
 * and everything that wraps it) embed the RPC URL in their message,
 * and hosted-provider URLs routinely carry the API key in the path or
 * query (`https://mainnet.example.com/v2/<key>`). These messages are
 * only ever logged server-side, but log pipelines are shipped and
 * retained broadly enough that provider keys don't belong in them.
 */
export function sanitizeErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"')\]]+/gi, "[redacted-url]");
}

/**
 * §A.* set-membership predicate. Compares case-insensitively for
 * EVM addresses and case-sensitively for everything else.
 *
 *  - `description` is shown in the §6.4.1 `checks` array verbatim.
 *  - `value` is the candidate; `accepted` is the policy set.
 *  - `addressLike` triggers `.toLowerCase()` on both sides before the
 *    comparison, so `0xAbC…` and `0xabc…` match.
 */
export function checkMembership(args: {
  description: string;
  value: string;
  accepted: ReadonlySet<string>;
  addressLike?: boolean;
  reasonOnFail?: (value: string) => string;
}): CheckEntry {
  const { description, value, accepted, addressLike, reasonOnFail } = args;
  const norm = (s: string) => (addressLike ? s.toLowerCase() : s);
  const normalised = new Set([...accepted].map(norm));
  if (normalised.has(norm(value))) return passed(description);
  return failed(
    description,
    reasonOnFail ? reasonOnFail(value) : `value not on accepted list: ${value}`,
  );
}

/**
 * Default description emitted by {@link checkDeadline}. Exported so
 * composing runners (the §A.4 batch) can identify — and dedup — a
 * nested runner's deadline entry by exact match instead of a fragile
 * prefix test.
 */
export const DEADLINE_CHECK_DESCRIPTION = "deadline within MAX_DEADLINE_SECONDS_AHEAD of now";

/**
 * §A.* deadline check (§7.7).
 *
 * Returns failed iff `deadline > now + maxSecondsAhead`. The spec only
 * caps how far in the FUTURE the deadline may sit; deadlines already in
 * the past are not rejected by this check (they fail elsewhere — the
 * on-chain verifier rejects attestations with elapsed deadlines).
 */
export function checkDeadline(args: {
  description?: string;
  nowUnixSeconds: number;
  deadline: number;
  maxSecondsAhead: number;
}): CheckEntry {
  const {
    description = DEADLINE_CHECK_DESCRIPTION,
    nowUnixSeconds,
    deadline,
    maxSecondsAhead,
  } = args;
  const ceiling = nowUnixSeconds + maxSecondsAhead;
  if (deadline <= ceiling) return passed(description);
  return failed(
    description,
    `deadline ${deadline} exceeds ceiling ${ceiling} ` +
      `(now=${nowUnixSeconds}, max-ahead=${maxSecondsAhead})`,
  );
}

/**
 * §A.3 swap price tolerance.
 *
 * Compares the ratio `amountA / amountB` against `referencePrice` and
 * rejects if the deviation exceeds `toleranceBps` basis points
 * (1 bp = 0.01 %).
 *
 * Uses 18-decimal fixed-point arithmetic on bigints to avoid floating-
 * point drift. Inputs are passed as bigints so callers can derive them
 * from the wire's `zUintString` without precision loss.
 *
 *   abs((amountA * 1e18 / amountB) - referencePriceWad) * 10000
 *     <= referencePriceWad * toleranceBps
 *
 * `referencePriceWad` MUST be expressed in the same `1e18` scale so
 * both sides of the comparison live in the same fixed-point universe.
 */
export function checkSwapPriceTolerance(args: {
  description?: string;
  amountA: bigint;
  amountB: bigint;
  referencePriceWad: bigint;
  toleranceBps: number;
}): CheckEntry {
  const {
    description = "swap leg ratio within SWAP_PRICE_TOLERANCE_BPS of reference",
    amountA,
    amountB,
    referencePriceWad,
    toleranceBps,
  } = args;
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0) {
    // BigInt() below would throw on a fractional bps, violating the
    // never-throw contract of check evaluation — fail closed instead.
    return failed(description, `toleranceBps must be a non-negative integer, got ${toleranceBps}`);
  }
  if (amountB === 0n) {
    return failed(description, "leg-B amount is zero; price ratio undefined");
  }
  if (referencePriceWad <= 0n) {
    return failed(description, "reference price must be positive");
  }
  const WAD = 10n ** 18n;
  const observed = (amountA * WAD) / amountB;
  const delta =
    observed > referencePriceWad ? observed - referencePriceWad : referencePriceWad - observed;
  const tolerance = bpsToleranceWithWeiFloor(referencePriceWad, BigInt(toleranceBps));
  if (delta <= tolerance) return passed(description);
  return failed(
    description,
    `observed ratio ${observed} deviates from reference ${referencePriceWad} ` +
      `by ${delta} (tolerance=${tolerance}, bps=${toleranceBps})`,
  );
}

/**
 * Absolute tolerance for a bps-of-expected comparison, floored at 1 wei
 * for any non-zero bps: the proportional math floors to zero whenever
 * `expected * bps < 10_000`, which would deny small values the
 * documented ~1 wei mulDiv rounding slack. Shared by
 * {@link checkSwapPriceTolerance} and the §A.3 runner so the two
 * security-relevant fixed-point paths cannot diverge.
 */
export function bpsToleranceWithWeiFloor(expected: bigint, toleranceBps: bigint): bigint {
  const proportional = (expected * toleranceBps) / 10_000n;
  return proportional > 0n ? proportional : toleranceBps > 0n ? 1n : 0n;
}

/**
 * §A.4 nonce window.
 *
 * Returns three independent CheckEntries (consumed / floor / ceiling)
 * matching the appendix wording. All three are 422-class and live in
 * the same checks array; the rollUp helper turns the combined result
 * into a single ValidationFailedError envelope.
 *
 * The sentinel `2^256 − 1` rejection is the route's job (it's caught by
 * the body schema's `zUintStringBelowMax`), not this check's, per the
 * gist's "Responses" remark on §7.6.
 */
export function checkNonceWindow(args: {
  nonce: bigint;
  consumed: boolean;
  floor: bigint;
  maxAboveFloor: bigint;
}): readonly CheckEntry[] {
  const { nonce, consumed, floor, maxAboveFloor } = args;
  return [
    consumed
      ? failed(
          "nonce has not been consumed by the on-chain whitelist book",
          `nonce ${nonce} already consumed; submit a different nonce`,
        )
      : passed("nonce has not been consumed by the on-chain whitelist book"),
    nonce >= floor
      ? passed("nonce is at or above the on-chain nonce floor")
      : failed(
          "nonce is at or above the on-chain nonce floor",
          `nonce ${nonce} is below floor ${floor}`,
        ),
    nonce <= floor + maxAboveFloor
      ? passed("nonce does not exceed floor + MAX_NONCE_ABOVE_FLOOR")
      : failed(
          "nonce does not exceed floor + MAX_NONCE_ABOVE_FLOOR",
          `nonce ${nonce} exceeds ceiling ${floor + maxAboveFloor} ` +
            `(floor=${floor}, max-above=${maxAboveFloor})`,
        ),
  ];
}
