import { describe, expect, it } from "vitest";

import {
  checkDeadline,
  checkMembership,
  checkNonceWindow,
  checkSwapPriceTolerance,
  rollUp,
} from "../src/checks/helpers.js";

describe("checkMembership", () => {
  it("passes when value is in the accepted set (case-insensitive for addresses)", () => {
    const r = checkMembership({
      description: "x in S",
      value: "0xAbCdEf0000000000000000000000000000000001",
      accepted: new Set(["0xabcdef0000000000000000000000000000000001"]),
      addressLike: true,
    });
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(false);
  });

  it("fails when value is not in the accepted set", () => {
    const r = checkMembership({
      description: "x in S",
      value: "0xdead",
      accepted: new Set(["0xbeef"]),
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("0xdead");
  });
});

describe("checkDeadline", () => {
  it("passes when deadline is within the ceiling", () => {
    const r = checkDeadline({
      nowUnixSeconds: 1_700_000_000,
      deadline: 1_700_000_500,
      maxSecondsAhead: 600,
    });
    expect(r.passed).toBe(true);
  });

  it("passes at exact ceiling (inclusive)", () => {
    const r = checkDeadline({
      nowUnixSeconds: 1_700_000_000,
      deadline: 1_700_000_600,
      maxSecondsAhead: 600,
    });
    expect(r.passed).toBe(true);
  });

  it("fails one second past the ceiling", () => {
    const r = checkDeadline({
      nowUnixSeconds: 1_700_000_000,
      deadline: 1_700_000_601,
      maxSecondsAhead: 600,
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/exceeds ceiling 1700000600/);
  });
});

describe("checkSwapPriceTolerance", () => {
  it("passes when ratio matches the reference exactly", () => {
    // amountA / amountB == 2.0 ; reference = 2e18
    const r = checkSwapPriceTolerance({
      amountA: 2_000_000n,
      amountB: 1_000_000n,
      referencePriceWad: 2_000_000_000_000_000_000n,
      toleranceBps: 5,
    });
    expect(r.passed).toBe(true);
  });

  it("passes within tolerance (+5bps)", () => {
    // observed = 2.001 ; reference = 2.0 ; deviation = 0.001 / 2.0 = 5bps exactly
    const r = checkSwapPriceTolerance({
      amountA: 2_001_000_000_000_000_000n,
      amountB: 1_000_000_000_000_000_000n,
      referencePriceWad: 2_000_000_000_000_000_000n,
      toleranceBps: 5,
    });
    expect(r.passed).toBe(true);
  });

  it("fails just outside tolerance (6bps with 5bps cap)", () => {
    // observed = 2.0012 ; reference = 2.0 ; deviation = 6bps
    const r = checkSwapPriceTolerance({
      amountA: 2_001_200_000_000_000_000n,
      amountB: 1_000_000_000_000_000_000n,
      referencePriceWad: 2_000_000_000_000_000_000n,
      toleranceBps: 5,
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("deviates");
  });

  it("rejects amountB == 0 with a descriptive reason", () => {
    const r = checkSwapPriceTolerance({
      amountA: 1n,
      amountB: 0n,
      referencePriceWad: 1n,
      toleranceBps: 5,
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("zero");
  });
});

describe("checkNonceWindow", () => {
  it("returns three passing entries for a fresh nonce within the window", () => {
    const entries = checkNonceWindow({
      nonce: 100n,
      consumed: false,
      floor: 50n,
      maxAboveFloor: 1000n,
    });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.passed)).toBe(true);
  });

  it("flags consumed nonce", () => {
    const entries = checkNonceWindow({
      nonce: 100n,
      consumed: true,
      floor: 50n,
      maxAboveFloor: 1000n,
    });
    expect(entries[0]?.passed).toBe(false);
    expect(entries[1]?.passed).toBe(true);
    expect(entries[2]?.passed).toBe(true);
  });

  it("accepts nonce == floor (on-chain rejects only nonce < floor)", () => {
    const entries = checkNonceWindow({
      nonce: 50n,
      consumed: false,
      floor: 50n,
      maxAboveFloor: 1000n,
    });
    expect(entries[0]?.passed).toBe(true);
    expect(entries[1]?.passed).toBe(true);
    expect(entries[2]?.passed).toBe(true);
  });

  it("flags nonce < floor", () => {
    const entries = checkNonceWindow({
      nonce: 49n,
      consumed: false,
      floor: 50n,
      maxAboveFloor: 1000n,
    });
    expect(entries[0]?.passed).toBe(true);
    expect(entries[1]?.passed).toBe(false);
  });

  it("flags nonce > floor + maxAboveFloor", () => {
    const entries = checkNonceWindow({
      nonce: 1051n,
      consumed: false,
      floor: 50n,
      maxAboveFloor: 1000n,
    });
    expect(entries[0]?.passed).toBe(true);
    expect(entries[1]?.passed).toBe(true);
    expect(entries[2]?.passed).toBe(false);
  });
});

describe("rollUp", () => {
  it("returns ok when every entry passed", () => {
    const r = rollUp([
      { description: "a", passed: true, skipped: false },
      { description: "b", passed: true, skipped: true },
    ]);
    expect(r.ok).toBe(true);
  });

  it("returns a ValidationFailedError carrying every entry when any failed", () => {
    const r = rollUp([
      { description: "a", passed: true, skipped: false },
      { description: "b", passed: false, skipped: false, reason: "nope" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.checks).toHaveLength(2);
      expect(r.error.checks[1]?.reason).toBe("nope");
    }
  });
});
