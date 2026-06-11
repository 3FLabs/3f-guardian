import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionZeroDataError, type Address } from "viem";

import {
  noopLogger,
  UpstreamUnavailableError,
  ValidationFailedError,
  type SigningContext,
} from "@3flabs/guardian";

import { inMemoryCache } from "../src/cache/in-memory.js";
import { whitelistBookAbi } from "../src/abi/whitelist-book.js";
import { zA1OnChainData } from "../src/checks/intent-request-binding.js";
import {
  buildRequestWhitelistingChecks,
  DEFAULT_MAX_REQUEST_CONTRACTS,
  type RequestWhitelistingPolicy,
} from "../src/checks/request-whitelisting.js";

const FACTORY = "0xfaC70ffaC70ffaC70ffaC70ffaC70ffaC70ffaC0" as Address;
const RC1 = "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1" as Address;
const RC2 = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" as Address;
const OWNER = "0x000000000000000000000000000000000000000a" as Address;
const PULLER = "0x000000000000000000000000000000000000000b" as Address;
const CONSUMER = "0x000000000000000000000000000000000000000c" as Address;
const ROGUE = "0x00000000000000000000000000000000ffffffff" as Address;
const BOOK = "0xb00cb00cb00cb00cb00cb00cb00cb00cb00cb00c" as Address;
const GUARDIAN = "0x9999999999999999999999999999999999999999" as Address;

const ROLE_PULLER = 1n;
const ROLE_CONSUMER = 2n;

const policy: RequestWhitelistingPolicy = {
  maxDeadlineSecondsAhead: 600,
  maxNonceAboveFloor: 1_000n,
  acceptedRequestFactories: new Map([[1, new Set<string>([FACTORY])]]),
  acceptedOwners: new Map([[1, new Set<string>([OWNER])]]),
  acceptedPullers: new Map([[1, new Set<string>([PULLER])]]),
  acceptedConsumers: new Map([[1, new Set<string>([CONSUMER])]]),
  eventScanBlockRange: 1_000n,
  eventScanMaxLookbackBlocks: 5_000n,
};

type Stub = {
  client: SigningContext["client"];
  multicalls: Array<{ functionNames: string[]; addresses: string[] }>;
  getLogsCalls: number;
  getBlockNumberCalls: number;
};

function makeClient(args: {
  multicallResponses?: ReadonlyArray<readonly unknown[] | Error>;
  latestBlock?: bigint;
  getLogs?: (params: {
    address?: readonly Address[];
    fromBlock?: bigint;
    toBlock?: bigint;
  }) => Array<{
    address: Address;
    eventName: "RolesUpdated" | "RequestCreated";
    blockNumber: bigint;
    logIndex: number;
    args: { user?: Address; roles?: bigint; request?: Address };
  }>;
}): Stub {
  const stub: Stub = {
    client: undefined as never,
    multicalls: [],
    getLogsCalls: 0,
    getBlockNumberCalls: 0,
  };
  let i = 0;
  const responses = args.multicallResponses ?? [];
  const client = {
    multicall: async (params: {
      contracts: ReadonlyArray<{ functionName: string; address: string }>;
      allowFailure?: boolean;
    }) => {
      stub.multicalls.push({
        functionNames: params.contracts.map((c) => c.functionName),
        addresses: params.contracts.map((c) => c.address.toLowerCase()),
      });
      const r = responses[i++];
      if (r === undefined) throw new Error(`unexpected multicall #${i}`);
      // Mirror viem: under allowFailure (the §A.1 stage-1 read) a
      // chunk-level failure is never thrown — every slot in the chunk
      // reports the same error — and an Error element is a per-slot
      // failure. Only without allowFailure (the whitelist-book read)
      // does viem throw.
      if (params.allowFailure === true) {
        if (r instanceof Error) {
          return params.contracts.map(() => ({ status: "failure", error: r }));
        }
        return r.map((v) =>
          v instanceof Error ? { status: "failure", error: v } : { status: "success", result: v },
        );
      }
      if (r instanceof Error) throw r;
      // Without allowFailure, viem throws the first slot's error.
      const slotError = r.find((v) => v instanceof Error);
      if (slotError !== undefined) throw slotError;
      return r;
    },
    getBlockNumber: async () => {
      stub.getBlockNumberCalls++;
      return args.latestBlock ?? 5_500n;
    },
    getLogs: async (params: {
      address?: readonly Address[];
      fromBlock?: bigint;
      toBlock?: bigint;
    }) => {
      stub.getLogsCalls++;
      return args.getLogs?.(params) ?? [];
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

/** Default role-events fixture: deployment + puller + consumer in one chunk. */
function happyEvents(rc: Address) {
  return [
    {
      address: FACTORY,
      eventName: "RequestCreated" as const,
      blockNumber: 5_000n,
      logIndex: 0,
      args: { request: rc },
    },
    {
      address: rc,
      eventName: "RolesUpdated" as const,
      blockNumber: 5_000n,
      logIndex: 1,
      args: { user: PULLER, roles: ROLE_PULLER },
    },
    {
      address: rc,
      eventName: "RolesUpdated" as const,
      blockNumber: 5_000n,
      logIndex: 2,
      args: { user: CONSUMER, roles: ROLE_CONSUMER },
    },
  ];
}

describe("buildRequestWhitelistingChecks", () => {
  it("whitelist op happy path with two contracts", async () => {
    const stub = makeClient({
      multicallResponses: [
        // RC1 stage-1: owner + isRequest=true
        [OWNER, true],
        // RC2 stage-1
        [OWNER, true],
        // whitelist book stage: floor + consumed
        [10n, false],
      ],
      getLogs: (params) => {
        const addresses = params.address ?? [];
        if (addresses.includes(RC1)) return happyEvents(RC1);
        if (addresses.includes(RC2)) return happyEvents(RC2);
        return [];
      },
      latestBlock: 5_500n,
    });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1, RC2],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const rc1Count = r.value.filter((c) => c.description.endsWith(`(for ${RC1})`)).length;
      const rc2Count = r.value.filter((c) => c.description.endsWith(`(for ${RC2})`)).length;
      expect(rc1Count).toBe(4);
      expect(rc2Count).toBe(4);
    }
  });

  it("unwhitelist op runs only nonce + deadline checks", async () => {
    const stub = makeClient({
      multicallResponses: [[10n, false]],
      latestBlock: 5_500n,
    });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1, RC2],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.some((c) => c.description.includes("(for"))).toBe(false);
    }
    expect(stub.getLogsCalls).toBe(0);
  });

  it("fails when nonce is already consumed", async () => {
    const stub = makeClient({
      multicallResponses: [[10n, true]],
    });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      expect(
        (r.error as ValidationFailedError).checks.some(
          (c) => !c.passed && c.description.includes("consumed"),
        ),
      ).toBe(true);
    }
  });

  it("fails when nonce is below floor", async () => {
    // floor = 100, nonce = 99 ⇒ on-chain reverts NonceBelowFloor.
    const stub = makeClient({
      multicallResponses: [[100n, false]],
    });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: "99",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(
        (r.error as ValidationFailedError).checks.some(
          (c) => !c.passed && c.description.includes("at or above the on-chain nonce floor"),
        ),
      ).toBe(true);
    }
  });

  it("accepts nonce == floor (on-chain rejects only strictly below)", async () => {
    const stub = makeClient({
      multicallResponses: [[100n, false]],
    });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
  });

  it("fails when nonce exceeds floor + max", async () => {
    const stub = makeClient({
      multicallResponses: [[10n, false]],
    });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: "2000",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(
        (r.error as ValidationFailedError).checks.some(
          (c) => !c.passed && c.description.includes("does not exceed"),
        ),
      ).toBe(true);
    }
  });

  it("propagates whitelist-book RPC failure as UpstreamUnavailableError", async () => {
    const stub = makeClient({ multicallResponses: [new Error("rpc 503")] });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it("propagates per-contract A.1 RPC failure as UpstreamUnavailableError", async () => {
    const stub = makeClient({ multicallResponses: [new Error("rpc 503")] });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it("emits per-contract validation entries when one contract's factory check fails", async () => {
    const stub = makeClient({
      multicallResponses: [
        [OWNER, true], // RC1: factory yes
        [OWNER, false], // RC2: factory no
        [10n, false], // book
      ],
      getLogs: (params) => {
        const addresses = params.address ?? [];
        if (addresses.includes(RC1)) return happyEvents(RC1);
        return [];
      },
      latestBlock: 5_500n,
    });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1, RC2],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      const checks = (r.error as ValidationFailedError).checks;
      const failed = checks.filter((c) => !c.passed && c.description.endsWith(`(for ${RC2})`));
      expect(failed.length).toBeGreaterThan(0);
    }
  });

  it("rogue role-holder fails the per-contract check on whitelist op", async () => {
    const stub = makeClient({
      multicallResponses: [
        [OWNER, true],
        [10n, false],
      ],
      getLogs: () => [
        {
          address: FACTORY,
          eventName: "RequestCreated",
          blockNumber: 5_000n,
          logIndex: 0,
          args: { request: RC1 },
        },
        {
          address: RC1,
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          address: RC1,
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: ROGUE, roles: ROLE_CONSUMER }, // rogue consumer
        },
      ],
      latestBlock: 5_500n,
    });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      const checks = (r.error as ValidationFailedError).checks;
      expect(
        checks.some(
          (c) =>
            !c.passed &&
            c.description.includes("consumer role") &&
            c.description.endsWith(`(for ${RC1})`),
        ),
      ).toBe(true);
    }
  });

  it("shared cache amortises §A.1 across whitelist batches that re-use a contract", async () => {
    const stub = makeClient({
      multicallResponses: [
        // First whitelist call: RC1 stage-1 + book.
        [OWNER, true],
        [10n, false],
        // Second whitelist call: book only — RC1 served from cache.
        [10n, false],
      ],
      getLogs: () => happyEvents(RC1),
      latestBlock: 5_500n,
    });
    const cache = inMemoryCache(zA1OnChainData);
    const run = buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
      cache,
    });

    const r1 = await run(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r1.isOk()).toBe(true);
    expect(stub.multicalls.length).toBe(2); // RC1 + book
    expect(stub.getLogsCalls).toBe(1);

    const r2 = await run(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1],
      nonce: "101",
      deadline: 1_700_000_500,
    });
    expect(r2.isOk()).toBe(true);
    // Book read happens (request-wide) but no new RC1 multicall / logs.
    expect(stub.multicalls.length).toBe(3);
    expect(stub.getLogsCalls).toBe(1);
  });

  it("rejects an oversized requestContracts batch before any on-chain read (default cap)", async () => {
    const manyContracts = Array.from(
      { length: DEFAULT_MAX_REQUEST_CONTRACTS + 1 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
    );
    const stub = makeClient({}); // any RPC would throw "unexpected multicall"
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: manyContracts,
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const batch = (r.error as ValidationFailedError).checks.find((c) =>
        c.description.includes("batch size"),
      );
      expect(batch?.passed).toBe(false);
      expect(batch?.reason).toMatch(/exceeds the maximum of 50/);
    }
    expect(stub.multicalls.length).toBe(0);
    expect(stub.getLogsCalls).toBe(0);
    expect(stub.getBlockNumberCalls).toBe(0);
  });

  it("applies the batch cap to unwhitelist operations too", async () => {
    const manyContracts = Array.from(
      { length: 3 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
    );
    const stub = makeClient({});
    const r = await buildRequestWhitelistingChecks({
      policy: { ...policy, maxRequestContracts: 2 },
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: manyContracts,
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
    expect(stub.multicalls.length).toBe(0);
  });

  it("throws at construction for a non-positive or fractional maxRequestContracts", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() =>
        buildRequestWhitelistingChecks({
          policy: { ...policy, maxRequestContracts: bad },
          guardianSigner: GUARDIAN,
        }),
      ).toThrow(TypeError);
    }
  });

  it("fails 422 before any RPC when the whitelist book is off the accepted-books policy", async () => {
    const stub = makeClient({});
    const r = await buildRequestWhitelistingChecks({
      policy: {
        ...policy,
        acceptedWhitelistBooks: new Map([[1, new Set<string>([RC1])]]), // BOOK not accepted
      },
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const checks = (r.error as ValidationFailedError).checks;
      const book = checks.find((c) => c.description.includes("accepted-books"));
      expect(book?.passed).toBe(false);
      // Nonce entries are present but skipped — the book was never read.
      expect(checks.filter((c) => c.skipped && c.description.includes("nonce")).length).toBe(3);
    }
    expect(stub.multicalls.length).toBe(0);
    expect(stub.getLogsCalls).toBe(0);
  });

  it("passes through with a passed book check when the book is on the accepted-books policy", async () => {
    const stub = makeClient({
      multicallResponses: [
        [OWNER, true],
        [10n, false],
      ],
      getLogs: () => happyEvents(RC1),
      latestBlock: 5_500n,
    });
    const r = await buildRequestWhitelistingChecks({
      policy: {
        ...policy,
        acceptedWhitelistBooks: new Map([[1, new Set<string>([BOOK])]]),
      },
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "whitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const book = r.value.find((c) => c.description.includes("accepted-books"));
      expect(book?.passed).toBe(true);
      expect(book?.skipped).toBe(false);
    }
  });

  it("treats a deterministic book read failure (EOA book) as a 422 check failure, not a 503", async () => {
    const eoaBookError = new ContractFunctionExecutionError(
      new ContractFunctionZeroDataError({ functionName: "validatorNonceFloor" }),
      {
        abi: whitelistBookAbi,
        functionName: "validatorNonceFloor",
        args: [GUARDIAN],
        contractAddress: BOOK,
      },
    );
    const stub = makeClient({ multicallResponses: [eoaBookError] });
    const r = await buildRequestWhitelistingChecks({
      policy,
      guardianSigner: GUARDIAN,
    })(ctx(stub.client), {
      chainId: 1,
      whitelistBook: BOOK,
      operation: "unwhitelist",
      requestContracts: [RC1],
      nonce: "100",
      deadline: 1_700_000_500,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const checks = (r.error as ValidationFailedError).checks;
      const book = checks.find((c) => c.description.includes("per-validator nonce state"));
      expect(book?.passed).toBe(false);
      expect(checks.filter((c) => c.skipped && c.description.includes("nonce")).length).toBe(3);
    }
  });
});
