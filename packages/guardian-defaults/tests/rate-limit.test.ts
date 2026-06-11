import { describe, expect, it } from "vitest";

import {
  ENDPOINT_SCOPES,
  RateLimitedError,
  type TokenInfo,
  UpstreamUnavailableError,
} from "@3flabs/guardian";

import { inMemoryRateLimiter } from "../src/rate-limit/in-memory.js";
import type { RateLimitState, RateLimitStore } from "../src/rate-limit/store.js";

function token(id = "tok"): TokenInfo {
  return {
    tokenId: id,
    scopes: new Set(ENDPOINT_SCOPES),
    requiresHmac: false,
  };
}

describe("inMemoryRateLimiter", () => {
  it("returns Ok with decreasing remaining on each call within the window", async () => {
    let now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 3, windowSeconds: 60, now: () => now });
    const tk = token();

    const r1 = await limiter(tk);
    const r2 = await limiter(tk);
    const r3 = await limiter(tk);

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    expect(r3.isOk()).toBe(true);
    if (r1.isOk()) expect(r1.value.remaining).toBe(2);
    if (r2.isOk()) expect(r2.value.remaining).toBe(1);
    if (r3.isOk()) expect(r3.value.remaining).toBe(0);
  });

  it("returns Err(RateLimitedError) once budget is exhausted", async () => {
    let now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 2, windowSeconds: 60, now: () => now });
    const tk = token();

    await limiter(tk);
    await limiter(tk);
    const blocked = await limiter(tk);

    expect(blocked.isErr()).toBe(true);
    if (blocked.isErr() && blocked.error instanceof RateLimitedError) {
      expect(blocked.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(blocked.error.retryAfterSeconds).toBeLessThanOrEqual(60);
    } else if (blocked.isErr()) {
      throw new Error(`expected RateLimitedError, got ${blocked.error._tag}`);
    }
  });

  it("never returns Retry-After: 0 (clamps to ≥ 1)", async () => {
    let now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 1, windowSeconds: 60, now: () => now });
    const tk = token();
    await limiter(tk);
    // Advance to exactly the moment of reset minus 0.5s — Math.floor
    // keeps retryAfter at 1, never 0.
    now = 1_700_000_000_000 + 59_500;
    const blocked = await limiter(tk);
    expect(blocked.isErr()).toBe(true);
    if (blocked.isErr() && blocked.error instanceof RateLimitedError) {
      expect(blocked.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("resets the window after resetUnixSeconds is crossed", async () => {
    let now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 1, windowSeconds: 30, now: () => now });
    const tk = token();
    const first = await limiter(tk);
    expect(first.isOk()).toBe(true);
    if (first.isOk()) expect(first.value.remaining).toBe(0);

    // Just past reset: a fresh window opens.
    now += 31_000;
    const reopened = await limiter(tk);
    expect(reopened.isOk()).toBe(true);
    if (reopened.isOk()) {
      expect(reopened.value.remaining).toBe(0); // 1-1 in fresh window
      expect(reopened.value.limit).toBe(1);
    }
  });

  it("isolates buckets per token", async () => {
    let now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 1, windowSeconds: 60, now: () => now });
    const a = token("a");
    const b = token("b");
    const ra = await limiter(a);
    const rb = await limiter(b);
    expect(ra.isOk()).toBe(true);
    expect(rb.isOk()).toBe(true);
  });

  it("rejects non-positive limit / window", () => {
    expect(() => inMemoryRateLimiter({ limit: 0, windowSeconds: 60 })).toThrow();
    expect(() => inMemoryRateLimiter({ limit: 1, windowSeconds: 0 })).toThrow();
  });

  it("admits exactly `limit` requests under a fully concurrent burst (default store)", async () => {
    const now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 3, windowSeconds: 60, now: () => now });
    const tk = token();

    const results = await Promise.all(Array.from({ length: 20 }, () => limiter(tk)));

    const admitted = results.filter((r) => r.isOk());
    const blocked = results.filter((r) => r.isErr());
    expect(admitted).toHaveLength(3);
    expect(blocked).toHaveLength(17);
    for (const b of blocked) {
      if (b.isErr()) expect(b.error).toBeInstanceOf(RateLimitedError);
    }
  });

  it("admits exactly `limit` under a concurrent burst with a read/write-only store", async () => {
    // Store without `consume` whose read/write yield to the event loop,
    // recreating the widest possible interleaving window — the limiter
    // must serialise the read-modify-write per key.
    const map = new Map<string, RateLimitState>();
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const store: RateLimitStore = {
      async read(key) {
        await tick();
        return map.get(key);
      },
      async write(key, state) {
        await tick();
        map.set(key, state);
      },
    };
    const now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 2, windowSeconds: 60, now: () => now, store });
    const tk = token();

    const results = await Promise.all(Array.from({ length: 10 }, () => limiter(tk)));

    expect(results.filter((r) => r.isOk())).toHaveLength(2);
    expect(results.filter((r) => r.isErr())).toHaveLength(8);
  });

  it("a rejected store call does not poison the per-key serialisation chain", async () => {
    const map = new Map<string, RateLimitState>();
    let failNext = true;
    const store: RateLimitStore = {
      async read(key) {
        if (failNext) {
          failNext = false;
          throw new Error("transient store outage");
        }
        return map.get(key);
      },
      async write(key, state) {
        map.set(key, state);
      },
    };
    const now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 5, windowSeconds: 60, now: () => now, store });
    const tk = token();

    await expect(limiter(tk)).rejects.toThrow("transient store outage");
    const second = await limiter(tk);
    expect(second.isOk()).toBe(true);
  });

  it("drops a queued task whose caller aborted, without touching the store", async () => {
    // Recreates the shell's `rateLimitMs` deadline losing the race: the
    // caller was already answered 503, so the queued read-modify-write
    // must not run against the store and burn window budget.
    const map = new Map<string, RateLimitState>();
    let reads = 0;
    let writes = 0;
    let releaseRead: (() => void) | undefined;
    let holdNextRead = false;
    const store: RateLimitStore = {
      async read(key) {
        reads++;
        if (holdNextRead) {
          holdNextRead = false;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        }
        return map.get(key);
      },
      async write(key, state) {
        writes++;
        map.set(key, state);
      },
    };
    const now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 1, windowSeconds: 60, now: () => now, store });
    const tk = token();

    holdNextRead = true;
    const holder = limiter(tk); // acquires the lock, parked inside store.read
    const controller = new AbortController();
    const abandoned = limiter(tk, { signal: controller.signal }); // queued behind the holder
    controller.abort();
    // Let the holder finish; the abandoned task then runs, sees the
    // aborted signal and bails before any store I/O.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseRead?.();

    const first = await holder;
    expect(first.isOk()).toBe(true);
    await expect(abandoned).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(reads).toBe(1); // only the lock holder touched the store
    expect(writes).toBe(1);
  });

  it("caps the per-key queue behind a hung store instead of growing without bound", async () => {
    // A legacy store with a dead socket and no client-side timeout never
    // settles, freezing the chain head. Callers beyond the cap must fail
    // fast with a 503 rather than appending closures forever.
    const MAX_PENDING_PER_KEY = 64; // mirrors the limiter's internal cap
    const store: RateLimitStore = {
      read: () => new Promise(() => {}), // hangs forever
      async write() {},
    };
    const now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 5, windowSeconds: 60, now: () => now, store });
    const tk = token();

    const overflow = 6;
    const states: Array<"pending" | "ok" | "rejected"> = [];
    const errors: unknown[] = [];
    for (let i = 0; i < MAX_PENDING_PER_KEY + overflow; i++) {
      const index = states.push("pending") - 1;
      void limiter(tk).then(
        () => {
          states[index] = "ok";
        },
        (error) => {
          states[index] = "rejected";
          errors.push(error);
        },
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(states.filter((s) => s === "rejected")).toHaveLength(overflow);
    expect(states.filter((s) => s === "pending")).toHaveLength(MAX_PENDING_PER_KEY);
    for (const error of errors) expect(error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it("evaluates a queued request against the clock at lock acquisition, not arrival", async () => {
    // The window expires while a request waits behind a slow lock
    // holder: with a stale pre-queue clock it would be rejected against
    // the expired window; the locked body must re-read the clock and
    // open a fresh window instead.
    const map = new Map<string, RateLimitState>();
    let releaseRead: (() => void) | undefined;
    let holdNextRead = false;
    const store: RateLimitStore = {
      async read(key) {
        if (holdNextRead) {
          holdNextRead = false;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        }
        return map.get(key);
      },
      async write(key, state) {
        map.set(key, state);
      },
    };
    let now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 1, windowSeconds: 30, now: () => now, store });
    const tk = token();

    const first = await limiter(tk); // consumes the budget; window ends at t0+30s
    expect(first.isOk()).toBe(true);

    holdNextRead = true;
    const holder = limiter(tk); // acquires the lock, parked inside store.read
    const queued = limiter(tk); // waits behind the holder
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    now += 31_000; // window rolls over while both wait
    releaseRead?.();

    const blocked = await holder; // evaluated at lock time, inside the old window
    expect(blocked.isErr()).toBe(true);
    const reopened = await queued; // lock acquired after rollover → fresh window
    expect(reopened.isOk()).toBe(true);
    if (reopened.isOk()) {
      expect(reopened.value.remaining).toBe(0); // 1-1 in the fresh window
      expect(reopened.value.resetUnixSeconds).toBe(Math.floor(now / 1000) + 30);
    }
  });

  it("computes Retry-After from the evaluation-time clock, not the pre-queue clock", async () => {
    const map = new Map<string, RateLimitState>();
    let releaseRead: (() => void) | undefined;
    let holdNextRead = false;
    const store: RateLimitStore = {
      async read(key) {
        if (holdNextRead) {
          holdNextRead = false;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        }
        return map.get(key);
      },
      async write(key, state) {
        map.set(key, state);
      },
    };
    let now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 1, windowSeconds: 60, now: () => now, store });
    const tk = token();

    const first = await limiter(tk); // window ends at t0+60s
    expect(first.isOk()).toBe(true);

    holdNextRead = true;
    const holder = limiter(tk);
    const queued = limiter(tk); // arrives at t0; would see Retry-After 60 with a stale clock
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    now += 50_000; // 50s elapse in the queue; 10s of the window remain
    releaseRead?.();

    const blockedHolder = await holder;
    expect(blockedHolder.isErr()).toBe(true);
    const blocked = await queued;
    expect(blocked.isErr()).toBe(true);
    if (blocked.isErr() && blocked.error instanceof RateLimitedError) {
      expect(blocked.error.retryAfterSeconds).toBe(10);
    } else if (blocked.isErr()) {
      throw new Error(`expected RateLimitedError, got ${blocked.error._tag}`);
    }
  });

  it("emits whole-second retryAfterSeconds / resetUnixSeconds for fractional windows", async () => {
    const now = 1_700_000_000_000;
    const limiter = inMemoryRateLimiter({ limit: 1, windowSeconds: 60.5, now: () => now });
    const tk = token();

    const first = await limiter(tk);
    expect(first.isOk()).toBe(true);
    if (first.isOk()) {
      expect(Number.isInteger(first.value.resetUnixSeconds)).toBe(true);
    }

    const blocked = await limiter(tk);
    expect(blocked.isErr()).toBe(true);
    if (blocked.isErr() && blocked.error instanceof RateLimitedError) {
      expect(Number.isInteger(blocked.error.retryAfterSeconds)).toBe(true);
      expect(blocked.error.retryAfterSeconds).toBe(61); // ceil(60.5)
    } else if (blocked.isErr()) {
      throw new Error(`expected RateLimitedError, got ${blocked.error._tag}`);
    }
  });
});
