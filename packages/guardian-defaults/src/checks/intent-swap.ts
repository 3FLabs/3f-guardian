import { Result } from "better-result";

import { type IntentSwapBody, UpstreamUnavailableError } from "@3flabs/guardian";
import type { CheckEntry, SigningContext } from "@3flabs/guardian";

import { checkDeadline, checkMembership, checkSwapPriceTolerance, rollUp } from "./helpers.js";
import type { CheckRunner, CheckRunnerError } from "./types.js";

/**
 * Per-chain accepted-pairs policy. Each entry is an UNORDERED pair of
 * asset addresses; the runner canonicalises by sorting hex-lowercase
 * before lookup so `(USDC, WETH)` and `(WETH, USDC)` collide.
 *
 * `swapPriceToleranceBps` defaults to 5 per §11.
 */
export type IntentSwapPolicy = {
  readonly maxDeadlineSecondsAhead: number;
  readonly swapPriceToleranceBps: number;
  /**
   * Accepted unordered pairs per chain. Encode each pair as
   * `${assetA}|${assetB}` with `assetA < assetB` (lexicographic, lower-
   * case). `acceptedSwapPair` builds this key for you.
   */
  readonly acceptedSwapPairs: ReadonlyMap<number, ReadonlySet<string>>;
};

/**
 * Adapter port for the per-pair reference price.
 *
 * The reference price MUST be expressed in 1e18 fixed-point (WAD) as
 * `amountA / amountB`, where `(assetA, assetB)` is the canonical
 * ordering — `assetA` is the lexicographically-smaller (lower-case)
 * address. The check helper uses the same ordering so callers don't
 * have to reason about leg-order swaps.
 *
 * Hosts implementing against an oracle adapter (Chainlink, Pyth) MUST
 * convert decimals into 1e18 before returning.
 */
export type SwapPriceOracle = {
  readonly readReferencePriceWad: (
    ctx: SigningContext,
    pair: { assetA: string; assetB: string },
  ) => Promise<bigint>;
};

/** Canonicalise an unordered asset pair for `acceptedSwapPairs` lookups. */
export function acceptedSwapPair(a: string, b: string): string {
  const [lo, hi] = canonicalisePair(a, b);
  return `${lo}|${hi}`;
}

function canonicalisePair(a: string, b: string): [string, string] {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al <= bl ? [al, bl] : [bl, al];
}

/**
 * Builds the §A.3 check runner for `POST /v1/facility/intent-swaps`.
 *
 *   1. unordered pair on accepted-pairs (no RPC)
 *   2. ratio of leg amounts within `swapPriceToleranceBps` of the
 *      oracle reference price (1 RPC, skipped if pair check fails)
 *   3. deadline ≤ `maxDeadlineSecondsAhead` (no RPC)
 *
 * The runner canonicalises leg order before the price comparison so
 * `[A, B]` and `[B, A]` produce the same checks output. Hosts MUST
 * also normalise legs before signing so the §7.5 byte-identity
 * invariant holds.
 */
export function buildIntentSwapChecks(deps: {
  policy: IntentSwapPolicy;
  oracle: SwapPriceOracle;
}): CheckRunner<IntentSwapBody, false> {
  const { policy, oracle } = deps;

  return async (ctx, body): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> => {
    const checks: CheckEntry[] = [];
    const [legA, legB] = body.legs;
    if (!legA || !legB) {
      // The schema already enforces length === 2, so this is unreachable
      // in practice, but guards against direct programmatic use.
      return Result.ok(checks);
    }

    const [loAsset, hiAsset] = canonicalisePair(legA.asset, legB.asset);
    const acceptedPairs = policy.acceptedSwapPairs.get(body.chainId) ?? new Set<string>();

    const pairCheck = checkMembership({
      description: "the unordered pair of leg assets is on the accepted-pairs list",
      value: `${loAsset}|${hiAsset}`,
      accepted: acceptedPairs,
      addressLike: false,
      reasonOnFail: (v) => `pair ${v} not in accepted-pairs policy`,
    });
    checks.push(pairCheck);

    if (pairCheck.passed) {
      let referencePriceWad: bigint;
      try {
        referencePriceWad = await oracle.readReferencePriceWad(ctx, {
          assetA: loAsset,
          assetB: hiAsset,
        });
      } catch (e) {
        ctx.logger.error(
          { err: e instanceof Error ? e.message : e, pair: `${loAsset}|${hiAsset}` },
          "A.3: oracle read failed",
        );
        return Result.err(
          new UpstreamUnavailableError({
            message: `swap-price oracle read failed: ${e instanceof Error ? e.message : "unknown"}`,
            status: 503,
          }),
        );
      }
      // amountA refers to the canonical-low asset's leg. Find which leg
      // matches loAsset and pass amounts in canonical order.
      const aIsLo = legA.asset.toLowerCase() === loAsset;
      const amountA = BigInt(aIsLo ? legA.amount : legB.amount);
      const amountB = BigInt(aIsLo ? legB.amount : legA.amount);
      checks.push(
        checkSwapPriceTolerance({
          amountA,
          amountB,
          referencePriceWad,
          toleranceBps: policy.swapPriceToleranceBps,
        }),
      );
    }

    checks.push(
      checkDeadline({
        nowUnixSeconds: Math.floor(ctx.now.getTime() / 1000),
        deadline: body.deadline,
        maxSecondsAhead: policy.maxDeadlineSecondsAhead,
      }),
    );

    const r = rollUp(checks, "Appendix A.3 checks failed");
    return r.ok ? Result.ok(r.checks) : Result.err(r.error);
  };
}
