import { describe, expect, it } from "vitest";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { computeBodyHmacHex, timingSafeEqualHex } from "../../src/lib/hmac.js";

describe("computeBodyHmacHex", () => {
  it("matches HMAC-SHA-256 over '<ts>.<body>' for a simple body", () => {
    const secret = "the-secret";
    const ts = "1700000000";
    const body = new TextEncoder().encode('{"hello":"world"}');

    const expected = bytesToHex(
      hmac(
        sha256,
        new TextEncoder().encode(secret),
        new TextEncoder().encode(`${ts}.${'{"hello":"world"}'}`),
      ),
    );

    expect(computeBodyHmacHex(secret, ts, body)).toBe(expected);
  });

  it("uses an empty body but keeps the dot separator (§5.4.2)", () => {
    const ts = "42";
    const empty = new Uint8Array(0);
    const expected = bytesToHex(
      hmac(sha256, new TextEncoder().encode("k"), new TextEncoder().encode(`${ts}.`)),
    );
    expect(computeBodyHmacHex("k", ts, empty)).toBe(expected);
  });

  it("includes raw bytes (does not re-stringify)", () => {
    // Raw bytes that are NOT valid UTF-8 must still be authenticated as-is.
    const naughty = new Uint8Array([0xff, 0xfe, 0xfd, 0x00]);
    const expected = bytesToHex(
      hmac(
        sha256,
        new TextEncoder().encode("k"),
        concat(new TextEncoder().encode("100."), naughty),
      ),
    );
    expect(computeBodyHmacHex("k", "100", naughty)).toBe(expected);
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
  });
  it("returns false for differing strings", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false);
  });
  it("returns false for different lengths without throwing", () => {
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
  });
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
