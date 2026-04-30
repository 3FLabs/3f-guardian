import { z } from "zod";
import { zAddress, zHash32, zRfc3339Utc, zSignature, zUuid } from "./primitives.ts";
import { zChecks } from "./checks.ts";

export const zSigningSuccess = z
  .object({
    guardian: zAddress.describe("Guardian signer address. Equal to GET /version's guardianSigner."),
    signature: zSignature.describe("EIP-712 signature."),
    payloadHash: zHash32.describe(
      "EIP-712 digest. Provided so callers MAY cross-check the binding.",
    ),
    signedAt: zRfc3339Utc.describe("Informational. MUST NOT be relied upon for replay protection."),
    checks: zChecks,
  })
  .strict()
  .describe("Common signing success response (§6.4).");

export type SigningSuccess = z.infer<typeof zSigningSuccess>;

export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "bad_request",
  "not_found",
  "unsupported_chain",
  "state_conflict",
  "validation_failed",
  "rate_limited",
  "internal_error",
  "upstream_unavailable",
] as const;

export const zErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof zErrorCode>;

export const zErrorEnvelope = z
  .object({
    error: zErrorCode.describe("Stable machine-readable error code (§6.5)."),
    message: z.string().describe("Human-readable message; wording MAY change."),
    requestId: zUuid.describe("Echo of the X-Request-Id response header."),
    details: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Optional details object. Schema is specific to error code. " +
          "Callers MUST tolerate unknown keys.",
      ),
    checks: zChecks
      .optional()
      .describe("Present for validation_failed (always) and state_conflict (MAY)."),
  })
  .strict()
  .describe("Error envelope (§6.5).");

export type ErrorEnvelope = z.infer<typeof zErrorEnvelope>;
