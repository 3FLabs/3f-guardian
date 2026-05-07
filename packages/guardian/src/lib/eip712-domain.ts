import { Result } from "better-result";
import type { Address, PublicClient } from "viem";

import { UpstreamUnavailableError } from "../errors/tagged.js";
import type { Logger } from "./logger.js";

/**
 * The two pieces of an EIP-712 domain that the Guardian cannot infer
 * from the request itself.
 *
 *  - `name` and `version` are baked into the verifying contract's
 *    `_domainNameAndVersion()` (solady) and surfaced via ERC-5267
 *    `eip712Domain()`.
 *  - `chainId` and `verifyingContract` are known to the caller (they
 *    come from the request's `chainId` and the target contract address
 *    in the body), so this struct stays minimal.
 *
 * Both grunt's Facility (`name="3F", version="1"`) and the request
 * whitelist (`name="3fRequestWhitelist", version="1"`) declare
 * `_domainNameAndVersionMayChange() = true`, which forces solady to
 * recompute the domain separator on every call. They are nevertheless
 * `pure` upgrades-aside so caching at the Guardian for a small TTL is
 * safe and shaves one RPC round-trip per signing call.
 */
export type Eip712DomainNameVersion = {
  readonly name: string;
  readonly version: string;
};

/**
 * Structural cache contract for {@link fetchEip712DomainNameVersion}.
 * Designed to be satisfied by `AsyncCache<Eip712DomainNameVersion>`
 * from `@3flabs/guardian-defaults/cache` without an explicit dep.
 */
export interface Eip712DomainCache {
  get(key: string): Promise<Eip712DomainNameVersion | undefined>;
  set(key: string, value: Eip712DomainNameVersion, options?: { ttlMs?: number }): Promise<void>;
}

/**
 * Minimal ERC-5267 ABI fragment. We only need `name` and `version`
 * out of the seven-tuple — `chainId` and `verifyingContract` are
 * already known to the caller, and `fields` / `salt` / `extensions`
 * are not used by any of the v1 typed-data structs.
 */
const eip712DomainAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "eip712Domain",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

/** Cache key shape: lower-cased verifying contract scoped by chain. */
export function eip712DomainCacheKey(chainId: number, verifyingContract: Address): string {
  return `${chainId}:${verifyingContract.toLowerCase()}`;
}

/**
 * Reads `eip712Domain()` (ERC-5267) from `verifyingContract` and
 * returns `{ name, version }`. On RPC failure, an
 * `UpstreamUnavailableError` (503) is returned so the caller can map
 * to §6.6 directly.
 *
 * If `cache` is supplied, a hit short-circuits the read; misses are
 * back-filled with the optional `ttlMs` (best-effort — a thrown cache
 * write is swallowed since a flaky cache must not block signing). When
 * `logger` is supplied, both swallowed paths emit a `warn` record so a
 * misconfigured / unreachable cache is observable in production.
 */
export async function fetchEip712DomainNameVersion(args: {
  client: PublicClient;
  chainId: number;
  verifyingContract: Address;
  cache?: Eip712DomainCache;
  ttlMs?: number;
  logger?: Logger;
}): Promise<Result<Eip712DomainNameVersion, UpstreamUnavailableError>> {
  const { client, chainId, verifyingContract, cache, ttlMs, logger } = args;
  const key = eip712DomainCacheKey(chainId, verifyingContract);

  if (cache) {
    try {
      const hit = await cache.get(key);
      if (hit) return Result.ok(hit);
    } catch (e) {
      // Treat a thrown cache as a miss; we still have the on-chain path.
      logger?.warn(
        { err: e instanceof Error ? e.message : String(e), chainId, verifyingContract, key },
        "eip712Domain cache.get threw — falling back to on-chain read",
      );
    }
  }

  let result: Eip712DomainNameVersion;
  try {
    const [, name, version] = await client.readContract({
      address: verifyingContract,
      abi: eip712DomainAbi,
      functionName: "eip712Domain",
    });
    result = { name, version };
  } catch (e) {
    return Result.err(
      new UpstreamUnavailableError({
        message: `eip712Domain() read failed at ${verifyingContract}: ${
          e instanceof Error ? e.message : "unknown"
        }`,
        status: 503,
      }),
    );
  }

  if (cache) {
    try {
      await cache.set(key, result, ttlMs !== undefined ? { ttlMs } : undefined);
    } catch (e) {
      // Best-effort write — never block on a cache failure.
      logger?.warn(
        { err: e instanceof Error ? e.message : String(e), chainId, verifyingContract, key },
        "eip712Domain cache.set threw — value not persisted",
      );
    }
  }

  return Result.ok(result);
}
