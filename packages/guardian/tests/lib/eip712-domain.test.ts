import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import {
  eip712DomainCacheKey,
  fetchEip712DomainNameVersion,
  type Eip712DomainCache,
} from "../../src/lib/eip712-domain.js";

const CONTRACT = "0x1111111111111111111111111111111111111111" as Address;

function makeClient(args: { read?: () => unknown | Promise<unknown> }): PublicClient {
  return {
    readContract: async () => {
      if (!args.read) throw new Error("readContract not stubbed");
      return args.read();
    },
  } as unknown as PublicClient;
}

function makeCache(): Eip712DomainCache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (key) => store.get(key) as { name: string; version: string } | undefined,
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

describe("eip712DomainCacheKey", () => {
  it("lower-cases the verifying contract", () => {
    expect(eip712DomainCacheKey(1, "0xABCDEF0000000000000000000000000000000001" as Address)).toBe(
      "1:0xabcdef0000000000000000000000000000000001",
    );
  });

  it("scopes by chain id", () => {
    expect(eip712DomainCacheKey(1, CONTRACT)).not.toBe(eip712DomainCacheKey(8453, CONTRACT));
  });
});

describe("fetchEip712DomainNameVersion", () => {
  const okResponse = ["0x0f", "3F", "1", 1n, CONTRACT, "0x" + "0".repeat(64), []] as const;

  it("returns name/version on a successful read", async () => {
    const client = makeClient({ read: () => okResponse });
    const r = await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toEqual({ name: "3F", version: "1" });
  });

  it("returns UpstreamUnavailableError on RPC failure", async () => {
    const client = makeClient({
      read: () => {
        throw new Error("rpc dead");
      },
    });
    const r = await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error._tag).toBe("UpstreamUnavailable");
      expect(r.error.status).toBe(503);
    }
  });

  it("populates the cache on miss and short-circuits on hit", async () => {
    const cache = makeCache();
    let reads = 0;
    const client = makeClient({
      read: () => {
        reads++;
        return okResponse;
      },
    });

    const a = await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
      cache,
    });
    expect(a.isOk()).toBe(true);
    expect(reads).toBe(1);
    expect(cache.store.size).toBe(1);

    const b = await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
      cache,
    });
    expect(b.isOk()).toBe(true);
    expect(reads).toBe(1); // hit, no extra RPC
  });

  it("scopes cache entries by (chainId, verifyingContract)", async () => {
    const cache = makeCache();
    let reads = 0;
    const client = makeClient({
      read: () => {
        reads++;
        return okResponse;
      },
    });
    await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
      cache,
    });
    await fetchEip712DomainNameVersion({
      client,
      chainId: 8453,
      verifyingContract: CONTRACT,
      cache,
    });
    expect(reads).toBe(2);
    expect(cache.store.size).toBe(2);
  });

  it("treats a thrown cache.get as a miss and still serves on-chain", async () => {
    const flakyCache: Eip712DomainCache = {
      get: async () => {
        throw new Error("cache went away");
      },
      set: async () => {},
    };
    const client = makeClient({ read: () => okResponse });
    const r = await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
      cache: flakyCache,
    });
    expect(r.isOk()).toBe(true);
  });
});
