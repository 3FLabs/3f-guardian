import { z } from "zod";
import { zAddress, zHash32, zRfc3339Utc, zSignature, zUuid } from "./primitives.js";
import { zChecks } from "./checks.js";

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

/**
 * Per-status error envelope schemas. Each value is `zErrorEnvelope` carrying
 * a status-specific `description` so the generated OpenAPI document renders
 * a meaningful summary on every error response (rather than the generic
 * "Error envelope (§6.5)." inherited from the base schema).
 *
 * Routes spread the relevant subset into their `response` map:
 *
 *   response: {
 *     200: zSigningSuccess,
 *     ...pickErrorResponses([400, 401, 403, 404, 422, 429, 500, 502, 503]),
 *   }
 */
export const errorResponses = {
  400: zErrorEnvelope.describe(
    "`bad_request` / `unsupported_chain` — Malformed body or headers, or `chainId` not in `supportedChains`.",
  ),
  401: zErrorEnvelope.describe(
    "`unauthenticated` — Missing/invalid bearer token, or HMAC verification failure when the token is HMAC-flagged (§5.4).",
  ),
  403: zErrorEnvelope.describe(
    "`forbidden` — The authenticated token lacks the endpoint scope required for this route.",
  ),
  404: zErrorEnvelope.describe(
    "`not_found` — Unknown route or unresolved on-chain reference (e.g. unknown intent id).",
  ),
  409: zErrorEnvelope.describe(
    "`state_conflict` — On-chain state incompatible with the request (transient). Per §6.6.1 returned only when the §A.2 fund-state check fails alone.",
  ),
  422: zErrorEnvelope.describe(
    "`validation_failed` — One or more policy checks failed. The `checks` array enumerates each check's outcome.",
  ),
  429: zErrorEnvelope.describe(
    "`rate_limited` — Per-token rate limit exceeded; honour the `Retry-After` response header.",
  ),
  500: zErrorEnvelope.describe(
    "`internal_error` — Guardian-side failure unrelated to the caller's input.",
  ),
  502: zErrorEnvelope.describe(
    "`upstream_unavailable` — Upstream RPC or dependency returned an error.",
  ),
  503: zErrorEnvelope.describe(
    "`upstream_unavailable` — Guardian or its upstream is unavailable; honour the `Retry-After` response header.",
  ),
} as const;

export type ErrorStatus = keyof typeof errorResponses;

export function pickErrorResponses<S extends ErrorStatus>(
  statuses: readonly S[],
): { [K in S]: (typeof errorResponses)[K] } {
  const out = {} as { [K in S]: (typeof errorResponses)[K] };
  for (const s of statuses) out[s] = errorResponses[s];
  return out;
}
