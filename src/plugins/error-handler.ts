import { Elysia, ValidationError } from "elysia";

import { resolveError } from "../errors/envelope.ts";
import {
  BadRequestError,
  InternalError,
  type GuardianError,
  isGuardianErrorTag,
} from "../errors/tagged.ts";
import { resolveRequestId } from "../lib/request-id.ts";
import { PROTECTED_RESPONSE_HEADERS } from "../schemas/headers.ts";

/**
 * Single global error handler. Maps:
 *  - Guardian tagged errors → §6.5 envelope at the right status,
 *  - Elysia validation errors (zod or schema) → 400 bad_request,
 *  - any other thrown value → 500 internal_error (no detail leaked).
 *
 * Always sets X-Request-Id and the JSON content type.
 */
export const errorHandlerPlugin = new Elysia({ name: "guardian:error-handler" })
  .onError({ as: "global" }, ({ error, set, request }) => {
    const requestId =
      // The request-id plugin runs `derive` which is post-onRequest; for
      // very early errors the response header may already be set, but
      // for safety we resolve again here from the raw header.
      (set.headers[PROTECTED_RESPONSE_HEADERS.REQUEST_ID] as string | undefined) ??
      resolveRequestId(request.headers.get("x-request-id") ?? undefined);
    set.headers[PROTECTED_RESPONSE_HEADERS.REQUEST_ID] = requestId;
    set.headers["Content-Type"] = "application/json; charset=utf-8";

    const guardianError = toGuardianError(error);
    const resolved = resolveError(guardianError, requestId);
    set.status = resolved.status;
    if (resolved.retryAfterSeconds !== undefined) {
      set.headers[PROTECTED_RESPONSE_HEADERS.RETRY_AFTER] = String(resolved.retryAfterSeconds);
    }
    return resolved.envelope;
  })
  .as("scoped");

function toGuardianError(thrown: unknown): GuardianError {
  if (thrown instanceof ValidationError) {
    return new BadRequestError({
      message: thrown.message,
      details: { schema: thrown.type },
    });
  }
  if (isGuardianErrorTag(thrown)) return thrown;
  // SyntaxError from JSON.parse, malformed body parser output, etc.
  if (thrown instanceof SyntaxError) {
    return new BadRequestError({ message: `Malformed JSON: ${thrown.message}` });
  }
  return new InternalError({
    message: thrown instanceof Error ? thrown.message : "Unexpected Guardian-side failure",
  });
}
