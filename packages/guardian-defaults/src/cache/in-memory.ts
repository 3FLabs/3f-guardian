import type { StandardSchemaV1 } from "./standard-schema.js";
import { AsyncCache } from "./types.js";

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
 * single-replica deployments, and unit tests. The value type is
 * inferred from `schema`'s output — any Standard Schema (zod v4,
 * valibot, arktype, …) works:
 *
 * ```ts
 * const cache = inMemoryCache(zA1OnChainData, { defaultTtlMs: 60_000 });
 * //    ^ AsyncCache<A1OnChainData>
 * ```
 *
 * Each entry stores its absolute `expiresAt` (ms since epoch) so
 * expiry is decided lazily on `get` — no background timers, no
 * scheduling. Values are stored by reference; the inherited `get`
 * still re-validates each hit against the schema, so an entry that no
 * longer parses (e.g. seeded by older code across a hot reload) reads
 * as a miss rather than a corrupt hit.
 *
 * Eviction policy: lazy on read (expired entries are removed on `get`),
 * plus an opportunistic sweep + insertion-order trim on every `set`
 * once the map exceeds `maxEntries`. This is not a strict LRU — entries
 * are not re-promoted on read — but it bounds memory in long-running
 * processes where most request-contracts are queried a handful of
 * times.
 *
 * For multi-replica deployments substitute a transport-backed
 * `AsyncCache` subclass (Redis, Memcached, Cloudflare KV). Concurrent
 * reads/writes within a single process are safe: the underlying `Map`
 * mutations are sync, and the cache is correctness-permissive (a stale
 * read just triggers a redundant on-chain fetch, never a wrong answer).
 */
export function inMemoryCache<V>(
  schema: StandardSchemaV1<unknown, V>,
  options: InMemoryCacheOptions = {},
): AsyncCache<V> {
  return new InMemoryCache(schema, options);
}

class InMemoryCache<V> extends AsyncCache<V> {
  private readonly defaultTtlMs: number | undefined;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly map = new Map<string, { value: V; expiresAt: number }>();

  constructor(schema: StandardSchemaV1<unknown, V>, options: InMemoryCacheOptions) {
    super(schema);
    const { defaultTtlMs, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = options;

    if (defaultTtlMs !== undefined && (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0)) {
      throw new Error(`inMemoryCache: defaultTtlMs must be > 0, got ${defaultTtlMs}`);
    }
    if (!Number.isFinite(maxEntries) || maxEntries < 0 || !Number.isInteger(maxEntries)) {
      throw new Error(
        `inMemoryCache: maxEntries must be a non-negative integer, got ${maxEntries}`,
      );
    }

    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  protected override async rawGet(key: string): Promise<unknown> {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  override async set(key: string, value: V, opts?: { ttlMs?: number }): Promise<void> {
    const ttl = opts?.ttlMs ?? this.defaultTtlMs;
    // Same predicate the constructor applies to `defaultTtlMs`. NaN
    // would otherwise produce an immortal entry (`NaN <= now` is
    // false in both the get-expiry check and the sweep) and 0 /
    // negative would silently disable the cache. Throwing is safe:
    // the AsyncCache contract requires callers to treat a throwing
    // `set` as best-effort.
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
      throw new Error(`inMemoryCache: ttlMs must be > 0, got ${ttl}`);
    }
    const expiresAt = ttl === undefined ? Number.POSITIVE_INFINITY : this.now() + ttl;
    // Re-insert to refresh insertion order — keeps recently-written
    // keys further from the trim eviction frontier.
    this.map.delete(key);
    this.map.set(key, { value, expiresAt });

    if (this.maxEntries > 0 && this.map.size > this.maxEntries) {
      this.sweepExpired(this.now());
      this.trimToBound();
    }
  }

  override async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  private sweepExpired(currentTime: number): void {
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= currentTime) this.map.delete(key);
    }
  }

  private trimToBound(): void {
    if (this.maxEntries === 0 || this.map.size <= this.maxEntries) return;
    // Map iteration is insertion-order; oldest first.
    const overflow = this.map.size - this.maxEntries;
    let removed = 0;
    for (const key of this.map.keys()) {
      if (removed >= overflow) break;
      this.map.delete(key);
      removed++;
    }
  }
}
