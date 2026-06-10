import { Elysia, ValidationError } from "elysia";

import { resolveError } from "../errors/envelope.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  type GuardianError,
  isGuardianErrorTag,
} from "../errors/tagged.js";
import { type Logger, noopLogger } from "../lib/logger.js";
import { resolveRequestId } from "../lib/request-id.js";
import { PROTECTED_RESPONSE_HEADERS } from "../schemas/headers.js";

/**
 * Single global error handler. Maps:
 *  - Guardian tagged errors → §6.5 envelope at the right status,
 *  - Elysia validation errors (zod or schema) → 400 bad_request,
 *  - Elysia router misses (code NOT_FOUND) → 404 not_found,
 *  - parse-phase failures (code PARSE) → 400 bad_request (or the tagged
 *    error wrapped as the ParseError's cause, e.g. 413),
 *  - any other thrown value → 500 internal_error (no detail leaked).
 *
 * Always sets X-Request-Id and the JSON content type. Logs unexpected
 * (non-tagged, non-validation) throws at error level so operators see
 * stack traces in their log pipeline; tagged errors are deliberately
 * NOT logged here — they're already logged at the point of throw with
 * the relevant per-domain context (auth plugin for auth failures,
 * abstraction implementations for signing failures).
 */
export function errorHandlerPlugin(logger: Logger | undefined) {
  const log = logger ?? noopLogger;
  return new Elysia({ name: "guardian:error-handler" })
    .onError({ as: "global" }, ({ code, error, set, request }) => {
      const requestId =
        // The request-id plugin runs `derive` which is post-onRequest; for
        // very early errors the response header may already be set, but
        // for safety we resolve again here from the raw header.
        (set.headers[PROTECTED_RESPONSE_HEADERS.REQUEST_ID] as string | undefined) ??
        resolveRequestId(request.headers.get("x-request-id") ?? undefined);
      set.headers[PROTECTED_RESPONSE_HEADERS.REQUEST_ID] = requestId;
      set.headers["Content-Type"] = "application/json; charset=utf-8";

      const guardianError = toGuardianError(error, code, log.child({ requestId }));
      const resolved = resolveError(guardianError, requestId);
      set.status = resolved.status;
      if (resolved.retryAfterSeconds !== undefined) {
        set.headers[PROTECTED_RESPONSE_HEADERS.RETRY_AFTER] = String(resolved.retryAfterSeconds);
      }
      return resolved.envelope;
    })
    .as("scoped");
}

function toGuardianError(thrown: unknown, code: unknown, log: Logger): GuardianError {
  if (thrown instanceof ValidationError) {
    return new BadRequestError({
      message: thrown.message,
      details: { schema: thrown.type },
    });
  }
  if (isGuardianErrorTag(thrown)) return thrown;
  // Elysia's router raises NOT_FOUND for unmatched paths AND for method
  // mismatches on known paths. Matched by `code` rather than instanceof
  // so the mapping survives a host composing with its own elysia copy.
  // Deliberately not logged at error level — route probes and typo'd
  // paths are not operator-actionable.
  if (code === "NOT_FOUND") {
    return new NotFoundError({ message: "Unknown route" });
  }
  // Any throw from a parse hook is wrapped by Elysia in ParseError
  // (code PARSE, message "Bad Request") with the original as `cause`.
  // Unwrap tagged causes (e.g. PayloadTooLargeError from the raw-body
  // cap) so they keep their own status mapping.
  if (code === "PARSE") {
    const cause = thrown instanceof Error ? thrown.cause : undefined;
    if (isGuardianErrorTag(cause)) return cause;
    return new BadRequestError({
      message:
        cause instanceof SyntaxError
          ? `Malformed JSON: ${cause.message}`
          : "Malformed request body",
    });
  }
  // Raw SyntaxError thrown from a handler / derive. No current code path
  // does this (parse-phase JSON.parse failures arrive as PARSE above);
  // kept as a backstop.
  if (thrown instanceof SyntaxError) {
    return new BadRequestError({ message: `Malformed JSON: ${thrown.message}` });
  }
  // Unknown throw — surface as 500 with no detail leaked, but log with
  // full context so operators can root-cause. The envelope message is
  // deliberately generic: host-side error messages routinely embed
  // connection strings, RPC URLs, or credentials.
  log.error(
    { err: thrown instanceof Error ? { message: thrown.message, stack: thrown.stack } : thrown },
    "guardian: unexpected error mapped to 500",
  );
  return new InternalError({ message: "Unexpected Guardian-side failure" });
}
