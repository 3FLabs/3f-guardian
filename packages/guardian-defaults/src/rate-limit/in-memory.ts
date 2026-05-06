import { Result } from "better-result";

import { type GuardianError, RateLimitedError, type TokenInfo } from "@3flabs/guardian";
import type { RateLimitWindow } from "@3flabs/guardian";

import { inMemoryRateLimitStore, type RateLimitStore } from "./store.js";

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
 *     `retryAfterSeconds = max(1, resetUnixSeconds - now)` (rounded
 *     up to the nearest second so callers never get a `Retry-After: 0`).
 *
 * On success, returns a populated `RateLimitWindow` so the auth plugin
 * can emit `X-RateLimit-Limit / -Remaining / -Reset` (§6.3).
 *
 * Single-process only by default. For multi-replica deployments
 * substitute a transactional `RateLimitStore` (Redis with
 * `INCR + EXPIRE`, or Cloudflare Durable Object), since the read /
 * write here is not atomic across processes.
 */
export function inMemoryRateLimiter(options: RateLimiterOptions) {
  const {
    limit,
    windowSeconds,
    now = Date.now,
    keyOf = (t: TokenInfo) => t.tokenId,
    store = inMemoryRateLimitStore(),
  } = options;

  if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) {
    throw new Error(`inMemoryRateLimiter: limit must be a positive integer, got ${limit}`);
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error(`inMemoryRateLimiter: windowSeconds must be > 0, got ${windowSeconds}`);
  }

  return async (token: TokenInfo): Promise<Result<RateLimitWindow, GuardianError>> => {
    const key = keyOf(token);
    const nowSec = Math.floor(now() / 1000);
    const previous = await store.read(key);

    let count: number;
    let resetUnixSeconds: number;

    if (!previous || previous.resetUnixSeconds <= nowSec) {
      // First request in a new window.
      count = 1;
      resetUnixSeconds = nowSec + windowSeconds;
    } else if (previous.count >= limit) {
      // Window still open and budget exhausted.
      const retryAfterSeconds = Math.max(1, previous.resetUnixSeconds - nowSec);
      return Result.err(
        new RateLimitedError({
          message: "Per-token rate limit exceeded",
          retryAfterSeconds,
        }),
      );
    } else {
      // Window still open, budget remaining.
      count = previous.count + 1;
      resetUnixSeconds = previous.resetUnixSeconds;
    }

    await store.write(key, { count, resetUnixSeconds });

    return Result.ok({
      limit,
      remaining: Math.max(0, limit - count),
      resetUnixSeconds,
    });
  };
}
