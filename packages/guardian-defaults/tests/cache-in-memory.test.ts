import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DEFAULT_MAX_ENTRIES, inMemoryCache } from "../src/cache/in-memory.js";
import { AsyncCache } from "../src/cache/types.js";

describe("inMemoryCache", () => {
  it("returns undefined for an unknown key", async () => {
    const cache = inMemoryCache(z.number());
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("stores and returns a value", async () => {
    const cache = inMemoryCache(z.object({ a: z.number() }));
    await cache.set("k", { a: 1 });
    expect(await cache.get("k")).toEqual({ a: 1 });
  });

  it("infers the value type from the schema output", async () => {
    const cache = inMemoryCache(z.object({ a: z.number() }));
    await cache.set("k", { a: 1 });
    const hit = await cache.get("k");
    // Type-level assertion: `hit` is `{ a: number } | undefined`.
    const typed: { a: number } | undefined = hit;
    expect(typed?.a).toBe(1);
  });

  it("treats a stored value that fails schema validation as a miss", async () => {
    const cache = inMemoryCache(z.number());
    await cache.set("k", "poison" as unknown as number);
    expect(await cache.get("k")).toBeUndefined();
  });

  it("returns undefined after the per-call ttlMs expires", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache(z.string(), { now: () => now });
    await cache.set("k", "v", { ttlMs: 1_000 });
    expect(await cache.get("k")).toBe("v");
    now += 999;
    expect(await cache.get("k")).toBe("v");
    now += 2;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("applies defaultTtlMs when no per-call ttl is supplied", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache(z.string(), { defaultTtlMs: 500, now: () => now });
    await cache.set("k", "v");
    now += 499;
    expect(await cache.get("k")).toBe("v");
    now += 2;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("per-call ttlMs overrides defaultTtlMs", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache(z.string(), { defaultTtlMs: 100, now: () => now });
    await cache.set("k", "v", { ttlMs: 10_000 });
    now += 5_000;
    expect(await cache.get("k")).toBe("v");
  });

  it("keeps entries forever when no ttl is configured", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache(z.string(), { now: () => now });
    await cache.set("k", "v");
    now += 365 * 24 * 60 * 60 * 1000;
    expect(await cache.get("k")).toBe("v");
  });

  it("delete removes an entry and is idempotent", async () => {
    const cache = inMemoryCache(z.string());
    await cache.set("k", "v");
    await cache.delete("k");
    expect(await cache.get("k")).toBeUndefined();
    await cache.delete("k"); // no throw
  });

  it("evicts oldest entries when maxEntries is exceeded", async () => {
    const cache = inMemoryCache(z.number(), { maxEntries: 2 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);
    expect(await cache.get("a")).toBeUndefined(); // evicted
    expect(await cache.get("b")).toBe(2);
    expect(await cache.get("c")).toBe(3);
  });

  it("re-setting a key refreshes its insertion order", async () => {
    const cache = inMemoryCache(z.number(), { maxEntries: 2 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("a", 11); // refreshes a → now b is the oldest
    await cache.set("c", 3);
    expect(await cache.get("a")).toBe(11);
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBe(3);
  });

  it("rejects an invalid defaultTtlMs", () => {
    expect(() => inMemoryCache(z.string(), { defaultTtlMs: 0 })).toThrow();
    expect(() => inMemoryCache(z.string(), { defaultTtlMs: -1 })).toThrow();
  });

  it("rejects an invalid maxEntries", () => {
    expect(() => inMemoryCache(z.string(), { maxEntries: -1 })).toThrow();
    expect(() => inMemoryCache(z.string(), { maxEntries: 1.5 })).toThrow();
  });

  it("bounds a zero-config cache at DEFAULT_MAX_ENTRIES entries", async () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(4096);
    const cache = inMemoryCache(z.number());
    for (let i = 0; i <= DEFAULT_MAX_ENTRIES; i++) {
      await cache.set(`k${i}`, i);
    }
    expect(await cache.get("k0")).toBeUndefined(); // oldest evicted
    expect(await cache.get("k1")).toBe(1);
    expect(await cache.get(`k${DEFAULT_MAX_ENTRIES}`)).toBe(DEFAULT_MAX_ENTRIES);
  });

  it("explicit maxEntries: 0 opts into unbounded growth", async () => {
    const cache = inMemoryCache(z.number(), { maxEntries: 0 });
    for (let i = 0; i <= DEFAULT_MAX_ENTRIES; i++) {
      await cache.set(`k${i}`, i);
    }
    expect(await cache.get("k0")).toBe(0);
    expect(await cache.get(`k${DEFAULT_MAX_ENTRIES}`)).toBe(DEFAULT_MAX_ENTRIES);
  });

  it("set rejects an invalid per-call ttlMs and leaves existing entries intact", async () => {
    let now = 1_000_000;
    const cache = inMemoryCache(z.string(), { now: () => now });
    await cache.set("k", "v", { ttlMs: 1_000 });

    await expect(cache.set("k", "evil", { ttlMs: Number.NaN })).rejects.toThrow();
    await expect(cache.set("k", "evil", { ttlMs: 0 })).rejects.toThrow();
    await expect(cache.set("k", "evil", { ttlMs: -5 })).rejects.toThrow();
    await expect(cache.set("k", "evil", { ttlMs: Number.POSITIVE_INFINITY })).rejects.toThrow();

    // The original entry is untouched by the rejected writes...
    expect(await cache.get("k")).toBe("v");
    // ...and still expires normally — no immortal NaN entry was created.
    now += 1_001;
    expect(await cache.get("k")).toBeUndefined();
  });
});

describe("AsyncCache (abstract base)", () => {
  // Minimal transport-style subclass: JSON round-trip with a Map/bigint
  // revival boundary, the shape a Redis/KV adapter would take. The base
  // class owns `get`; the subclass only provides raw storage.
  const zEntry = z.object({ owner: z.string(), nonce: z.bigint() });
  type Entry = z.output<typeof zEntry>;

  class JsonBackedCache extends AsyncCache<Entry> {
    readonly store = new Map<string, string>();

    constructor() {
      super(zEntry);
    }

    protected override async rawGet(key: string): Promise<unknown> {
      const raw = this.store.get(key);
      if (raw === undefined) return undefined;
      return JSON.parse(raw, (k, v) => (k === "nonce" ? BigInt(v as string) : v)) as unknown;
    }

    override async set(key: string, value: Entry): Promise<void> {
      this.store.set(
        key,
        JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
      );
    }

    override async delete(key: string): Promise<void> {
      this.store.delete(key);
    }
  }

  it("validates a revived raw hit through the schema", async () => {
    const cache = new JsonBackedCache();
    await cache.set("k", { owner: "0xabc", nonce: 7n });
    expect(await cache.get("k")).toEqual({ owner: "0xabc", nonce: 7n });
  });

  it("reports a raw value that fails validation as a miss, not a hit", async () => {
    const cache = new JsonBackedCache();
    // Simulate a poisoned / legacy-version entry already in the store.
    cache.store.set("k", JSON.stringify({ owner: 42, wrong: true }));
    expect(await cache.get("k")).toBeUndefined();
  });

  it("keeps undefined from rawGet as a plain miss without invoking validation", async () => {
    const probe = z.unknown().refine(() => {
      throw new Error("validate must not run on a miss");
    });
    class MissCache extends AsyncCache<unknown> {
      constructor() {
        super(probe);
      }
      protected override async rawGet(): Promise<unknown> {
        return undefined;
      }
      override async set(): Promise<void> {}
      override async delete(): Promise<void> {}
    }
    expect(await new MissCache().get("anything")).toBeUndefined();
  });
});
