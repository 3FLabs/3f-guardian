import { describe, expect, it } from "vitest";

import {
  noopLogger,
  UpstreamUnavailableError,
  ValidationFailedError,
  type SigningContext,
} from "@3flabs/guardian";

import {
  buildIntentRequestBindingChecks,
  type IntentRequestBindingPolicy,
  type RequestContractReader,
} from "../src/checks/intent-request-binding.js";

const RC = "0xCcCccCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcC";
const OWNER = "0x000000000000000000000000000000000000000A";
const PULLER = "0x000000000000000000000000000000000000000B";
const CONSUMER = "0x000000000000000000000000000000000000000C";

const policy: IntentRequestBindingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedRequestOrigins: new Map([[1, new Set([RC.toLowerCase()])]]),
  acceptedOwners: new Map([[1, new Set([OWNER.toLowerCase()])]]),
  acceptedPullers: new Map([[1, new Set([PULLER.toLowerCase()])]]),
  acceptedConsumers: new Map([[1, new Set([CONSUMER.toLowerCase()])]]),
};

const okReader: RequestContractReader = {
  readOwner: async () => OWNER,
  readPuller: async () => PULLER,
  readConsumer: async () => CONSUMER,
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
  intent: { id: "42" },
  requestContract: RC,
  deadline: 1_700_000_500,
} as const;

describe("buildIntentRequestBindingChecks", () => {
  it("passes when every check is green", async () => {
    const run = buildIntentRequestBindingChecks({ policy, reader: okReader });
    const r = await run(ctx(), baseBody);
    expect(r.isOk()).toBe(true);
  });

  it("skips on-chain reads when the origin check fails", async () => {
    let calls = 0;
    const reader: RequestContractReader = {
      readOwner: async () => {
        calls++;
        return OWNER;
      },
      readPuller: async () => {
        calls++;
        return PULLER;
      },
      readConsumer: async () => {
        calls++;
        return CONSUMER;
      },
    };
    const run = buildIntentRequestBindingChecks({
      policy: { ...policy, acceptedRequestOrigins: new Map() },
      reader,
    });
    const r = await run(ctx(), baseBody);
    expect(calls).toBe(0);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });

  it("fails when owner is not on the accepted-owners list", async () => {
    const run = buildIntentRequestBindingChecks({
      policy,
      reader: { ...okReader, readOwner: async () => "0x000000000000000000000000000000000000DEAD" },
    });
    const r = await run(ctx(), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      expect(
        (r.error as ValidationFailedError).checks.some(
          (c) => !c.passed && c.description.includes("owner"),
        ),
      ).toBe(true);
    }
  });

  it("propagates RPC failure as UpstreamUnavailableError", async () => {
    const run = buildIntentRequestBindingChecks({
      policy,
      reader: {
        ...okReader,
        readOwner: async () => {
          throw new Error("rpc 503");
        },
      },
    });
    const r = await run(ctx(), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });
});
