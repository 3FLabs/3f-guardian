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
    description = "deadline within MAX_DEADLINE_SECONDS_AHEAD of now",
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
  const tolerance = (referencePriceWad * BigInt(toleranceBps)) / 10_000n;
  if (delta <= tolerance) return passed(description);
  return failed(
    description,
    `observed ratio ${observed} deviates from reference ${referencePriceWad} ` +
      `by ${delta} (tolerance=${tolerance}, bps=${toleranceBps})`,
  );
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
    nonce > floor
      ? passed("nonce is strictly greater than the on-chain nonce floor")
      : failed(
          "nonce is strictly greater than the on-chain nonce floor",
          `nonce ${nonce} is not above floor ${floor}`,
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
