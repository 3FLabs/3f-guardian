import { describe, expect, it } from "vitest";

import { inMemoryCache } from "../src/cache/in-memory.js";

describe("inMemoryCache", () => {
  it("returns undefined for an unknown key", async () => {
    const cache = inMemoryCache<number>();
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("stores and returns a value", async () => {
    const cache = inMemoryCache<{ a: number }>();
    await cache.set("k", { a: 1 });
    expect(await cache.get("k")).toEqual({ a: 1 });
  });

  it("returns undefined after the per-call ttlMs expires", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache<string>({ now: () => now });
    await cache.set("k", "v", { ttlMs: 1_000 });
    expect(await cache.get("k")).toBe("v");
    now += 999;
    expect(await cache.get("k")).toBe("v");
    now += 2;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("applies defaultTtlMs when no per-call ttl is supplied", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache<string>({ defaultTtlMs: 500, now: () => now });
    await cache.set("k", "v");
    now += 499;
    expect(await cache.get("k")).toBe("v");
    now += 2;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("per-call ttlMs overrides defaultTtlMs", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache<string>({ defaultTtlMs: 100, now: () => now });
    await cache.set("k", "v", { ttlMs: 10_000 });
    now += 5_000;
    expect(await cache.get("k")).toBe("v");
  });

  it("keeps entries forever when no ttl is configured", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache<string>({ now: () => now });
    await cache.set("k", "v");
    now += 365 * 24 * 60 * 60 * 1000;
    expect(await cache.get("k")).toBe("v");
  });

  it("delete removes an entry and is idempotent", async () => {
    const cache = inMemoryCache<string>();
    await cache.set("k", "v");
    await cache.delete("k");
    expect(await cache.get("k")).toBeUndefined();
    await cache.delete("k"); // no throw
  });

  it("evicts oldest entries when maxEntries is exceeded", async () => {
    const cache = inMemoryCache<number>({ maxEntries: 2 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);
    expect(await cache.get("a")).toBeUndefined(); // evicted
    expect(await cache.get("b")).toBe(2);
    expect(await cache.get("c")).toBe(3);
  });

  it("re-setting a key refreshes its insertion order", async () => {
    const cache = inMemoryCache<number>({ maxEntries: 2 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("a", 11); // refreshes a → now b is the oldest
    await cache.set("c", 3);
    expect(await cache.get("a")).toBe(11);
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBe(3);
  });

  it("rejects an invalid defaultTtlMs", () => {
    expect(() => inMemoryCache({ defaultTtlMs: 0 })).toThrow();
    expect(() => inMemoryCache({ defaultTtlMs: -1 })).toThrow();
  });

  it("rejects an invalid maxEntries", () => {
    expect(() => inMemoryCache({ maxEntries: -1 })).toThrow();
    expect(() => inMemoryCache({ maxEntries: 1.5 })).toThrow();
  });
});
