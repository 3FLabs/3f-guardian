import { describe, expect, it } from "vitest";
import { type Address } from "viem";

import {
  noopLogger,
  UpstreamUnavailableError,
  ValidationFailedError,
  type SigningContext,
} from "@3flabs/guardian";

import { buildIntentSwapChecks, type IntentSwapPolicy } from "../src/checks/intent-swap.js";

const PM_FACTORY = "0xfaC70rfaC70rfaC70rfaC70rfaC70rfaC70rfaC0" as Address;
const PM = "0x1111111111111111111111111111111111111111" as Address;
const DEBT = "0x2222222222222222222222222222222222222222" as Address;
const COLLATERAL = "0x3333333333333333333333333333333333333333" as Address;
const PM_OWNER = "0x000000000000000000000000000000000000000a" as Address;
const ROGUE_OWNER = "0x000000000000000000000000000000000000dead" as Address;
const FACILITY = "0x0000000000000000000000000000000000000099" as Address;

const policy: IntentSwapPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedPmFactories: new Map([[1, new Set<string>([PM_FACTORY])]]),
  acceptedPmOwners: new Map([[1, new Set<string>([PM_OWNER])]]),
  swapPriceToleranceBps: 1,
};

type Stub = {
  client: SigningContext["client"];
  multicalls: Array<{ functionNames: string[] }>;
};

function makeClient(responses: ReadonlyArray<readonly unknown[] | Error>): Stub {
  const stub: Stub = { client: undefined as never, multicalls: [] };
  let i = 0;
  const client = {
    multicall: async (params: { contracts: ReadonlyArray<{ functionName: string }> }) => {
      stub.multicalls.push({ functionNames: params.contracts.map((c) => c.functionName) });
      const r = responses[i++];
      if (r === undefined) throw new Error(`unexpected multicall #${i}`);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as SigningContext["client"];
  stub.client = client;
  return stub;
}

function ctx(client: SigningContext["client"], now = new Date(1_700_000_000_000)): SigningContext {
  return {
    chainId: 1,
    client,
    requestId: "rid",
    tokenId: "tid",
    now,
    signTypedData: (async () => {
      throw new Error("unreachable");
    }) as never,
    logger: noopLogger,
  };
}

const baseDeadline = 1_700_000_500;

const baseBody = {
  chainId: 1,
  facility: FACILITY,
  legs: [
    { intent: { id: "1" }, asset: PM, amount: "100" }, // PM shares
    { intent: { id: "2" }, asset: DEBT, amount: "100" }, // debt asset (will fill below)
  ],
  deadline: baseDeadline,
};

/**
 * Build a stage-2 multicall response in tuple shape:
 *   [owner, [collateral, debt], [totalAssets, totalSupply, mgmtFee, perfFee], virtualOffset]
 */
function pmReads(args: {
  owner?: Address;
  collateral?: Address;
  debt?: Address;
  totalAssets: bigint;
  totalSupply: bigint;
  mgmtFeeShares?: bigint;
  perfFeeShares?: bigint;
  virtualShareOffset?: bigint;
}): unknown[] {
  return [
    args.owner ?? PM_OWNER,
    [args.collateral ?? COLLATERAL, args.debt ?? DEBT],
    [args.totalAssets, args.totalSupply, args.mgmtFeeShares ?? 0n, args.perfFeeShares ?? 0n],
    args.virtualShareOffset ?? 1n,
  ];
}

/**
 * Build a stage-1 (factory) multicall response: |factories| × 2 entries
 * (legA first, legB second). With one factory, two booleans wrapped as
 * allowFailure: true success entries.
 */
function factoryReads(args: { aIsPm: boolean; bIsPm: boolean }): unknown[] {
  return [
    { status: "success", result: args.aIsPm },
    { status: "success", result: args.bIsPm },
  ];
}

describe("buildIntentSwapChecks", () => {
  it("passes with strict-match price (tolerance 1bp; 0 deviation)", async () => {
    // expected = pmShares * (totalAssets + 1) / (totalSupply + offset + 0 + 0)
    //          = 100 * (1000 + 1) / (1000 + 1)
    //          = 100
    const stub = makeClient([
      factoryReads({ aIsPm: true, bIsPm: false }),
      pmReads({ totalAssets: 1000n, totalSupply: 1000n, virtualShareOffset: 1n }),
    ]);
    const body = {
      ...baseBody,
      legs: [
        { intent: { id: "1" }, asset: PM, amount: "100" },
        { intent: { id: "2" }, asset: DEBT, amount: "100" }, // matches expected exactly
      ],
    };
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), body);
    expect(r.isOk()).toBe(true);
  });

  it("passes when leg order is reversed (debt first, PM second)", async () => {
    const stub = makeClient([
      factoryReads({ aIsPm: false, bIsPm: true }),
      pmReads({ totalAssets: 1000n, totalSupply: 1000n, virtualShareOffset: 1n }),
    ]);
    const body = {
      ...baseBody,
      legs: [
        { intent: { id: "1" }, asset: DEBT, amount: "100" },
        { intent: { id: "2" }, asset: PM, amount: "100" },
      ],
    };
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), body);
    expect(r.isOk()).toBe(true);
  });

  it("fails when neither leg is a position manager", async () => {
    const stub = makeClient([factoryReads({ aIsPm: false, bIsPm: false })]);
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const checks = (r.error as ValidationFailedError).checks;
      const factoryEntry = checks.find((c) => c.description.includes("position manager from"));
      expect(factoryEntry?.passed).toBe(false);
      // Owner / debt-match / price entries must be skipped.
      const skippedDescs = checks.filter((c) => c.skipped).map((c) => c.description);
      expect(skippedDescs).toContain("position manager owner is on the accepted-owners list");
      expect(skippedDescs).toContain("non-PM leg's asset equals the position manager's debt asset");
      expect(skippedDescs).toContain(
        "swap legs match the position-manager share price within tolerance",
      );
    }
  });

  it("fails when both legs are position managers", async () => {
    const stub = makeClient([factoryReads({ aIsPm: true, bIsPm: true })]);
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const factoryEntry = (r.error as ValidationFailedError).checks.find((c) =>
        c.description.includes("position manager from"),
      );
      expect(factoryEntry?.reason).toMatch(/both legs/i);
    }
  });

  it("fails when PM owner is not accepted", async () => {
    const stub = makeClient([
      factoryReads({ aIsPm: true, bIsPm: false }),
      pmReads({
        owner: ROGUE_OWNER,
        totalAssets: 1000n,
        totalSupply: 1000n,
      }),
    ]);
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      expect(
        (r.error as ValidationFailedError).checks.some(
          (c) => !c.passed && c.description.includes("position manager owner"),
        ),
      ).toBe(true);
    }
  });

  it("fails when non-PM leg's asset != PM debt asset", async () => {
    const RANDOM = "0x4444444444444444444444444444444444444444" as Address;
    const stub = makeClient([
      factoryReads({ aIsPm: true, bIsPm: false }),
      pmReads({ totalAssets: 1000n, totalSupply: 1000n }),
    ]);
    const body = {
      ...baseBody,
      legs: [
        { intent: { id: "1" }, asset: PM, amount: "100" },
        { intent: { id: "2" }, asset: RANDOM, amount: "100" }, // not the PM debt asset
      ],
    };
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), body);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      const checks = (r.error as ValidationFailedError).checks;
      expect(checks.some((c) => !c.passed && c.description.includes("non-PM leg"))).toBe(true);
      // Price check is skipped when debt-match fails.
      const priceCheck = checks.find((c) => c.description.includes("share price"));
      expect(priceCheck?.skipped).toBe(true);
    }
  });

  it("fails when actual debt deviates beyond tolerance", async () => {
    // expected = 100 * 1001 / 1001 = 100. Actual = 102 → delta 2 > tolerance 0 (1 bp of 100 = 0)
    const stub = makeClient([
      factoryReads({ aIsPm: true, bIsPm: false }),
      pmReads({ totalAssets: 1000n, totalSupply: 1000n, virtualShareOffset: 1n }),
    ]);
    const body = {
      ...baseBody,
      legs: [
        { intent: { id: "1" }, asset: PM, amount: "100" },
        { intent: { id: "2" }, asset: DEBT, amount: "102" }, // outside tolerance
      ],
    };
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), body);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(
        (r.error as ValidationFailedError).checks.some(
          (c) => !c.passed && c.description.includes("share price"),
        ),
      ).toBe(true);
    }
  });

  it("passes within tolerance (1 bp slack on a large amount)", async () => {
    // 1 bp of 1_000_000 = 100. Actual differs by 1 (fully inside tolerance).
    const stub = makeClient([
      factoryReads({ aIsPm: true, bIsPm: false }),
      pmReads({ totalAssets: 1_000_000n, totalSupply: 1_000_000n, virtualShareOffset: 1n }),
    ]);
    const body = {
      ...baseBody,
      legs: [
        { intent: { id: "1" }, asset: PM, amount: "1000000" },
        { intent: { id: "2" }, asset: DEBT, amount: "1000001" }, // 1 wei off, well within 100 wei tolerance
      ],
    };
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), body);
    expect(r.isOk()).toBe(true);
  });

  it("propagates stage-1 multicall failure as UpstreamUnavailableError", async () => {
    const stub = makeClient([new Error("rpc 503")]);
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it("propagates stage-2 multicall failure as UpstreamUnavailableError", async () => {
    const stub = makeClient([factoryReads({ aIsPm: true, bIsPm: false }), new Error("revert")]);
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it("rejects when the deadline exceeds the policy ceiling", async () => {
    const stub = makeClient([
      factoryReads({ aIsPm: true, bIsPm: false }),
      pmReads({ totalAssets: 1000n, totalSupply: 1000n }),
    ]);
    const body = { ...baseBody, deadline: baseDeadline + 10_000 };
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), body);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });

  it("passes a 1-wei deviation on a small leg (tolerance floored at 1 wei when bps > 0)", async () => {
    // expected = 100 * 1001 / 1001 = 100. 1 bp of 100 floors to 0 —
    // the 1-wei floor must absorb the documented mulDiv rounding.
    const stub = makeClient([
      factoryReads({ aIsPm: true, bIsPm: false }),
      pmReads({ totalAssets: 1000n, totalSupply: 1000n, virtualShareOffset: 1n }),
    ]);
    const body = {
      ...baseBody,
      legs: [
        { intent: { id: "1" }, asset: PM, amount: "100" },
        { intent: { id: "2" }, asset: DEBT, amount: "101" }, // 1 wei off
      ],
    };
    const r = await buildIntentSwapChecks({ policy })(ctx(stub.client), body);
    expect(r.isOk()).toBe(true);
  });

  it("applies no floor when swapPriceToleranceBps is 0 (strict equality)", async () => {
    const stub = makeClient([
      factoryReads({ aIsPm: true, bIsPm: false }),
      pmReads({ totalAssets: 1000n, totalSupply: 1000n, virtualShareOffset: 1n }),
    ]);
    const body = {
      ...baseBody,
      legs: [
        { intent: { id: "1" }, asset: PM, amount: "100" },
        { intent: { id: "2" }, asset: DEBT, amount: "101" },
      ],
    };
    const r = await buildIntentSwapChecks({ policy: { ...policy, swapPriceToleranceBps: 0 } })(
      ctx(stub.client),
      body,
    );
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });

  it("throws at construction for a fractional or negative swapPriceToleranceBps", () => {
    for (const bad of [0.5, -1, Number.NaN]) {
      expect(() =>
        buildIntentSwapChecks({ policy: { ...policy, swapPriceToleranceBps: bad } }),
      ).toThrow(TypeError);
    }
  });

  it("fails when no PM factories are configured for the chain", async () => {
    const policyEmpty: IntentSwapPolicy = { ...policy, acceptedPmFactories: new Map() };
    const stub = makeClient([]); // no multicall expected
    const r = await buildIntentSwapChecks({ policy: policyEmpty })(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      const checks = (r.error as ValidationFailedError).checks;
      const factory = checks.find((c) => c.description.includes("position manager from"));
      expect(factory?.passed).toBe(false);
      expect(factory?.reason).toMatch(/no accepted PM factories/);
    }
  });
});
