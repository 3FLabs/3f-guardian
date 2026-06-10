import type { AsyncCache } from "./types.js";

/**
 * Configuration for the default in-memory cache.
 *
 *  - `defaultTtlMs` — applied when `set` is called without `ttlMs`. If
 *    omitted entries live forever (until evicted by `maxEntries`).
 *  - `maxEntries`   — soft LRU bound. When the map exceeds this size on
 *    `set`, expired entries are swept first; if still over, the oldest
 *    insertion-ordered entries are evicted until the map fits. Defaults
 *    to `4096` so a zero-config cache keyed by request-supplied input
 *    cannot grow without bound; pass an explicit `0` to disable the
 *    bound (opt-in to unbounded growth).
 *  - `now`          — clock injection for tests. Defaults to `Date.now`.
 *    Must return milliseconds since epoch.
 */
export type InMemoryCacheOptions = {
  readonly defaultTtlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
};

/** Default `maxEntries` bound applied when none is configured. */
export const DEFAULT_MAX_ENTRIES = 4096;

/**
 * Single-process Map-backed `AsyncCache`. Suitable for development,
 * single-replica deployments, and unit tests. Each entry stores its
 * absolute `expiresAt` (ms since epoch) so expiry is decided lazily on
 * `get` — no background timers, no scheduling.
 *
 * Eviction policy: lazy on read (expired entries are removed on `get`),
 * plus an opportunistic sweep + insertion-order trim on every `set`
 * once the map exceeds `maxEntries`. This is not a strict LRU — entries
 * are not re-promoted on read — but it bounds memory in long-running
 * processes where most request-contracts are queried a handful of
 * times.
 *
 * For multi-replica deployments substitute a transport-backed
 * `AsyncCache` (Redis, Memcached, Cloudflare KV). Concurrent
 * reads/writes within a single process are safe: the underlying `Map`
 * mutations are sync, and the cache is correctness-permissive (a stale
 * read just triggers a redundant on-chain fetch, never a wrong answer).
 */
export function inMemoryCache<V>(options: InMemoryCacheOptions = {}): AsyncCache<V> {
  const { defaultTtlMs, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = options;

  if (defaultTtlMs !== undefined && (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0)) {
    throw new Error(`inMemoryCache: defaultTtlMs must be > 0, got ${defaultTtlMs}`);
  }
  if (!Number.isFinite(maxEntries) || maxEntries < 0 || !Number.isInteger(maxEntries)) {
    throw new Error(`inMemoryCache: maxEntries must be a non-negative integer, got ${maxEntries}`);
  }

  type Entry = { value: V; expiresAt: number };
  const map = new Map<string, Entry>();

  function sweepExpired(currentTime: number): void {
    for (const [key, entry] of map) {
      if (entry.expiresAt <= currentTime) map.delete(key);
    }
  }

  function trimToBound(): void {
    if (maxEntries === 0 || map.size <= maxEntries) return;
    // Map iteration is insertion-order; oldest first.
    const overflow = map.size - maxEntries;
    let removed = 0;
    for (const key of map.keys()) {
      if (removed >= overflow) break;
      map.delete(key);
      removed++;
    }
  }

  return {
    async get(key) {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },

    async set(key, value, opts) {
      const ttl = opts?.ttlMs ?? defaultTtlMs;
      // Same predicate the constructor applies to `defaultTtlMs`. NaN
      // would otherwise produce an immortal entry (`NaN <= now` is
      // false in both the get-expiry check and the sweep) and 0 /
      // negative would silently disable the cache. Throwing is safe:
      // the AsyncCache contract requires callers to treat a throwing
      // `set` as best-effort.
      if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
        throw new Error(`inMemoryCache: ttlMs must be > 0, got ${ttl}`);
      }
      const expiresAt = ttl === undefined ? Number.POSITIVE_INFINITY : now() + ttl;
      // Re-insert to refresh insertion order — keeps recently-written
      // keys further from the trim eviction frontier.
      map.delete(key);
      map.set(key, { value, expiresAt });

      if (maxEntries > 0 && map.size > maxEntries) {
        sweepExpired(now());
        trimToBound();
      }
    },

    async delete(key) {
      map.delete(key);
    },
  };
}
