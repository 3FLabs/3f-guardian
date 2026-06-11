import { describe, expect, it } from "vitest";
import {
  AbiDecodingZeroDataError,
  ContractFunctionExecutionError,
  HttpRequestError,
  type Address,
  zeroAddress,
} from "viem";

import {
  noopLogger,
  StateConflictError,
  UpstreamUnavailableError,
  ValidationFailedError,
  type SigningContext,
} from "@3flabs/guardian";

import { facilityAbi, fundAbi } from "../src/abi/index.js";
import {
  buildIntentFundBindingChecks,
  type IntentFundBindingPolicy,
} from "../src/checks/intent-fund-binding.js";

const FUND = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
const PM = "0x000000000000000000000000000000000000000a" as Address;
const FACILITY = "0x0000000000000000000000000000000000000099" as Address;
const FUND_OWNER = "0x000000000000000000000000000000000000beef" as Address;
const ROGUE_OWNER = "0x00000000000000000000000000000000deadbeef" as Address;
const SOME_FUND = "0x00000000000000000000000000000000cccccccc" as Address;

const basePolicy: IntentFundBindingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedFunds: new Map([[1, new Set<string>([FUND])]]),
  acceptedOwners: new Map([[1, new Set<string>([FUND_OWNER])]]),
};

const baseBody = {
  chainId: 1,
  facility: FACILITY,
  intent: { id: "1" },
  fundContract: FUND,
  positionManager: PM,
  deadline: 1_700_000_500,
} as const;

/**
 * Shape returned by `IFacility.getIntent(uint256)`:
 *   [properties, fund, request, resolved]
 */
function getIntentResult(args: {
  fund: Address;
  request?: Address;
  resolved?: boolean;
  depositAsset?: { asset: Address; isPositionManager: boolean };
  targetAsset?: { asset: Address; isPositionManager: boolean };
}): readonly [unknown, Address, Address, boolean] {
  const properties = {
    depositAsset: args.depositAsset ?? { asset: zeroAddress as Address, isPositionManager: false },
    // Default mirrors the body fixture: the intent's PM-flagged asset
    // IS the proposed `positionManager`, so the §A.2 PM-match check
    // passes unless a test overrides it.
    targetAsset: args.targetAsset ?? { asset: PM, isPositionManager: true },
    depositCap: 0n,
    guardKey: zeroAddress as Address,
    resolveStart: 0,
    quorum: 1,
    transferableIntent: false,
  };
  return [properties, args.fund, args.request ?? (zeroAddress as Address), args.resolved ?? false];
}

type MulticallSpy = {
  client: SigningContext["client"];
  /** Each entry corresponds to a multicall round-trip. */
  calls: Array<{ contracts: ReadonlyArray<{ functionName: string; address: string }> }>;
};

/**
 * Stub `client.multicall` with a queue of responses keyed by stage. Throw
 * results simulate RPC failure / contract revert with `allowFailure: false`.
 */
function makeClient(responses: ReadonlyArray<readonly unknown[] | Error>): MulticallSpy {
  const calls: MulticallSpy["calls"] = [];
  let i = 0;
  const client = {
    multicall: async (params: {
      contracts: ReadonlyArray<{ functionName: string; address: string }>;
      allowFailure: boolean;
    }) => {
      calls.push({ contracts: params.contracts });
      const r = responses[i++];
      if (r === undefined) {
        throw new Error(`unexpected multicall #${i}; no fixture configured`);
      }
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as SigningContext["client"];
  return { client, calls };
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

describe("buildIntentFundBindingChecks", () => {
  it("passes when every check is green and the intent has no current fund", async () => {
    const stage1 = [FUND_OWNER, getIntentResult({ fund: zeroAddress as Address })];
    const { client, calls } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.contracts.map((c) => c.functionName)).toEqual(["owner", "getIntent"]);
  });

  it("returns 422 (ValidationFailedError) when the fund is not on policy", async () => {
    // No on-chain reads should fire — every on-chain entry must be skipped.
    const { client, calls } = makeClient([]);
    const run = buildIntentFundBindingChecks({
      policy: { ...basePolicy, acceptedFunds: new Map() },
    });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const checks = (r.error as ValidationFailedError).checks;
      expect(checks.filter((c) => c.skipped === true).map((c) => c.description)).toEqual([
        "fund contract owner is on the accepted-owners list",
        "proposed position manager matches the intent's position-manager asset",
        "intent has no currently bound fund",
        "fund holds DEPOSITOR_ROLE for the facility",
      ]);
    }
    expect(calls).toHaveLength(0);
  });

  it("returns 422 when the fund's owner is not accepted", async () => {
    const stage1 = [
      ROGUE_OWNER, // owner() — not on accepted-owners
      getIntentResult({ fund: zeroAddress as Address }),
    ];
    const { client } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });

  it("returns 422 when the proposed position manager is not the intent's PM-flagged asset", async () => {
    const stage1 = [
      FUND_OWNER,
      getIntentResult({
        fund: zeroAddress as Address,
        targetAsset: { asset: SOME_FUND, isPositionManager: true }, // ≠ baseBody.positionManager
      }),
    ];
    const { client } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const pm = (r.error as ValidationFailedError).checks.find((c) =>
        c.description.includes("position-manager asset"),
      );
      expect(pm?.passed).toBe(false);
      expect(pm?.reason).toContain(SOME_FUND);
    }
  });

  it("accepts the position manager when it matches the deposit-asset side", async () => {
    const stage1 = [
      FUND_OWNER,
      getIntentResult({
        fund: zeroAddress as Address,
        depositAsset: { asset: PM, isPositionManager: true },
        targetAsset: { asset: SOME_FUND, isPositionManager: false },
      }),
    ];
    const { client } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isOk()).toBe(true);
  });

  it("returns 422 when the intent declares no position-manager asset at all", async () => {
    const stage1 = [
      FUND_OWNER,
      getIntentResult({
        fund: zeroAddress as Address,
        targetAsset: { asset: SOME_FUND, isPositionManager: false },
      }),
    ];
    const { client } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const pm = (r.error as ValidationFailedError).checks.find((c) =>
        c.description.includes("position-manager asset"),
      );
      expect(pm?.reason).toMatch(/declares no position-manager asset/);
    }
  });

  it("returns 409 (StateConflictError) when only the current-fund check fails", async () => {
    const stage1 = [FUND_OWNER, getIntentResult({ fund: SOME_FUND })];
    const { client } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(StateConflictError);
      expect((r.error as StateConflictError).checks.length).toBeGreaterThan(0);
    }
  });

  it("prefers 422 over 409 when both classes fail (per §6.6.1)", async () => {
    const stage1 = [
      ROGUE_OWNER, // 422: owner not accepted
      getIntentResult({ fund: SOME_FUND }), // 409: current fund bound
    ];
    const { client } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      expect(r.error).not.toBeInstanceOf(StateConflictError);
    }
  });

  it("emits depositor-role as skipped", async () => {
    const stage1 = [FUND_OWNER, getIntentResult({ fund: zeroAddress as Address })];
    const { client } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const dep = r.value.find((c) => c.description.includes("DEPOSITOR_ROLE"));
      expect(dep).toBeDefined();
      expect(dep?.skipped).toBe(true);
      expect(dep?.passed).toBe(true);
    }
  });

  it("propagates RPC failure as UpstreamUnavailableError", async () => {
    const { client } = makeClient([new Error("rpc 503")]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it("treats a deterministic owner() decode failure (EOA fund contract) as a 422 check failure, not a 503", async () => {
    const eoaError = new ContractFunctionExecutionError(new AbiDecodingZeroDataError(), {
      abi: fundAbi,
      functionName: "owner",
      contractAddress: FUND,
    });
    const { client, calls } = makeClient([eoaError]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const checks = (r.error as ValidationFailedError).checks;
      const owner = checks.find((c) => c.description.includes("accepted-owners"));
      expect(owner?.passed).toBe(false);
      expect(owner?.reason).toMatch(/did not answer owner\(\)/);
      // Downstream on-chain entries are unknowable — emitted as skipped.
      expect(checks.filter((c) => c.skipped === true).map((c) => c.description)).toEqual([
        "proposed position manager matches the intent's position-manager asset",
        "intent has no currently bound fund",
        "fund holds DEPOSITOR_ROLE for the facility",
      ]);
    }
    expect(calls).toHaveLength(1);
  });

  it("treats a deterministic getIntent() decode failure (EOA facility) as a 422 check failure, not a 503", async () => {
    const eoaError = new ContractFunctionExecutionError(new AbiDecodingZeroDataError(), {
      abi: facilityAbi,
      functionName: "getIntent",
      args: [1n],
      contractAddress: FACILITY,
    });
    const { client } = makeClient([eoaError]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      expect(r.error).not.toBeInstanceOf(StateConflictError);
      const owner = (r.error as ValidationFailedError).checks.find((c) =>
        c.description.includes("accepted-owners"),
      );
      expect(owner?.passed).toBe(false);
      expect(owner?.reason).toMatch(/did not answer getIntent/);
    }
  });

  it("keeps 503 for a transport-level multicall failure without leaking the upstream error text", async () => {
    const transportError = new ContractFunctionExecutionError(
      new HttpRequestError({ url: "http://internal-rpc.example:8545" }),
      { abi: fundAbi, functionName: "owner", contractAddress: FUND },
    );
    const { client } = makeClient([transportError]);
    const run = buildIntentFundBindingChecks({ policy: basePolicy });
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
      const message = (r.error as UpstreamUnavailableError).message;
      expect(message).toBe("fund-binding read failed upstream");
      expect(message).not.toContain("internal-rpc.example");
      expect(message).not.toContain(transportError.message);
    }
  });

  it("rejects when the deadline exceeds the policy ceiling", async () => {
    const stage1 = [FUND_OWNER, getIntentResult({ fund: zeroAddress as Address })];
    const { client } = makeClient([stage1]);
    const run = buildIntentFundBindingChecks({
      policy: { ...basePolicy, maxDeadlineSecondsAhead: 60 }, // 60s window
    });
    // baseBody.deadline is 1_700_000_500; ctx() now is 1_700_000_000s → 500s ahead.
    const r = await run(ctx(client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });
});
