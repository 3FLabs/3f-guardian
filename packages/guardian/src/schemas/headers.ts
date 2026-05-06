import { z } from "zod";
import { zClientName, zSemver, zUnixSecondsString, zUuid } from "./primitives.js";

const HEX_HMAC_RE = /^[0-9a-f]{64}$/;

export const zProtectedRequestHeaders = z
  .object({
    authorization: z
      .string()
      .regex(/^Bearer .+$/i, "Authorization MUST be 'Bearer <token>'")
      .describe("Bearer token (§5.1)."),
    "x-client-name": zClientName.describe("Identifier of the calling client application (§6.2)."),
    "x-client-version": zSemver.describe("Semver of the calling client (§6.2)."),
    "x-request-id": zUuid
      .optional()
      .describe("Caller-supplied UUID echoed in response. Generated if absent or malformed."),
    "x-guardian-timestamp": zUnixSecondsString
      .optional()
      .describe("Required iff token is HMAC-flagged (§5.4)."),
    "x-guardian-signature": z
      .string()
      .regex(HEX_HMAC_RE, "Must be 64 lower-case hex chars")
      .optional()
      .describe("Required iff token is HMAC-flagged (§5.4)."),
  })
  // Intentionally NOT strict: HTTP frameworks always inject extra headers
  // (host, content-length, accept-encoding...). We only validate the ones we
  // care about and ignore the rest.
  .passthrough();

export type ProtectedRequestHeaders = z.infer<typeof zProtectedRequestHeaders>;

export const PROTECTED_RESPONSE_HEADERS = {
  REQUEST_ID: "X-Request-Id",
  GUARDIAN_VERSION: "X-Guardian-Version",
  RATELIMIT_LIMIT: "X-RateLimit-Limit",
  RATELIMIT_REMAINING: "X-RateLimit-Remaining",
  RATELIMIT_RESET: "X-RateLimit-Reset",
  RETRY_AFTER: "Retry-After",
} as const;
