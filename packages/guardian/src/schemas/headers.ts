import { z } from "zod";
import { zClientName, zSemver } from "./primitives.js";

/**
 * Request headers validated on every protected /v1/* route and rendered
 * as OpenAPI `parameters`. The §6.2 client-identification headers are
 * required; missing or malformed values yield 400 bad_request (auth
 * still runs first — the auth derive precedes validation, so 401/403
 * preempt header 400s per §6.6).
 *
 * Deliberately NOT format-validated here:
 *  - `authorization` — enforced by the auth derive (§5.1 → 401) and
 *    documented by the OpenAPI `bearerAuth` security scheme.
 *  - `x-request-id` — §3.7: a malformed id is replaced with a generated
 *    one, never rejected.
 *  - `x-guardian-timestamp` / `x-guardian-signature` — every §5.4 HMAC
 *    failure maps to 401 unauthenticated (§5.4.3), so their format is
 *    checked by the auth plugin; schema validation would wrongly 400.
 */
export const zProtectedRequestHeaders = z
  .object({
    "x-client-name": zClientName.describe("Identifier of the calling client application (§6.2)."),
    "x-client-version": zSemver.describe("Semver of the calling client (§6.2)."),
    "x-request-id": z
      .string()
      .optional()
      .describe("Caller-supplied UUID echoed in response. Generated if absent or malformed."),
    "x-guardian-timestamp": z
      .string()
      .optional()
      .describe(
        "Unix seconds, decimal ASCII. Required iff token is HMAC-flagged; " +
          "violations yield 401 (§5.4).",
      ),
    "x-guardian-signature": z
      .string()
      .optional()
      .describe(
        "Lower-case hex HMAC-SHA256 over timestamp + body. Required iff " +
          "token is HMAC-flagged; violations yield 401 (§5.4).",
      ),
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
