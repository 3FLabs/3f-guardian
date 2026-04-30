import { matchError } from "better-result";
import type { ErrorCode, ErrorEnvelope } from "../schemas/responses.ts";
import type { CheckEntry } from "../schemas/checks.ts";
import type { GuardianError } from "./tagged.ts";

export type ResolvedError = {
  status: number;
  envelope: ErrorEnvelope;
  retryAfterSeconds?: number;
};

/**
 * Build a §6.5 envelope from a tagged GuardianError.
 *
 * Exhaustive over the union: adding a new tag in `tagged.ts` will fail
 * type-check until handled here.
 */
export function resolveError(err: GuardianError, requestId: string): ResolvedError {
  return matchError(err, {
    Unauthenticated: (e): ResolvedError => ({
      status: 401,
      envelope: envelope("unauthenticated", e.message, requestId),
    }),
    Forbidden: (e): ResolvedError => ({
      // §5.2: MUST NOT reveal which scopes the token holds.
      status: 403,
      envelope: envelope("forbidden", e.message, requestId),
    }),
    BadRequest: (e): ResolvedError => ({
      status: 400,
      envelope: envelope("bad_request", e.message, requestId, e.details),
    }),
    UnsupportedMediaType: (e): ResolvedError => ({
      // §6.1 — 415 has no machine-readable code in §6.5; reuse bad_request
      // since it's the closest "client malformed the request" code.
      status: 415,
      envelope: envelope("bad_request", e.message, requestId),
    }),
    UnsupportedChain: (e): ResolvedError => ({
      status: 400,
      envelope: envelope("unsupported_chain", e.message, requestId, {
        chainId: e.chainId,
      }),
    }),
    NotFound: (e): ResolvedError => ({
      status: 404,
      envelope: envelope("not_found", e.message, requestId, e.details),
    }),
    StateConflict: (e): ResolvedError => ({
      status: 409,
      envelope: envelopeWithChecks("state_conflict", e.message, requestId, e.checks),
    }),
    ValidationFailed: (e): ResolvedError => ({
      status: 422,
      envelope: envelopeWithChecks("validation_failed", e.message, requestId, e.checks),
    }),
    RateLimited: (e): ResolvedError => ({
      status: 429,
      envelope: envelope("rate_limited", e.message, requestId),
      retryAfterSeconds: e.retryAfterSeconds,
    }),
    InternalError: (e): ResolvedError => ({
      status: 500,
      envelope: envelope("internal_error", e.message, requestId),
    }),
    UpstreamUnavailable: (e): ResolvedError => ({
      status: e.status,
      envelope: envelope("upstream_unavailable", e.message, requestId),
    }),
  });
}

function envelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    error: code,
    message,
    requestId,
    ...(details !== undefined && { details }),
  };
}

function envelopeWithChecks(
  code: ErrorCode,
  message: string,
  requestId: string,
  checks: CheckEntry[],
): ErrorEnvelope {
  return {
    error: code,
    message,
    requestId,
    checks,
  };
}
