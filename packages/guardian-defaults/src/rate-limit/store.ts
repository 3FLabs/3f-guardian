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
 * replica deployments, and unit tests.
 *
 * Keeps memory bounded by lazily evicting expired windows: every `read`
 * drops the entry if its window has already closed, and every Nth
 * `write` opportunistically sweeps expired entries so an idle key set
 * does not grow without bound when reads never visit them again.
 *
 * `now` is injectable for tests; defaults to `Date.now`.
 */
export function inMemoryRateLimitStore(opts?: { now?: () => number }): RateLimitStore {
  const now = opts?.now ?? Date.now;
  const map = new Map<string, RateLimitState>();
  // Sweep no more than once per ~256 writes to keep the amortised cost negligible.
  const SWEEP_PERIOD = 256;
  let writes = 0;

  const sweep = (nowSec: number) => {
    for (const [k, v] of map) {
      if (v.resetUnixSeconds <= nowSec) map.delete(k);
    }
  };

  return {
    async read(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      const nowSec = Math.floor(now() / 1000);
      if (entry.resetUnixSeconds <= nowSec) {
        map.delete(key);
        return undefined;
      }
      return entry;
    },
    async write(key, state) {
      map.set(key, state);
      writes++;
      if (writes % SWEEP_PERIOD === 0) {
        sweep(Math.floor(now() / 1000));
      }
    },
  };
}
