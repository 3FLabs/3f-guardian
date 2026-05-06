import { describe, expect, it } from "vitest";

import {
  zAddress,
  zHash32,
  zRfc3339Utc,
  zSignature,
  zUintString,
  zUintStringBelowMax,
  zUuid,
} from "../../src/schemas/primitives.js";

describe("zAddress", () => {
  it("accepts mixed-case and lower-cases the output (§3.2)", () => {
    const out = zAddress.parse("0xAbC0000000000000000000000000000000000001");
    expect(out).toBe("0xabc0000000000000000000000000000000000001");
  });
  it("rejects wrong length", () => {
    expect(() => zAddress.parse("0xabc")).toThrow();
  });
  it("rejects missing 0x", () => {
    expect(() => zAddress.parse("abc0000000000000000000000000000000000001")).toThrow();
  });
});

describe("zHash32 / zSignature", () => {
  it("requires 64 hex chars for hash, 130 for sig", () => {
    expect(zHash32.parse("0x" + "a".repeat(64))).toBe("0x" + "a".repeat(64));
    expect(zSignature.parse("0x" + "a".repeat(130))).toBe("0x" + "a".repeat(130));
    expect(() => zHash32.parse("0x" + "a".repeat(63))).toThrow();
    expect(() => zSignature.parse("0x" + "a".repeat(129))).toThrow();
  });
});

describe("zUintString", () => {
  it("accepts '0' and large valid values", () => {
    expect(zUintString.parse("0")).toBe("0");
    expect(zUintString.parse("123456789")).toBe("123456789");
  });
  it("rejects leading zeros", () => {
    expect(() => zUintString.parse("01")).toThrow();
  });
  it("rejects values > 2^256 - 1", () => {
    const overMax = (2n ** 256n).toString();
    expect(() => zUintString.parse(overMax)).toThrow();
  });
  it("accepts the max uint256 value", () => {
    const max = (2n ** 256n - 1n).toString();
    expect(zUintString.parse(max)).toBe(max);
  });
  it("rejects whitespace", () => {
    expect(() => zUintString.parse(" 1")).toThrow();
  });
});

describe("zUintStringBelowMax", () => {
  it("rejects the sentinel 2^256 − 1", () => {
    const sentinel = (2n ** 256n - 1n).toString();
    expect(() => zUintStringBelowMax.parse(sentinel)).toThrow();
  });
  it("accepts one below the sentinel", () => {
    const ok = (2n ** 256n - 2n).toString();
    expect(zUintStringBelowMax.parse(ok)).toBe(ok);
  });
});

describe("zUuid", () => {
  it("accepts canonical lower-case UUIDs", () => {
    expect(zUuid.parse("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });
  it("rejects upper-case", () => {
    expect(() => zUuid.parse("550E8400-E29B-41D4-A716-446655440000")).toThrow();
  });
});

describe("zRfc3339Utc", () => {
  it("accepts Z suffix without sub-seconds", () => {
    expect(zRfc3339Utc.parse("2026-04-22T10:15:00Z")).toBe("2026-04-22T10:15:00Z");
  });
  it("accepts Z suffix with sub-seconds", () => {
    expect(zRfc3339Utc.parse("2026-04-22T10:15:00.123Z")).toBe("2026-04-22T10:15:00.123Z");
  });
  it("rejects offset suffix", () => {
    expect(() => zRfc3339Utc.parse("2026-04-22T10:15:00+02:00")).toThrow();
  });
});
