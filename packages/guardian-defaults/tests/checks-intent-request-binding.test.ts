import { describe, expect, it } from "vitest";
import { type Address } from "viem";

import {
  noopLogger,
  UpstreamUnavailableError,
  ValidationFailedError,
  type SigningContext,
} from "@3flabs/guardian";

import { inMemoryCache } from "../src/cache/in-memory.js";
import {
  buildIntentRequestBindingChecks,
  type A1OnChainData,
  type IntentRequestBindingPolicy,
} from "../src/checks/intent-request-binding.js";

const FACTORY = "0xfaC70rfaC70rfaC70rfaC70rfaC70rfaC70rfaC0" as Address;
const OTHER_FACTORY = "0x0000000000000000000000000000000000000aaa" as Address;
const RC = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const OWNER = "0x000000000000000000000000000000000000000a" as Address;
const ROGUE_OWNER = "0x000000000000000000000000000000000000dead" as Address;
const PULLER = "0x000000000000000000000000000000000000000b" as Address;
const CONSUMER = "0x000000000000000000000000000000000000000c" as Address;
const ROGUE = "0x00000000000000000000000000000000ffffffff" as Address;

const ROLE_PULLER = 1n;
const ROLE_CONSUMER = 2n;

const policy: IntentRequestBindingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedRequestFactories: new Map([[1, new Set<string>([FACTORY])]]),
  acceptedOwners: new Map([[1, new Set<string>([OWNER])]]),
  acceptedPullers: new Map([[1, new Set<string>([PULLER])]]),
  acceptedConsumers: new Map([[1, new Set<string>([CONSUMER])]]),
  eventScanBlockRange: 1_000n,
  eventScanMaxLookbackBlocks: 5_000n,
};

const baseBody = {
  chainId: 1,
  facility: "0x0000000000000000000000000000000000000099" as Address,
  intent: { id: "42" },
  requestContract: RC,
  deadline: 1_700_000_500,
} as const;

type Stub = {
  client: SigningContext["client"];
  multicalls: Array<{ functionNames: string[] }>;
  getLogsCalls: number;
  getBlockNumberCalls: number;
};

/**
 * Stub `client.multicall` + `client.getLogs` + `client.getBlockNumber`
 * with a queue of multicall responses, a getLogs handler, and a fixed
 * latest-block. Throw responses simulate RPC failure.
 */
function makeClient(args: {
  multicallResponses?: ReadonlyArray<readonly unknown[] | Error>;
  getLogs?: (params: {
    address?: readonly Address[];
    fromBlock?: bigint;
    toBlock?: bigint;
  }) => Array<{
    eventName: "RolesUpdated" | "RequestCreated";
    blockNumber: bigint;
    logIndex: number;
    args: { user?: Address; roles?: bigint; request?: Address };
  }>;
  getLogsThrows?: Error;
  latestBlock?: bigint;
  getBlockNumberThrows?: Error;
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
    multicall: async (params: { contracts: ReadonlyArray<{ functionName: string }> }) => {
      stub.multicalls.push({ functionNames: params.contracts.map((c) => c.functionName) });
      const r = responses[i++];
      if (r === undefined) throw new Error(`unexpected multicall #${i}`);
      if (r instanceof Error) throw r;
      return r;
    },
    getBlockNumber: async () => {
      stub.getBlockNumberCalls++;
      if (args.getBlockNumberThrows) throw args.getBlockNumberThrows;
      return args.latestBlock ?? 100_000n;
    },
    getLogs: async (params: {
      address?: readonly Address[];
      fromBlock?: bigint;
      toBlock?: bigint;
    }) => {
      stub.getLogsCalls++;
      if (args.getLogsThrows) throw args.getLogsThrows;
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

describe("buildIntentRequestBindingChecks", () => {
  it("passes when factory ok, owner ok, only accepted role-holders", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]], // owner + factory.isRequest=true
      latestBlock: 5_500n,
      getLogs: ({ fromBlock, toBlock }) => {
        // Single chunk that covers the deployment + role grants.
        // RequestCreated is on the factory; role events on RC.
        if (fromBlock !== undefined && fromBlock <= 5_000n && toBlock! >= 5_000n) {
          return [
            {
              eventName: "RequestCreated",
              blockNumber: 5_000n,
              logIndex: 0,
              args: { request: RC },
            },
            {
              eventName: "RolesUpdated",
              blockNumber: 5_000n,
              logIndex: 1,
              args: { user: PULLER, roles: ROLE_PULLER },
            },
            {
              eventName: "RolesUpdated",
              blockNumber: 5_000n,
              logIndex: 2,
              args: { user: CONSUMER, roles: ROLE_CONSUMER },
            },
          ];
        }
        return [];
      },
    });
    const run = buildIntentRequestBindingChecks({ policy });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isOk()).toBe(true);
  });

  it("fails when no accepted factory recognises the request", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, false]], // owner + factory.isRequest=false
    });
    const run = buildIntentRequestBindingChecks({ policy });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const checks = (r.error as ValidationFailedError).checks;
      expect(checks.find((c) => c.description.includes("deployed by"))?.passed).toBe(false);
      // Owner / role checks must be skipped when factory fails.
      expect(checks.filter((c) => c.skipped === true).map((c) => c.description)).toEqual([
        "owner of request contract is on the accepted-owners list",
        "puller role on request contract is held only by accepted parties",
        "consumer role on request contract is held only by accepted parties",
      ]);
    }
    // No event scan when factory check fails.
    expect(stub.getLogsCalls).toBe(0);
  });

  it("fails when owner is not on the accepted-owners list", async () => {
    const stub = makeClient({
      multicallResponses: [[ROGUE_OWNER, true]],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const run = buildIntentRequestBindingChecks({ policy });
    const r = await run(ctx(stub.client), baseBody);
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

  it("fails when a rogue address holds the puller role", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          // Rogue grant: a non-accepted address gets the puller role later.
          eventName: "RolesUpdated",
          blockNumber: 5_100n,
          logIndex: 0,
          args: { user: ROGUE, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const run = buildIntentRequestBindingChecks({ policy });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(ValidationFailedError);
      const pullerCheck = (r.error as ValidationFailedError).checks.find((c) =>
        c.description.includes("puller role"),
      );
      expect(pullerCheck?.passed).toBe(false);
    }
  });

  it("emits skipped:true for role checks when contract is older than the lookback", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      // The deployment event is OLDER than (latest - maxLookback). The
      // scan walks back maxLookbackBlocks=5_000 from latest=10_000 and
      // never sees RequestCreated → tooOld.
      latestBlock: 10_000n,
      getLogs: () => [],
    });
    const run = buildIntentRequestBindingChecks({ policy });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const puller = r.value.find((c) => c.description.includes("puller role"));
      const consumer = r.value.find((c) => c.description.includes("consumer role"));
      expect(puller?.skipped).toBe(true);
      expect(consumer?.skipped).toBe(true);
    }
  });

  it("revoking a role (RolesUpdated with roles=0) prunes the holder", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: ROGUE, roles: ROLE_PULLER }, // initial rogue grant
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_100n,
          logIndex: 0,
          args: { user: ROGUE, roles: 0n }, // revoked
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 3,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const run = buildIntentRequestBindingChecks({ policy });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isOk()).toBe(true);
  });

  it("propagates multicall failure as UpstreamUnavailableError", async () => {
    const stub = makeClient({ multicallResponses: [new Error("rpc 503")] });
    const run = buildIntentRequestBindingChecks({ policy });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it("propagates getLogs failure as UpstreamUnavailableError", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      latestBlock: 5_500n,
      getLogsThrows: new Error("rpc range exceeded"),
    });
    const run = buildIntentRequestBindingChecks({ policy });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it("rejects when the deadline exceeds the policy ceiling", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const run = buildIntentRequestBindingChecks({
      policy: { ...policy, maxDeadlineSecondsAhead: 60 },
    });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error).toBeInstanceOf(ValidationFailedError);
  });

  it("picks the matching factory deterministically when multiple are configured", async () => {
    const policyMulti: IntentRequestBindingPolicy = {
      ...policy,
      acceptedRequestFactories: new Map([[1, new Set<string>([OTHER_FACTORY, FACTORY])]]),
    };
    const stub = makeClient({
      multicallResponses: [[OWNER, false, true]], // first factory says no, second says yes
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const run = buildIntentRequestBindingChecks({ policy: policyMulti });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isOk()).toBe(true);
  });

  it("cache miss writes A1OnChainData and a subsequent call avoids all on-chain reads", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const cache = inMemoryCache<A1OnChainData>();
    const run = buildIntentRequestBindingChecks({ policy, cache });

    const r1 = await run(ctx(stub.client), baseBody);
    expect(r1.isOk()).toBe(true);
    expect(stub.multicalls.length).toBe(1);
    expect(stub.getBlockNumberCalls).toBe(1);
    expect(stub.getLogsCalls).toBe(1);

    // Second call: cache hit — no further multicalls, no getLogs.
    const r2 = await run(ctx(stub.client), baseBody);
    expect(r2.isOk()).toBe(true);
    expect(stub.multicalls.length).toBe(1);
    expect(stub.getBlockNumberCalls).toBe(1);
    expect(stub.getLogsCalls).toBe(1);
  });

  it("cache hit re-evaluates against the live policy (rogue owner added removes pass)", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const cache = inMemoryCache<A1OnChainData>();

    // First call with permissive policy — cache fills.
    const r1 = await buildIntentRequestBindingChecks({ policy, cache })(ctx(stub.client), baseBody);
    expect(r1.isOk()).toBe(true);

    // Second call with a tightened owners set — owner is no longer
    // accepted. Re-runs against cached data; no new on-chain reads.
    const tightened: IntentRequestBindingPolicy = {
      ...policy,
      acceptedOwners: new Map([[1, new Set<string>([])]]),
    };
    const r2 = await buildIntentRequestBindingChecks({ policy: tightened, cache })(
      ctx(stub.client),
      baseBody,
    );
    expect(r2.isErr()).toBe(true);
    if (r2.isErr()) {
      expect(r2.error).toBeInstanceOf(ValidationFailedError);
      expect(
        (r2.error as ValidationFailedError).checks.some(
          (c) => !c.passed && c.description.includes("owner"),
        ),
      ).toBe(true);
    }
    // No additional on-chain reads.
    expect(stub.multicalls.length).toBe(1);
    expect(stub.getLogsCalls).toBe(1);
  });

  it("cache hit fails the factory check when the previously-matched factory was removed from the policy", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const cache = inMemoryCache<A1OnChainData>();

    const r1 = await buildIntentRequestBindingChecks({ policy, cache })(ctx(stub.client), baseBody);
    expect(r1.isOk()).toBe(true);

    // Drop FACTORY from the accepted-factories set.
    const tightened: IntentRequestBindingPolicy = {
      ...policy,
      acceptedRequestFactories: new Map([[1, new Set<string>([])]]),
    };
    const r2 = await buildIntentRequestBindingChecks({ policy: tightened, cache })(
      ctx(stub.client),
      baseBody,
    );
    expect(r2.isErr()).toBe(true);
    if (r2.isErr()) {
      expect(r2.error).toBeInstanceOf(ValidationFailedError);
      const checks = (r2.error as ValidationFailedError).checks;
      const factory = checks.find((c) => c.description.includes("deployed by"));
      expect(factory?.passed).toBe(false);
      // Owner / role checks remain skipped because the factory failed.
      expect(checks.filter((c) => c.skipped === true).map((c) => c.description)).toEqual([
        "owner of request contract is on the accepted-owners list",
        "puller role on request contract is held only by accepted parties",
        "consumer role on request contract is held only by accepted parties",
      ]);
    }
    expect(stub.multicalls.length).toBe(1);
  });

  it("cache TTL expiry forces a re-fetch", async () => {
    const stub = makeClient({
      multicallResponses: [
        [OWNER, true],
        [OWNER, true],
      ],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    let now = 1_700_000_000_000;
    const cache = inMemoryCache<A1OnChainData>({ now: () => now });
    const run = buildIntentRequestBindingChecks({ policy, cache, cacheTtlMs: 1_000 });

    const r1 = await run(ctx(stub.client, new Date(now)), baseBody);
    expect(r1.isOk()).toBe(true);
    expect(stub.multicalls.length).toBe(1);

    // Advance past TTL — next call must refetch.
    now += 1_500;
    const r2 = await run(ctx(stub.client, new Date(now)), baseBody);
    expect(r2.isOk()).toBe(true);
    expect(stub.multicalls.length).toBe(2);
    expect(stub.getLogsCalls).toBe(2);
  });

  it("noFactory result is cached so a subsequent call does not re-issue the multicall", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, false]],
    });
    const cache = inMemoryCache<A1OnChainData>();
    const run = buildIntentRequestBindingChecks({ policy, cache });

    const r1 = await run(ctx(stub.client), baseBody);
    expect(r1.isErr()).toBe(true);
    expect(stub.multicalls.length).toBe(1);

    const r2 = await run(ctx(stub.client), baseBody);
    expect(r2.isErr()).toBe(true);
    expect(stub.multicalls.length).toBe(1); // hit, no extra read
  });

  it("treats cache.get errors as miss without failing the request", async () => {
    const stub = makeClient({
      multicallResponses: [[OWNER, true]],
      latestBlock: 5_500n,
      getLogs: () => [
        { eventName: "RequestCreated", blockNumber: 5_000n, logIndex: 0, args: { request: RC } },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 1,
          args: { user: PULLER, roles: ROLE_PULLER },
        },
        {
          eventName: "RolesUpdated",
          blockNumber: 5_000n,
          logIndex: 2,
          args: { user: CONSUMER, roles: ROLE_CONSUMER },
        },
      ],
    });
    const cache: import("../src/cache/types.js").AsyncCache<A1OnChainData> = {
      async get() {
        throw new Error("cache transport down");
      },
      async set() {
        // swallow
      },
      async delete() {},
    };
    const run = buildIntentRequestBindingChecks({ policy, cache });
    const r = await run(ctx(stub.client), baseBody);
    expect(r.isOk()).toBe(true);
    expect(stub.multicalls.length).toBe(1);
  });
});
