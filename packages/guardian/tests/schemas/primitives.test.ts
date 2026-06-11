import { describe, expect, it } from "vitest";

import {
  zAddress,
  zClientName,
  zHash32,
  zRfc3339Utc,
  zSemver,
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
  it("returns issues (not a thrown SyntaxError) for non-numeric input via safeParse", () => {
    // zod v4 checks are non-aborting: the uint256 refine runs even on
    // regex-rejected input, and an unguarded BigInt("1.5") would throw a
    // SyntaxError out of safeParse instead of reporting issues.
    for (const input of ["1.5", "1e9", "12abc"]) {
      let result: { success: boolean } | undefined;
      expect(() => {
        result = zUintString.safeParse(input);
      }).not.toThrow();
      expect(result?.success).toBe(false);
    }
  });
  it("rejects a 500k-digit string without throwing RangeError", () => {
    // Unguarded BigInt() threw RangeError on inputs this long, which the
    // server mapped to a 500; the length guard must fail cleanly instead.
    const huge = "9".repeat(500_000);
    let result: { success: boolean } | undefined;
    expect(() => {
      result = zUintString.safeParse(huge);
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });
  it("rejects a 200k-digit string without blocking the event loop", () => {
    // Without the in-predicate length guard, BigInt() on this input blocks
    // ~166ms; with it, validation is sub-millisecond. The generous bound
    // keeps the assertion stable on slow CI while still catching the block.
    const huge = "1".repeat(200_000);
    const start = performance.now();
    expect(zUintString.safeParse(huge).success).toBe(false);
    expect(performance.now() - start).toBeLessThan(100);
  });
  it("rejects 79-digit values (above the 78-digit uint256 ceiling)", () => {
    expect(zUintString.safeParse("9".repeat(79)).success).toBe(false);
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
  it("accepts 78-digit values below the sentinel (digit cap is 78, not 77)", () => {
    // 10^77 has 78 digits and is < 2^256 − 1 (~1.158 × 10^77); a 77-digit
    // length cap would wrongly reject every nonce in [10^77, 2^256 − 2].
    const seventyEightDigits = "1" + "0".repeat(77);
    expect(zUintStringBelowMax.parse(seventyEightDigits)).toBe(seventyEightDigits);
  });
  it("returns issues (not a thrown SyntaxError) for non-numeric input via safeParse", () => {
    let result: { success: boolean } | undefined;
    expect(() => {
      result = zUintStringBelowMax.safeParse("0x10");
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });
  it("rejects a 500k-digit string without throwing RangeError", () => {
    const huge = "9".repeat(500_000);
    let result: { success: boolean } | undefined;
    expect(() => {
      result = zUintStringBelowMax.safeParse(huge);
    }).not.toThrow();
    expect(result?.success).toBe(false);
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

describe("zSemver", () => {
  it("accepts plain release versions", () => {
    expect(zSemver.parse("1.0.0")).toBe("1.0.0");
    expect(zSemver.parse("0.0.0")).toBe("0.0.0");
    expect(zSemver.parse("10.20.30")).toBe("10.20.30");
  });
  it("accepts prerelease and build metadata that real clients send", () => {
    expect(zSemver.parse("2.1.3-rc.1+build.5")).toBe("2.1.3-rc.1+build.5");
    expect(zSemver.parse("1.0.0-alpha")).toBe("1.0.0-alpha");
    expect(zSemver.parse("1.0.0+20130313144700")).toBe("1.0.0+20130313144700");
  });
  it("rejects non-semver strings (the §6.2 X-Client-Version 400 contract)", () => {
    for (const input of ["banana", "1.0", "1", "v1.0.0", ""]) {
      expect(zSemver.safeParse(input).success).toBe(false);
    }
  });
  it("rejects leading zeros in numeric components", () => {
    expect(zSemver.safeParse("01.0.0").success).toBe(false);
    expect(zSemver.safeParse("1.00.0").success).toBe(false);
  });
  it("rejects whitespace and embedded-newline injection around a valid version", () => {
    for (const input of [" 1.0.0", "1.0.0 ", "1.0.0\n", "1.0.0\nbanana"]) {
      expect(zSemver.safeParse(input).success).toBe(false);
    }
  });
});

describe("zClientName", () => {
  it("accepts names from [A-Za-z0-9._-]", () => {
    expect(zClientName.parse("smoke-tests")).toBe("smoke-tests");
    expect(zClientName.parse("Client_1.beta")).toBe("Client_1.beta");
  });
  it("accepts a 64-char name and rejects 65 chars (boundary)", () => {
    expect(zClientName.parse("a".repeat(64))).toBe("a".repeat(64));
    expect(zClientName.safeParse("a".repeat(65)).success).toBe(false);
  });
  it("rejects the empty string", () => {
    expect(zClientName.safeParse("").success).toBe(false);
  });
  it("rejects names with spaces or characters outside the allowed set", () => {
    for (const input of ["my client", "client@1", "client/1", "client\n", "clïent"]) {
      expect(zClientName.safeParse(input).success).toBe(false);
    }
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
