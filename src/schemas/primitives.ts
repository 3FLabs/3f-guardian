import { z } from "zod";
import type { Address, Hex } from "viem";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CLIENT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const UINT_DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

export const zAddress = z
  .string()
  .regex(ADDRESS_RE, "Address must be 0x-prefixed 20 bytes of hex")
  .transform((v): Address => v.toLowerCase() as Address)
  .describe("EVM address (§3.2). Accepted in any case; lower-cased internally.");

export const zHash32 = z
  .string()
  .regex(HASH32_RE, "Must be 0x-prefixed 32 bytes of hex")
  .transform((v): Hex => v.toLowerCase() as Hex)
  .describe("32-byte hash, lower-case hex (§3.4).");

export const zSignature = z
  .string()
  .regex(SIGNATURE_RE, "Must be 0x-prefixed 65 bytes of hex (r ‖ s ‖ v)")
  .transform((v): Hex => v.toLowerCase() as Hex)
  .describe("ECDSA signature, lower-case hex (§3.5).");

export const zChainId = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("EIP-155 chain id (§3.3).");

export const zUuid = z
  .string()
  .regex(UUID_RE, "Must be canonical hyphenated lower-case RFC 4122 UUID")
  .describe("RFC 4122 UUID (§3.7).");

export const zRfc3339Utc = z
  .string()
  .regex(RFC3339_UTC_RE, "Must be RFC 3339 UTC timestamp ending in literal Z")
  .describe("RFC 3339 UTC timestamp (§3.6).");

export const zSemver = z.string().regex(SEMVER_RE, "Must be a Semantic Version 2.0.0 string");

export const zClientName = z
  .string()
  .regex(CLIENT_NAME_RE, "X-Client-Name must be 1-64 chars from [A-Za-z0-9._-]");

const MAX_UINT256 = 2n ** 256n - 1n;

export const zUintString = z
  .string()
  .regex(UINT_DECIMAL_RE, "Must be a decimal integer string with no leading zeros (except '0')")
  .refine((v) => BigInt(v) <= MAX_UINT256, {
    message: "Value exceeds uint256",
  })
  .describe(
    "Unbounded non-negative integer encoded as decimal digits (§3.3). MUST fit in uint256.",
  );

export const zUintStringBelowMax = z
  .string()
  .regex(UINT_DECIMAL_RE, "Must be a decimal integer string")
  .refine((v) => BigInt(v) < MAX_UINT256, {
    message: "Value 2^256 - 1 is reserved as a sentinel",
  })
  .describe("Like zUintString, but rejects the sentinel 2^256 − 1.");

export const zDeadlineSeconds = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Unix timestamp in seconds (§7.7).");

export const zUnixSecondsString = z
  .string()
  .regex(/^\d+$/, "Must be ASCII decimal Unix seconds")
  .describe("Unix seconds, decimal ASCII (§5.4.2).");

export const zHexLower = z.string().regex(/^[0-9a-f]+$/, "Must be lower-case hex");
