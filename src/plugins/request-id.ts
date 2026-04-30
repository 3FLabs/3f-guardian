import { Elysia } from "elysia";
import { resolveRequestId } from "../lib/request-id.ts";
import { PROTECTED_RESPONSE_HEADERS } from "../schemas/headers.ts";

/**
 * Resolves §3.7 X-Request-Id and exposes it as `requestId` on the
 * Elysia context. Always present, always echoed in the response header.
 */
export const requestIdPlugin = new Elysia({ name: "guardian:request-id" })
  .derive({ as: "global" }, ({ request, set }) => {
    const requestId = resolveRequestId(request.headers.get("x-request-id") ?? undefined);
    set.headers[PROTECTED_RESPONSE_HEADERS.REQUEST_ID] = requestId;
    return { requestId };
  })
  .as("scoped");
