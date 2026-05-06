import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const TEXT = new TextEncoder();

/**
 * §5.4.2 — compute HMAC-SHA-256(secret, "<unix_seconds_ascii>.<raw_body>")
 * and return lower-case hex.
 *
 * `rawBody` is the EXACT byte sequence of the request body as transmitted on
 * the wire, before any decompression or framing. Empty body for GET, with
 * the dot still present.
 */
export function computeBodyHmacHex(
  secret: string,
  unixSecondsAscii: string,
  rawBody: Uint8Array,
): string {
  const prefix = TEXT.encode(`${unixSecondsAscii}.`);
  const message = new Uint8Array(prefix.length + rawBody.length);
  message.set(prefix, 0);
  message.set(rawBody, prefix.length);
  return bytesToHex(hmac(sha256, TEXT.encode(secret), message));
}

/**
 * Constant-time comparison of two equal-length lower-case hex strings.
 * Both inputs MUST already be the same length; callers MUST validate this
 * up-front (the length itself is not a secret).
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
