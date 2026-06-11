import { describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  InternalRpcError,
  RpcRequestError,
  type Address,
  type PublicClient,
} from "viem";
import { getContractError } from "viem/utils";

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
      if (r.error._tag === "UpstreamUnavailable") expect(r.error.status).toBe(503);
    }
  });

  it("returns UpstreamUnavailableError on transport failure wrapped in a viem cause chain", async () => {
    const client = makeClient({
      read: () => {
        throw new BaseError("call failed", {
          cause: new HttpRequestError({ url: "http://rpc.internal:8545", details: "ECONNREFUSED" }),
        });
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
      // The client-facing message must not leak the raw viem error text
      // (it can embed RPC URLs).
      expect(r.error.message).not.toContain("rpc.internal");
      expect(r.error.message).not.toContain("ECONNREFUSED");
    }
  });

  it("returns NotFoundError (404) when the contract returns zero data (no code / no ERC-5267)", async () => {
    const client = makeClient({
      read: () => {
        throw new BaseError("call failed", {
          cause: new ContractFunctionZeroDataError({ functionName: "eip712Domain" }),
        });
      },
    });
    const r = await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error._tag).toBe("NotFound");
      expect(r.error.message).toContain(CONTRACT);
      expect(r.error.message).toContain("ERC-5267");
    }
  });

  it("returns NotFoundError (404) when eip712Domain() reverts with revert data", async () => {
    const client = makeClient({
      read: () => {
        throw new BaseError("call failed", {
          cause: new ContractFunctionRevertedError({
            abi: [],
            // Raw revert payload (custom-error selector) — unambiguous
            // evidence of a genuine on-chain revert.
            data: "0x12345678",
            functionName: "eip712Domain",
          }),
        });
      },
    });
    const r = await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error._tag).toBe("NotFound");
  });

  it("returns NotFoundError (404) on a data-less revert whose cause carries JSON-RPC code 3", async () => {
    const client = makeClient({
      read: () => {
        throw new BaseError("call failed", {
          cause: new ContractFunctionRevertedError({
            abi: [],
            functionName: "eip712Domain",
            message: "execution reverted",
            // Code 3 is the unambiguous execution-reverted JSON-RPC
            // code, even when the node returns no revert data.
            cause: Object.assign(new Error("execution reverted"), { code: 3 }),
          }),
        });
      },
    });
    const r = await fetchEip712DomainNameVersion({
      client,
      chainId: 1,
      verifyingContract: CONTRACT,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error._tag).toBe("NotFound");
  });

  it("returns UpstreamUnavailableError (503) for a -32603-derived ContractFunctionRevertedError without revert data", async () => {
    // Many providers emit -32603 "internal error" for transient node
    // failures; viem's getContractError still wraps those in
    // ContractFunctionRevertedError. Replay that exact chain and assert
    // it stays on the retryable path instead of a permanent 404.
    const client = makeClient({
      read: () => {
        throw getContractError(
          new InternalRpcError(
            new RpcRequestError({
              body: { method: "eth_call" },
              url: "http://rpc.internal:8545",
              error: { code: -32603, message: "internal error: missing trie node" },
            }),
          ),
          { abi: [], address: CONTRACT, args: [], functionName: "eip712Domain" },
        );
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
      if (r.error._tag === "UpstreamUnavailable") expect(r.error.status).toBe(503);
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
