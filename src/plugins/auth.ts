import { Elysia } from "elysia";

import type { EndpointScope, GuardianAbstractions, TokenInfo } from "../abstractions.ts";
import { ForbiddenError, RateLimitedError, UnauthenticatedError } from "../errors/tagged.ts";
import { computeBodyHmacHex, timingSafeEqualHex } from "../lib/hmac.ts";
import { nowUnixSeconds } from "../lib/time.ts";
import { PROTECTED_RESPONSE_HEADERS } from "../schemas/headers.ts";
import { rawBodyPlugin } from "./raw-body.ts";
import { requestIdPlugin } from "./request-id.ts";

const HMAC_TIMESTAMP_TOLERANCE_SECONDS = 60;

/**
 * §5.1, §5.2, §5.3, §5.4 — bearer token + optional HMAC body signing,
 * plus per-route scope check. §6.3 X-RateLimit-* headers.
 *
 * Returns an Elysia plugin factory that, when given a `requiredScope`,
 * yields a scoped plugin to install on each protected route group.
 *
 * Implementation notes:
 *  - All HMAC validation failures share §5.4.3 unauthenticated; the
 *    specific cause is conveyed by `message` only.
 *  - Constant-time HMAC comparison uses `timingSafeEqualHex` after a
 *    cheap length pre-check — the length of a hex-encoded 32-byte MAC
 *    is not a secret.
 *  - `accountRateLimit` is invoked AFTER auth succeeds (otherwise an
 *    unauthenticated attacker could probe rate-limit state).
 */
export function makeAuthPlugin(abs: GuardianAbstractions) {
  return (requiredScope: EndpointScope) =>
    new Elysia({ name: `guardian:auth:${requiredScope}` })
      // Bring rawBody (§5.4) and requestId (§3.7) into scope. Plugins
      // dedupe by `name`, so installing them here AND at the server
      // level is safe.
      .use(rawBodyPlugin)
      .use(requestIdPlugin)
      // `.derive` runs in the transform phase, BEFORE body/header
      // validation. We need 401 / 403 to take priority over body 400s
      // (matches §6.6 ordering: auth comes first), so the auth check
      // must run pre-validation.
      .derive({ as: "scoped" }, async ({ request, rawBody, set }) => {
        const authz = request.headers.get("authorization");
        if (!authz || !authz.toLowerCase().startsWith("bearer ")) {
          throw new UnauthenticatedError({
            message: "Missing or malformed Authorization header (§5.1).",
          });
        }
        const token = authz.slice("bearer ".length).trim();
        if (token.length === 0) {
          throw new UnauthenticatedError({
            message: "Empty bearer token (§5.1).",
          });
        }

        const authResult = await abs.authenticate(token);
        if (authResult.isErr()) throw authResult.error;
        const tokenInfo = authResult.value;

        // §5.2 — scope check. MUST NOT reveal which scopes the token holds.
        if (!tokenInfo.scopes.has(requiredScope)) {
          throw new ForbiddenError({
            message: "Token lacks the scope required by this endpoint (§5.2).",
          });
        }

        if (tokenInfo.requiresHmac) {
          verifyHmac({
            request,
            rawBody,
            secret: requireSecret(tokenInfo),
          });
        }

        if (abs.accountRateLimit) {
          const window = await abs.accountRateLimit(tokenInfo);
          if (window.isErr()) {
            const e = window.error;
            if (e instanceof RateLimitedError) {
              set.headers[PROTECTED_RESPONSE_HEADERS.RETRY_AFTER] = String(e.retryAfterSeconds);
            }
            throw e;
          }
          set.headers[PROTECTED_RESPONSE_HEADERS.RATELIMIT_LIMIT] = String(window.value.limit);
          set.headers[PROTECTED_RESPONSE_HEADERS.RATELIMIT_REMAINING] = String(
            window.value.remaining,
          );
          set.headers[PROTECTED_RESPONSE_HEADERS.RATELIMIT_RESET] = String(
            window.value.resetUnixSeconds,
          );
        }

        return { tokenInfo };
      })
      .as("scoped");
}

function requireSecret(token: TokenInfo): string {
  if (!token.hmacSecret) {
    // The contract is that authenticate() returns hmacSecret iff
    // requiresHmac is true. A violation is a Guardian-side bug, not a
    // caller-recoverable condition; surface it as 401 with a generic
    // message so we don't leak detail, but log internally.
    throw new UnauthenticatedError({
      message: "HMAC required but no secret configured (§5.4).",
    });
  }
  return token.hmacSecret;
}

function verifyHmac(args: { request: Request; rawBody: Uint8Array; secret: string }): void {
  const { request, rawBody, secret } = args;
  const tsHeader = request.headers.get("x-guardian-timestamp");
  const sigHeader = request.headers.get("x-guardian-signature");

  if (!tsHeader || !sigHeader) {
    throw new UnauthenticatedError({
      message:
        "X-Guardian-Timestamp and X-Guardian-Signature are required for " +
        "HMAC-flagged tokens (§5.4.2).",
    });
  }
  if (!/^\d+$/.test(tsHeader)) {
    throw new UnauthenticatedError({
      message: "X-Guardian-Timestamp MUST be ASCII decimal seconds (§5.4.2).",
    });
  }
  const timestamp = Number(tsHeader);
  const skew = Math.abs(nowUnixSeconds() - timestamp);
  if (skew > HMAC_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new UnauthenticatedError({
      message: `X-Guardian-Timestamp outside the ±${HMAC_TIMESTAMP_TOLERANCE_SECONDS}s window (§5.4.3).`,
    });
  }

  const expected = computeBodyHmacHex(secret, tsHeader, rawBody);
  if (!timingSafeEqualHex(expected, sigHeader.toLowerCase())) {
    throw new UnauthenticatedError({
      message: "X-Guardian-Signature did not match (§5.4.3).",
    });
  }
}
