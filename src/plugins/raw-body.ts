import { Elysia } from "elysia";

const EMPTY_BODY = new Uint8Array(0);

/**
 * Per-request store for raw body bytes. Module-level WeakMap rather than
 * Elysia's `.state` because the latter is shared across the whole app
 * (one WeakMap per process is enough) and because derive-from-state
 * propagation across `as: "scoped"` plugin boundaries is brittle.
 *
 * Entries become unreachable once the `Request` is collected, so this
 * does not leak.
 */
const rawBodyByRequest = new WeakMap<Request, Uint8Array>();

/**
 * Captures the EXACT byte sequence of the request body before JSON
 * decoding so §5.4.2 HMAC verification can run over the unmodified
 * bytes. Stored on a module-private WeakMap keyed by Request.
 */
export const rawBodyPlugin = new Elysia({ name: "guardian:raw-body" })
  .onParse({ as: "global" }, async ({ request }, contentType) => {
    if (request.method === "GET" || request.method === "HEAD") {
      rawBodyByRequest.set(request, EMPTY_BODY);
      return;
    }
    const buffer = await request.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    rawBodyByRequest.set(request, bytes);

    if (contentType.startsWith("application/json")) {
      if (bytes.byteLength === 0) return {};
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    if (contentType.startsWith("text/")) {
      return new TextDecoder().decode(bytes);
    }
    return bytes;
  })
  .derive({ as: "global" }, ({ request }) => ({
    rawBody: rawBodyByRequest.get(request) ?? EMPTY_BODY,
  }))
  .as("scoped");
