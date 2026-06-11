/**
 * Per-token rate-limit accounting state. The limiter is stateless
 * outside this store, so swapping the implementation (in-memory map ↔
 * Redis ↔ Durable Object) only changes how the state materialises.
 *
 * Atomicity: per-operation safety of `read` / `write` is NOT enough for
 * a correct limiter — the check-and-increment spans both calls, so two
 * concurrent requests can read the same stale count and both pass.
 * Stores SHOULD implement the optional `consume` so the whole
 * read-modify-write is atomic (the bundled `inMemoryRateLimitStore`
 * does; a Redis store can map it onto `INCR` + `EXPIRE`). When
 * `consume` is absent, the limiter falls back to `read` / `write`
 * serialised per key within the process, which is single-process safe
 * only.
 */
export type RateLimitState = {
  /** Number of requests counted in the current window. */
  readonly count: number;
  /** Unix-seconds at which the current window ends (exclusive). */
  readonly resetUnixSeconds: number;
};

/**
 * Outcome of an atomic `consume`. When `allowed` is false the counter
 * was NOT incremented; `resetUnixSeconds` tells the caller when the
 * window reopens.
 */
export type RateLimitDecision = {
  readonly allowed: boolean;
  /** Requests counted in the window, including this one when allowed. */
  readonly count: number;
  /** Unix-seconds at which the current window ends (exclusive). */
  readonly resetUnixSeconds: number;
};

export type RateLimitStore = {
  read: (key: string) => Promise<RateLimitState | undefined>;
  write: (key: string, state: RateLimitState) => Promise<void>;
  /**
   * Atomic check-and-increment for one fixed window. Implementations
   * MUST ensure no other `consume` for the same key can interleave
   * between observing the current count and persisting the new one
   * (synchronous read-modify-write in-process, `INCR` + `EXPIRE` or a
   * transaction on Redis, single-threaded execution in a Durable
   * Object). Optional for backwards compatibility — when absent the
   * limiter serialises `read` / `write` per key within the process.
   *
   * `signal` is the caller's per-request `AbortSignal`, forwarded from
   * `accountRateLimit(tokenInfo, { signal })`. Transport-backed stores
   * SHOULD observe it and abandon in-flight work once the shell has
   * timed the request out (the synchronous in-memory store has nothing
   * to abandon and ignores it). Implementations declaring only the
   * first four parameters remain valid.
   */
  consume?: (
    key: string,
    limit: number,
    windowSeconds: number,
    nowSec: number,
    signal?: AbortSignal,
  ) => Promise<RateLimitDecision>;
};

/**
 * Single-process Map-backed store. Suitable for development, single-
 * replica deployments, and unit tests. Implements `consume` as a fully
 * synchronous read-modify-write (no await between the `Map.get` and
 * `Map.set`), so concurrent requests within the process cannot
 * interleave and over-admit.
 *
 * Keeps memory bounded by lazily evicting expired windows: every `read`
 * drops the entry if its window has already closed, and every Nth
 * write opportunistically sweeps expired entries so an idle key set
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

  const countWrite = (nowSec: number) => {
    writes++;
    if (writes % SWEEP_PERIOD === 0) sweep(nowSec);
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
      countWrite(Math.floor(now() / 1000));
    },
    async consume(key, limit, windowSeconds, nowSec) {
      // The entire read-modify-write below runs in one synchronous
      // turn — no await between `map.get` and `map.set` — so
      // concurrent `consume` calls for the same key cannot observe
      // the same stale count.
      const previous = map.get(key);
      if (!previous || previous.resetUnixSeconds <= nowSec) {
        // First request in a new window. `Math.ceil` keeps the reset
        // boundary on a whole second even for fractional windows so
        // Retry-After / X-RateLimit-Reset stay RFC-9110-valid.
        const state = { count: 1, resetUnixSeconds: Math.ceil(nowSec + windowSeconds) };
        map.set(key, state);
        countWrite(nowSec);
        return { allowed: true, ...state };
      }
      if (previous.count >= limit) {
        return {
          allowed: false,
          count: previous.count,
          resetUnixSeconds: previous.resetUnixSeconds,
        };
      }
      const state = { count: previous.count + 1, resetUnixSeconds: previous.resetUnixSeconds };
      map.set(key, state);
      countWrite(nowSec);
      return { allowed: true, ...state };
    },
  };
}
