/**
 * Per-token rate-limit accounting state. The limiter is stateless
 * outside this store, so swapping the implementation (in-memory map ↔
 * Redis ↔ Durable Object) only changes how `read` / `write` materialise.
 *
 * Implementations MUST be safe to call concurrently for the same key.
 * The included `inMemoryRateLimitStore` is single-process safe; for
 * multi-replica deployments use a transactional store (CAS / atomic
 * increment).
 */
export type RateLimitState = {
  /** Number of requests counted in the current window. */
  readonly count: number;
  /** Unix-seconds at which the current window ends (exclusive). */
  readonly resetUnixSeconds: number;
};

export type RateLimitStore = {
  read: (key: string) => Promise<RateLimitState | undefined>;
  write: (key: string, state: RateLimitState) => Promise<void>;
};

/**
 * Single-process Map-backed store. Suitable for development, single-
 * replica deployments, and unit tests. Never grows without bound: a
 * background sweep removes expired entries on every read after the
 * window resets.
 */
export function inMemoryRateLimitStore(): RateLimitStore {
  const map = new Map<string, RateLimitState>();
  return {
    async read(key) {
      return map.get(key);
    },
    async write(key, state) {
      map.set(key, state);
    },
  };
}
