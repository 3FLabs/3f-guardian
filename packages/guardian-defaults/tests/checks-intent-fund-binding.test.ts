import { describe, expect, it } from "vitest";

import {
  noopLogger,
  StateConflictError,
  UpstreamUnavailableError,
  ValidationFailedError,
  type SigningContext,
} from "@3flabs/guardian";

import {
  buildIntentFundBindingChecks,
  type FundContractReader,
  type IntentFundBindingPolicy,
} from "../src/checks/intent-fund-binding.js";

const FUND = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
const PM = "0x000000000000000000000000000000000000000A";

const basePolicy: IntentFundBindingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedFunds: new Map([[1, new Set([FUND.toLowerCase()])]]),
};

const okReader: FundContractReader = {
  readHasActiveOrders: async () => false,
  readHoldsRequiredRoles: async () => true,
  readPresentOnExternalRegistry: async () => true,
  readPositionManagerCollateralMatches: async () => true,
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

const baseBody = {
  chainId: 1,
  facility: "0x0000000000000000000000000000000000000099",
  intent: { id: "1" },
  fundContract: FUND,
  positionManager: PM,
  deadline: 1_700_000_500,
} as const;

describe("buildIntentFundBindingChecks", () => {
  it("passes when every check is green", async () => {
    const run = buildIntentFundBindingChecks({ policy: basePolicy, reader: okReader });
    const r = await run(ctx(), baseBody);
    expect(r.isOk()).toBe(true);
  });

  it("returns 422 (ValidationFailedError) when fund is not on policy", async () => {
    const run = buildIntentFundBindingChecks({
      policy: { ...basePolicy, acceptedFunds: new Map() },
      reader: okReader,
    });
    const r = await run(ctx(), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });

  it("returns 409 (StateConflictError) when only the fund-state check fails", async () => {
    const run = buildIntentFundBindingChecks({
      policy: basePolicy,
      reader: { ...okReader, readHasActiveOrders: async () => true },
    });
    const r = await run(ctx(), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(StateConflictError);
      // checks are present per §6.5: 422 wins when both classes fail
      // but here only state failed.
      expect((r.error as StateConflictError).checks.length).toBeGreaterThan(0);
    }
  });

  it("prefers 422 over 409 when both classes fail (per §6.6.1)", async () => {
    const run = buildIntentFundBindingChecks({
      policy: basePolicy,
      reader: {
        ...okReader,
        readHasActiveOrders: async () => true, // 409
        readHoldsRequiredRoles: async () => false, // 422
      },
    });
    const r = await run(ctx(), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      expect(r.error).not.toBeInstanceOf(StateConflictError);
    }
  });

  it("emits skipped:true when the external registry adapter returns null", async () => {
    const run = buildIntentFundBindingChecks({
      policy: basePolicy,
      reader: { ...okReader, readPresentOnExternalRegistry: async () => null },
    });
    const r = await run(ctx(), baseBody);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const reg = r.value.find((c) => c.description.includes("external registry"));
      expect(reg).toBeDefined();
      expect(reg?.skipped).toBe(true);
      expect(reg?.passed).toBe(true);
    }
  });

  it("propagates RPC failure as UpstreamUnavailableError", async () => {
    const run = buildIntentFundBindingChecks({
      policy: basePolicy,
      reader: {
        ...okReader,
        readHasActiveOrders: async () => {
          throw new Error("rpc 503");
        },
      },
    });
    const r = await run(ctx(), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });
});
