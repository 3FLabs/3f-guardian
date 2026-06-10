import { Result } from "better-result";
import { type Address } from "viem";

import {
  type CheckEntry,
  type IntentSwapBody,
  type SigningContext,
  UpstreamUnavailableError,
} from "@3flabs/guardian";

import { positionManagerAbi, VIRTUAL_ASSETS } from "../abi/position-manager.js";
import { positionManagerFactoryAbi } from "../abi/position-manager-factory.js";
import { checkDeadline, checkMembership, failed, passed, rollUp, skipped } from "./helpers.js";
import type { CheckRunner, CheckRunnerError } from "./types.js";

/**
 * Per-chain accepted-set policy for §A.3.
 *
 *  - `acceptedPmFactories` — at least one accepted factory's
 *    `isPositionManager(asset)` MUST return `true` for exactly one of
 *    the two leg assets. The other leg's asset MUST be the position
 *    manager's debt asset.
 *
 *  - `acceptedPmOwners` — `Ownable.owner()` on the resolved position
 *    manager MUST be on this set.
 *
 *  - `swapPriceToleranceBps` — see {@link buildIntentSwapChecks} for
 *    the exact tolerance check. Defaults to 1 bp at the host's
 *    discretion (the package itself does not default this; the host
 *    chooses).
 */
export type IntentSwapPolicy = {
  readonly maxDeadlineSecondsAhead: number;
  readonly acceptedPmFactories: ReadonlyMap<number, ReadonlySet<string>>;
  readonly acceptedPmOwners: ReadonlyMap<number, ReadonlySet<string>>;
  readonly swapPriceToleranceBps: number;
};

/**
 * Builds the §A.3 check runner for `POST /v1/facility/intent-swaps`.
 *
 * Order of evaluation (matches §6.4.1 emission):
 *
 *   1. exactly one leg's asset is a position manager from an accepted factory  (422)
 *   2. position manager owner is on the accepted-owners list                    (422)
 *   3. non-PM leg's asset equals the position manager's debt asset              (422)
 *   4. swap legs match the position-manager share price within tolerance        (422)
 *   5. deadline within MAX_DEADLINE_SECONDS_AHEAD of now                         (422)
 *
 * Stage 1 — single multicall (`allowFailure: true`):
 *   For each (leg, factory) pair: `factory.isPositionManager(legAsset)`.
 *   `allowFailure: true` is fine here: a non-existent factory or a
 *   non-contract leg asset just yields `failure` for that slot, which
 *   the runner treats as "not a PM under that factory".
 *
 * Stage 2 — single multicall on the resolved PM (`allowFailure: false`):
 *   `pm.owner()`, `pm.assets()`, `pm.pendingFees()`, `pm.virtualShareOffset()`.
 *
 * The leg ordering is symmetric: whichever leg resolves to the PM
 * carries the share amount; the other leg carries the debt amount. The
 * pricing math mirrors `LibView.convertToShares` from grunt with
 * `VIRTUAL_ASSETS = 1n`:
 *
 *   expectedDebt = (pmShares * (totalAssets + 1)) /
 *                  (totalSupply + virtualShareOffset
 *                     + managementFeeShares + performanceFeeShares)
 *
 * The check passes iff `|actualDebt - expectedDebt| <=
 * expectedDebt * toleranceBps / 10_000`. Default tolerance of 1 bp
 * absorbs the ~1 wei mulDiv rounding the on-chain LP pathway emits.
 * Whenever a non-zero bps is configured the tolerance is floored at
 * 1 wei, so small legs (`expectedDebt * bps < 10_000`) still get the
 * documented 1-wei rounding slack instead of a zero tolerance.
 *
 * `swapPriceToleranceBps` MUST be a non-negative integer; the builder
 * throws at construction time otherwise (a fractional bps would make
 * `BigInt()` throw inside the runner on every request).
 */
export function buildIntentSwapChecks(deps: {
  policy: IntentSwapPolicy;
}): CheckRunner<IntentSwapBody, false> {
  const { policy } = deps;

  if (!Number.isInteger(policy.swapPriceToleranceBps) || policy.swapPriceToleranceBps < 0) {
    throw new TypeError(
      `buildIntentSwapChecks: swapPriceToleranceBps must be a non-negative integer, ` +
        `got ${policy.swapPriceToleranceBps}`,
    );
  }

  return async (
    ctx: SigningContext,
    body: IntentSwapBody,
  ): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> => {
    const [legA, legB] = body.legs;
    if (!legA || !legB) {
      // The schema enforces length === 2, so this is unreachable in
      // practice. Defensive only.
      return Result.err(
        new UpstreamUnavailableError({
          message: "intent-swap body did not contain two legs",
          status: 503,
        }),
      );
    }

    const acceptedFactories = policy.acceptedPmFactories.get(body.chainId) ?? new Set<string>();
    const factoriesArr = [...acceptedFactories].map((f) => f as Address);

    const nowUnix = Math.floor(ctx.now.getTime() / 1000);
    const deadlineCheck = checkDeadline({
      nowUnixSeconds: nowUnix,
      deadline: body.deadline,
      maxSecondsAhead: policy.maxDeadlineSecondsAhead,
    });

    if (factoriesArr.length === 0) {
      // Empty policy ⇒ no leg can possibly be a PM. Fail check #1 and
      // skip every on-chain entry.
      const all: CheckEntry[] = [
        failed(
          "exactly one leg's asset is a position manager from an accepted factory",
          "no accepted PM factories configured for this chain",
        ),
        skipped("position manager owner is on the accepted-owners list"),
        skipped("non-PM leg's asset equals the position manager's debt asset"),
        skipped("swap legs match the position-manager share price within tolerance"),
        deadlineCheck,
      ];
      const r = rollUp(all, "Appendix A.3 checks failed");
      return r.ok ? Result.ok(r.checks) : Result.err(r.error);
    }

    // ── Stage 1: factory.isPositionManager × 2 legs ──────────────────
    let stage1Results: ReadonlyArray<
      { status: "success"; result: boolean } | { status: "failure"; error: unknown }
    >;
    try {
      stage1Results = (await ctx.client.multicall({
        contracts: [
          ...factoriesArr.map((factory) => ({
            address: factory,
            abi: positionManagerFactoryAbi,
            functionName: "isPositionManager" as const,
            args: [legA.asset] as const,
          })),
          ...factoriesArr.map((factory) => ({
            address: factory,
            abi: positionManagerFactoryAbi,
            functionName: "isPositionManager" as const,
            args: [legB.asset] as const,
          })),
        ] as never,
        allowFailure: true,
      })) as never;
    } catch (e) {
      ctx.logger.error(
        { err: e instanceof Error ? e.message : e, legA: legA.asset, legB: legB.asset },
        "A.3: stage 1 multicall failed",
      );
      return Result.err(
        new UpstreamUnavailableError({
          message: "position-manager factory read failed upstream",
          status: 503,
        }),
      );
    }

    const aHits = stage1Results
      .slice(0, factoriesArr.length)
      .some((r) => r.status === "success" && r.result === true);
    const bHits = stage1Results
      .slice(factoriesArr.length)
      .some((r) => r.status === "success" && r.result === true);

    if (aHits === bHits) {
      // Both PMs or neither — both fail the "exactly one" check.
      const reason = aHits
        ? "both legs resolved as position managers; expected exactly one"
        : "neither leg's asset is a position manager from an accepted factory";
      const all: CheckEntry[] = [
        failed("exactly one leg's asset is a position manager from an accepted factory", reason),
        skipped("position manager owner is on the accepted-owners list"),
        skipped("non-PM leg's asset equals the position manager's debt asset"),
        skipped("swap legs match the position-manager share price within tolerance"),
        deadlineCheck,
      ];
      const r = rollUp(all, "Appendix A.3 checks failed");
      return r.ok ? Result.ok(r.checks) : Result.err(r.error);
    }

    // Resolve the PM leg + debt leg.
    const pmLeg = aHits ? legA : legB;
    const debtLeg = aHits ? legB : legA;
    const pmAsset = pmLeg.asset;
    const factoryCheck = passed(
      "exactly one leg's asset is a position manager from an accepted factory",
    );

    // ── Stage 2: PM views ────────────────────────────────────────────
    let pmOwner: Address;
    let collateralAsset: Address;
    let debtAsset: Address;
    let totalAssets_: bigint;
    let totalSupply_: bigint;
    let mgmtFeeShares: bigint;
    let perfFeeShares: bigint;
    let virtualShareOffset: bigint;
    try {
      const [ownerRes, assetsRes, feesRes, virtualRes] = await ctx.client.multicall({
        contracts: [
          { address: pmAsset, abi: positionManagerAbi, functionName: "owner" },
          { address: pmAsset, abi: positionManagerAbi, functionName: "assets" },
          { address: pmAsset, abi: positionManagerAbi, functionName: "pendingFees" },
          { address: pmAsset, abi: positionManagerAbi, functionName: "virtualShareOffset" },
        ] as const,
        allowFailure: false,
      });
      pmOwner = ownerRes;
      [collateralAsset, debtAsset] = assetsRes;
      [totalAssets_, totalSupply_, mgmtFeeShares, perfFeeShares] = feesRes;
      virtualShareOffset = virtualRes;
    } catch (e) {
      ctx.logger.error(
        { err: e instanceof Error ? e.message : e, pmAsset },
        "A.3: stage 2 PM read failed",
      );
      return Result.err(
        new UpstreamUnavailableError({
          message: "position-manager read failed upstream",
          status: 503,
        }),
      );
    }

    const ownerCheck = checkMembership({
      description: "position manager owner is on the accepted-owners list",
      value: pmOwner,
      accepted: policy.acceptedPmOwners.get(body.chainId) ?? new Set<string>(),
      addressLike: true,
    });

    // §A.3 #3: the non-PM leg's asset MUST equal the PM's debt asset.
    // Comparing against `collateralAsset` is informational only — we
    // don't accept collateral-side swaps in v1.
    const debtMatchCheck =
      debtLeg.asset.toLowerCase() === debtAsset.toLowerCase()
        ? passed("non-PM leg's asset equals the position manager's debt asset")
        : failed(
            "non-PM leg's asset equals the position manager's debt asset",
            `non-PM leg asset is ${debtLeg.asset} but PM debt asset is ${debtAsset} ` +
              `(collateral asset for reference: ${collateralAsset})`,
          );

    // §A.3 #4: price-tolerance check. Skip math when either prerequisite
    // (debt match) failed — the question is moot.
    let priceCheck: CheckEntry;
    if (!debtMatchCheck.passed) {
      priceCheck = skipped("swap legs match the position-manager share price within tolerance");
    } else {
      const pmShares = BigInt(pmLeg.amount);
      const actualDebt = BigInt(debtLeg.amount);
      const denom = totalSupply_ + virtualShareOffset + mgmtFeeShares + perfFeeShares;
      if (denom === 0n) {
        priceCheck = failed(
          "swap legs match the position-manager share price within tolerance",
          "PM share-price denominator is zero (totalSupply + virtual + fees == 0)",
        );
      } else {
        const expectedDebt = (pmShares * (totalAssets_ + VIRTUAL_ASSETS)) / denom;
        const delta =
          actualDebt > expectedDebt ? actualDebt - expectedDebt : expectedDebt - actualDebt;
        const toleranceBps = BigInt(policy.swapPriceToleranceBps);
        const proportional = (expectedDebt * toleranceBps) / 10_000n;
        // Floor at 1 wei for any non-zero bps: the bps math floors to
        // zero whenever expectedDebt * bps < 10_000, which would deny
        // small legs the documented ~1 wei mulDiv rounding slack.
        const tolerance = proportional > 0n ? proportional : toleranceBps > 0n ? 1n : 0n;
        priceCheck =
          delta <= tolerance
            ? passed("swap legs match the position-manager share price within tolerance")
            : failed(
                "swap legs match the position-manager share price within tolerance",
                `actual debt ${actualDebt} deviates from expected ${expectedDebt} ` +
                  `by ${delta} (tolerance ${tolerance}, bps=${policy.swapPriceToleranceBps})`,
              );
      }
    }

    const all: readonly CheckEntry[] = [
      factoryCheck,
      ownerCheck,
      debtMatchCheck,
      priceCheck,
      deadlineCheck,
    ];
    const r = rollUp(all, "Appendix A.3 checks failed");
    return r.ok ? Result.ok(r.checks) : Result.err(r.error);
  };
}
