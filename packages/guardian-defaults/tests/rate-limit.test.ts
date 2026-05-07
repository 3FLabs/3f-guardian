import { describe, expect, it } from "vitest";

import { ENDPOINT_SCOPES, RateLimitedError, type TokenInfo } from "@3flabs/guardian";

import { inMemoryRateLimiter } from "../src/rate-limit/in-memory.js";

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
});
