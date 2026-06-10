import { Result } from "better-result";

import { type GuardianError, RateLimitedError, type TokenInfo } from "@3flabs/guardian";
import type { RateLimitWindow } from "@3flabs/guardian";

import { inMemoryRateLimitStore, type RateLimitDecision, type RateLimitStore } from "./store.js";

/**
 * Configuration for the default rate limiter.
 *
 *  - `limit`           — requests permitted per `windowSeconds`.
 *  - `windowSeconds`   — width of the fixed window. The window is keyed
 *                        per token: when a token's first request lands,
 *                        a new window opens that ends `windowSeconds`
 *                        later. Subsequent requests within that window
 *                        decrement the budget; once exhausted, further
 *                        requests yield `RateLimitedError` with
 *                        `retryAfterSeconds = resetUnixSeconds - now`.
 *  - `now`             — clock injection for tests. Defaults to
 *                        `Date.now`. Must return milliseconds since
 *                        epoch.
 *  - `keyOf`           — extract the rate-limit key from `TokenInfo`.
 *                        Defaults to `tokenId`.
 *  - `store`           — pluggable storage. Defaults to a single-
 *                        process Map.
 */
export type RateLimiterOptions = {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly now?: () => number;
  readonly keyOf?: (token: TokenInfo) => string;
  readonly store?: RateLimitStore;
};

/**
 * Builds an `accountRateLimit` function suitable to plug into
 * `GuardianAbstractions`. Implements a fixed-window counter:
 *
 *   - The window opens on the first request for a token and is `windowSeconds` wide.
 *   - The window resets when the wall clock crosses `resetUnixSeconds`.
 *   - When `count >= limit`, returns `Err(RateLimitedError)` with
 *     `retryAfterSeconds = max(1, ceil(resetUnixSeconds - now))` (rounded
 *     up to the nearest second so callers never get a `Retry-After: 0`
 *     or a fractional, RFC-9110-invalid `Retry-After`).
 *
 * On success, returns a populated `RateLimitWindow` so the auth plugin
 * can emit `X-RateLimit-Limit / -Remaining / -Reset` (§6.3).
 *
 * Atomicity: when the store implements the optional `consume`, the
 * check-and-increment is delegated to it in a single atomic operation —
 * the bundled `inMemoryRateLimitStore` does so synchronously, making
 * concurrent in-process bursts unable to over-admit. For stores that
 * only expose `read` / `write`, the limiter serialises the
 * read-modify-write per key with an in-process mutex; that fallback is
 * single-process safe only. For multi-replica deployments substitute a
 * store whose `consume` is transactional (Redis with `INCR + EXPIRE`,
 * or a Cloudflare Durable Object).
 */
export function inMemoryRateLimiter(options: RateLimiterOptions) {
  const { limit, windowSeconds, now = Date.now, keyOf = (t: TokenInfo) => t.tokenId } = options;
  // Default store inherits the limiter's clock so test/host-injected
  // time controls both sides of the read/evict path consistently.
  const store = options.store ?? inMemoryRateLimitStore({ now });

  if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) {
    throw new Error(`inMemoryRateLimiter: limit must be a positive integer, got ${limit}`);
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error(`inMemoryRateLimiter: windowSeconds must be > 0, got ${windowSeconds}`);
  }

  // Per-key serialisation for stores that only expose `read` / `write`:
  // the read-modify-write in `readModifyWrite` spans two awaits, so
  // without a mutex two concurrent requests for the same key would both
  // read the same stale count and both pass. Entries are dropped once
  // their chain drains so key cardinality never leaks memory, and the
  // chain advances on rejection too (`.then(task, task)`) so one failed
  // store call cannot poison the key forever.
  const chains = new Map<string, Promise<void>>();
  const withKeyLock = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const tail = chains.get(key) ?? Promise.resolve();
    const next = tail.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return next;
  };

  const readModifyWrite = (key: string, nowSec: number): Promise<RateLimitDecision> =>
    withKeyLock(key, async () => {
      const previous = await store.read(key);
      if (!previous || previous.resetUnixSeconds <= nowSec) {
        // First request in a new window. `Math.ceil` keeps the reset
        // boundary on a whole second even for fractional windows.
        const state = { count: 1, resetUnixSeconds: Math.ceil(nowSec + windowSeconds) };
        await store.write(key, state);
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
      await store.write(key, state);
      return { allowed: true, ...state };
    });

  return async (token: TokenInfo): Promise<Result<RateLimitWindow, GuardianError>> => {
    const key = keyOf(token);
    const nowSec = Math.floor(now() / 1000);

    const decision = store.consume
      ? await store.consume(key, limit, windowSeconds, nowSec)
      : await readModifyWrite(key, nowSec);

    if (!decision.allowed) {
      // `Math.ceil` guards against custom stores returning fractional
      // reset boundaries — Retry-After must be integral per RFC 9110.
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.resetUnixSeconds - nowSec));
      return Result.err(
        new RateLimitedError({
          message: "Per-token rate limit exceeded",
          retryAfterSeconds,
        }),
      );
    }

    return Result.ok({
      limit,
      remaining: Math.max(0, limit - decision.count),
      resetUnixSeconds: Math.ceil(decision.resetUnixSeconds),
    });
  };
}
