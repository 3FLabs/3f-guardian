import { describe, expect, it } from "vitest";

import { noopLogger, ValidationFailedError, type SigningContext } from "@3flabs/guardian";

import {
  buildRequestWhitelistingChecks,
  type RequestWhitelistingPolicy,
  type WhitelistBookReader,
} from "../src/checks/request-whitelisting.js";
import type { RequestContractReader } from "../src/checks/intent-request-binding.js";

const RC1 = "0x1111111111111111111111111111111111111111";
const RC2 = "0x2222222222222222222222222222222222222222";
const OWNER = "0x000000000000000000000000000000000000000A";
const PULLER = "0x000000000000000000000000000000000000000B";
const CONSUMER = "0x000000000000000000000000000000000000000C";
const BOOK = "0x000000000000000000000000000000000000B00B";

const policy: RequestWhitelistingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedRequestOrigins: new Map([[1, new Set([RC1.toLowerCase(), RC2.toLowerCase()])]]),
  acceptedOwners: new Map([[1, new Set([OWNER.toLowerCase()])]]),
  acceptedPullers: new Map([[1, new Set([PULLER.toLowerCase()])]]),
  acceptedConsumers: new Map([[1, new Set([CONSUMER.toLowerCase()])]]),
  maxNonceAboveFloor: 1000n,
};

const requestReader: RequestContractReader = {
  readOwner: async () => OWNER,
  readPuller: async () => PULLER,
  readConsumer: async () => CONSUMER,
};

const bookReaderFactory = (floor: bigint, consumed: boolean): WhitelistBookReader => ({
  readNonceFloor: async () => floor,
  readNonceConsumed: async () => consumed,
});

function ctx(): SigningContext {
  return {
    chainId: 1,
    client: {} as never,
    requestId: "rid",
    tokenId: "tid",
    now: new Date(1_700_000_000_000),
    signTypedData: (async () => {
      throw new Error("unreachable");
    }) as never,
    logger: noopLogger,
  };
}

describe("buildRequestWhitelistingChecks — operation:whitelist", () => {
  it("passes for valid batch with fresh in-window nonce", async () => {
    const run = buildRequestWhitelistingChecks({
      policy,
      requestReader,
      bookReader: bookReaderFactory(50n, false),
    });
    const r = await run(ctx(), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1, RC2],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
  });

  it("emits per-contract checks (one set per requestContract)", async () => {
    const run = buildRequestWhitelistingChecks({
      policy,
      requestReader,
      bookReader: bookReaderFactory(50n, false),
    });
    const r = await run(ctx(), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1, RC2],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      // RC1 + RC2 each get 4 contract-side entries (origin/owner/puller/consumer).
      const rc1Entries = r.value.filter((c) => c.description.includes(`(for ${RC1})`));
      const rc2Entries = r.value.filter((c) => c.description.includes(`(for ${RC2})`));
      expect(rc1Entries.length).toBe(4);
      expect(rc2Entries.length).toBe(4);
    }
  });

  it("rejects when a request contract is off policy", async () => {
    const run = buildRequestWhitelistingChecks({
      policy,
      requestReader,
      bookReader: bookReaderFactory(50n, false),
    });
    const r = await run(ctx(), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1, "0xdead000000000000000000000000000000000000"],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });
});

describe("buildRequestWhitelistingChecks — operation:unwhitelist", () => {
  it("skips per-contract checks; only deadline + nonce apply", async () => {
    const run = buildRequestWhitelistingChecks({
      policy,
      requestReader: {
        // Reader MUST NOT be called in unwhitelist mode — fail loud if it is.
        readOwner: async () => {
          throw new Error("unreachable: unwhitelist should not read contract roles");
        },
        readPuller: async () => {
          throw new Error("unreachable");
        },
        readConsumer: async () => {
          throw new Error("unreachable");
        },
      },
      bookReader: bookReaderFactory(50n, false),
    });
    const r = await run(ctx(), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1, RC2],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
  });
});

describe("buildRequestWhitelistingChecks — nonce window", () => {
  it("rejects an already-consumed nonce as 422", async () => {
    const run = buildRequestWhitelistingChecks({
      policy,
      requestReader,
      bookReader: bookReaderFactory(50n, true),
    });
    const r = await run(ctx(), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });

  it("rejects a nonce <= floor", async () => {
    const run = buildRequestWhitelistingChecks({
      policy,
      requestReader,
      bookReader: bookReaderFactory(100n, false),
    });
    const r = await run(ctx(), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
  });

  it("rejects a nonce above floor + maxAboveFloor", async () => {
    const run = buildRequestWhitelistingChecks({
      policy,
      requestReader,
      bookReader: bookReaderFactory(50n, false),
    });
    const r = await run(ctx(), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: String(50n + 1001n), // policy.maxNonceAboveFloor = 1000n
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
  });
});
