import { describe, expect, it } from "vitest";

import {
  StateConflictError,
  UpstreamUnavailableError,
  ValidationFailedError,
  noopLogger,
  type SigningContext,
} from "@3flabs/guardian";

import {
  acceptedSwapPair,
  buildIntentSwapChecks,
  type IntentSwapPolicy,
  type SwapPriceOracle,
} from "../src/checks/intent-swap.js";

const USDC = "0xA0b86991c6218B36c1d19D4a2e9Eb0CE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const RANDOM = "0x1234567890abcdef1234567890abcdef12345678";

const policy: IntentSwapPolicy = {
  maxDeadlineSecondsAhead: 600,
  swapPriceToleranceBps: 5,
  acceptedSwapPairs: new Map([[1, new Set([acceptedSwapPair(USDC, WETH)])]]),
};

function ctx(now = new Date(1_700_000_000_000)): SigningContext {
  return {
    chainId: 1,
    client: {} as never,
    requestId: "rid",
    tokenId: "tid",
    now,
    signTypedData: (async () => {
      throw new Error("unreachable");
    }) as never,
    logger: noopLogger,
  };
}

describe("buildIntentSwapChecks", () => {
  const oracle: SwapPriceOracle = {
    // Reference price: 1 WETH per 2000 USDC.
    // canonical (assetA = lower address) — USDC < WETH lexically? Both
    // start with 0x..., the smaller hex-prefix wins. We compute on the
    // fly here to mirror the runner's canonicalisation.
    readReferencePriceWad: async (_c, { assetA, assetB: _b }) => {
      // assetA / assetB price in 1e18.
      // If assetA = USDC (the smaller), then 1 USDC = 1/2000 WETH.
      // We express USDC has 6 decimals and WETH 18 decimals — for a
      // simple test we just pick a clean ratio.
      // amountA(USDC, base units) / amountB(WETH, base units) at parity
      //   2_000_000 USDC base units : 1_000_000_000_000_000_000 WETH base units
      //   ratio = 2e6 / 1e18 = 2e-12 ; in WAD = 2e-12 * 1e18 = 2e6
      const lo = assetA.toLowerCase();
      if (lo === USDC.toLowerCase()) return 2_000_000n; // assetA=USDC
      return 500_000_000_000n; // assetA=WETH (1 WETH per 2000 USDC, in WAD inverse — unused here)
    },
  };

  it("passes when pair is accepted, ratio matches reference, deadline ok", async () => {
    const run = buildIntentSwapChecks({ policy, oracle });
    const r = await run(ctx(), {
      chainId: 1,
      facility: "0x0000000000000000000000000000000000000099",
      legs: [
        { intent: { id: "100" }, asset: USDC, amount: "2000000" },
        { intent: { id: "200" }, asset: WETH, amount: "1000000000000000000" },
      ],
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
  });

  it("fails with ValidationFailedError when the pair is not on the accepted list", async () => {
    const run = buildIntentSwapChecks({ policy, oracle });
    const r = await run(ctx(), {
      chainId: 1,
      facility: "0x0000000000000000000000000000000000000099",
      legs: [
        { intent: { id: "1" }, asset: USDC, amount: "1" },
        { intent: { id: "2" }, asset: RANDOM, amount: "1" },
      ],
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      // Pair check failed, price check skipped (not present), deadline ok.
      expect(r.error).not.toBeInstanceOf(StateConflictError);
    }
  });

  it("propagates UpstreamUnavailableError when the oracle throws", async () => {
    const failing: SwapPriceOracle = {
      readReferencePriceWad: async () => {
        throw new Error("rpc 503");
      },
    };
    const run = buildIntentSwapChecks({ policy, oracle: failing });
    const r = await run(ctx(), {
      chainId: 1,
      facility: "0x0000000000000000000000000000000000000099",
      legs: [
        { intent: { id: "1" }, asset: USDC, amount: "2000000" },
        { intent: { id: "2" }, asset: WETH, amount: "1000000000000000000" },
      ],
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
    }
  });

  it("yields the same outcome regardless of leg order [A,B] / [B,A]", async () => {
    const run = buildIntentSwapChecks({ policy, oracle });
    const base = {
      chainId: 1,
      facility: "0x0000000000000000000000000000000000000099",
      deadline: 1_700_000_500,
    } as const;
    const ab = await run(ctx(), {
      ...base,
      legs: [
        { intent: { id: "1" }, asset: USDC, amount: "2000000" },
        { intent: { id: "2" }, asset: WETH, amount: "1000000000000000000" },
      ],
    });
    const ba = await run(ctx(), {
      ...base,
      legs: [
        { intent: { id: "2" }, asset: WETH, amount: "1000000000000000000" },
        { intent: { id: "1" }, asset: USDC, amount: "2000000" },
      ],
    });
    expect(ab.isOk()).toBe(ba.isOk());
  });
});
