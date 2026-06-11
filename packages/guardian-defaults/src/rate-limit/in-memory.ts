import { Result } from "better-result";

import {
  type GuardianError,
  RateLimitedError,
  type TokenInfo,
  UpstreamUnavailableError,
} from "@3flabs/guardian";
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
 *
 * Cancellation: the returned function honours the `AbortSignal` the
 * auth plugin forwards (`accountRateLimit(tokenInfo, { signal })`) on
 * the read/write fallback path — a task whose caller was already
 * answered 503 by the shell's `rateLimitMs` deadline is dropped at the
 * head of the per-key queue instead of executed late, so no budget is
 * burned for rejected requests.
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
  // read the same stale count and both pass. The chain advances on
  // rejection too (`.then(task, task)`) so one failed store call cannot
  // poison the key, and entries are dropped once their chain drains so
  // settling calls never leak key cardinality. A never-settling store
  // call (dead socket, no client-side timeout) would still freeze the
  // chain head, so the pending depth is capped: beyond
  // MAX_PENDING_PER_KEY tasks new callers fail fast with the same 503
  // the shell's `rateLimitMs` deadline would produce, keeping memory
  // bounded behind a hung legacy store. (Legacy stores SHOULD still
  // enforce their own I/O timeouts.)
  const MAX_PENDING_PER_KEY = 64;
  type KeyChain = { tail: Promise<void>; pending: number };
  const chains = new Map<string, KeyChain>();
  const withKeyLock = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const chain = chains.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (chain.pending >= MAX_PENDING_PER_KEY) {
      return Promise.reject(
        new UpstreamUnavailableError({
          message: `Rate-limit store backlog exceeded ${MAX_PENDING_PER_KEY} pending tasks for one key`,
          status: 503,
        }),
      );
    }
    chain.pending += 1;
    const next = chain.tail.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    chain.tail = settled;
    chains.set(key, chain);
    void settled.then(() => {
      chain.pending -= 1;
      if (chain.pending === 0 && chains.get(key) === chain) chains.delete(key);
    });
    return next;
  };

  const readModifyWrite = (key: string, signal?: AbortSignal): Promise<RateLimitDecision> =>
    withKeyLock(key, async () => {
      // The caller may have been abandoned by the shell's `rateLimitMs`
      // deadline while this task waited in the queue; drop it without
      // touching the store so budget is not burned (and no extra load
      // is put on an already-slow store) for a request answered 503.
      if (signal?.aborted) {
        throw new UpstreamUnavailableError({
          message: "Rate-limit check abandoned before the per-key lock was acquired",
          status: 503,
        });
      }
      // Read the clock only once the lock is held: a clock captured
      // before queueing can be stale by the full queue wait, counting a
      // request into a window that has already expired.
      const nowSec = Math.floor(now() / 1000);
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

  return async (
    token: TokenInfo,
    callOptions?: { readonly signal?: AbortSignal },
  ): Promise<Result<RateLimitWindow, GuardianError>> => {
    const key = keyOf(token);

    const decision = store.consume
      ? await store.consume(key, limit, windowSeconds, Math.floor(now() / 1000))
      : await readModifyWrite(key, callOptions?.signal);

    if (!decision.allowed) {
      // Read the clock after the awaited decision — the read/write
      // fallback may have queued behind slow store calls, and a
      // Retry-After computed from a pre-queue clock would overstate the
      // wait. `Math.ceil` guards against custom stores returning
      // fractional reset boundaries — Retry-After must be integral per
      // RFC 9110.
      const nowSec = Math.floor(now() / 1000);
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
