import { Elysia } from "elysia";

import { PayloadTooLargeError } from "../errors/tagged.js";

const EMPTY_BODY = new Uint8Array(0);
const TEXT_DECODER = new TextDecoder();

/**
 * Default cap on buffered request bodies (1 MiB). Every legitimate v1
 * body is a small JSON document; the cap bounds what an unauthenticated
 * caller can make the shell buffer, since the parse phase runs before
 * the auth derive. Overridable via `GuardianAbstractions.maxBodyBytes`.
 */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

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

function payloadTooLarge(maxBodyBytes: number): PayloadTooLargeError {
  return new PayloadTooLargeError({
    message: `Request body exceeds the ${maxBodyBytes}-byte limit.`,
  });
}

/**
 * Buffer the request body while counting bytes against `maxBodyBytes`,
 * so a chunked body (no Content-Length) is rejected as soon as it
 * crosses the cap instead of being buffered whole first.
 */
async function readBodyCapped(request: Request, maxBodyBytes: number): Promise<Uint8Array> {
  const stream = request.body;
  if (!stream) return EMPTY_BODY;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBodyBytes) {
      await reader.cancel().catch(() => {});
      throw payloadTooLarge(maxBodyBytes);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Captures the EXACT byte sequence of the request body before JSON
 * decoding so §5.4.2 HMAC verification can run over the unmodified
 * bytes. Stored on a module-private WeakMap keyed by Request.
 *
 * Only `application/json` and `text/*` bodies — the only content types
 * guardian routes accept — are consumed here; anything else is left
 * untouched so host-composed routes (multipart, urlencoded, ...) still
 * reach Elysia's own parser chain on an unconsumed stream.
 */
export function rawBodyPlugin(maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES) {
  // NaN (e.g. `Number()` of an unset env var) would silently disable the
  // cap — every `received > maxBodyBytes` comparison is false — while
  // 0 / negative would 413 every non-empty body. Reject loudly at
  // construction, matching the `inMemoryRateLimiter` / `inMemoryCache`
  // validation in guardian-defaults.
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError(`guardian: maxBodyBytes must be a positive integer, got ${maxBodyBytes}`);
  }
  return new Elysia({ name: "guardian:raw-body" })
    .onParse({ as: "global" }, async ({ request }, contentType) => {
      if (request.method === "GET" || request.method === "HEAD") {
        rawBodyByRequest.set(request, EMPTY_BODY);
        return;
      }
      // Media types are case-insensitive (RFC 7231 §3.1.1.1); lowercase
      // before matching, mirroring contentTypePlugin so the two gates
      // can never disagree.
      const ct = contentType.toLowerCase();
      const isJson = ct.startsWith("application/json");
      if (!isJson && !ct.startsWith("text/")) return;

      // Fast-path rejection before any buffering when the client
      // declares an oversized body up-front. It lives here — after the
      // content-type narrowing — rather than in an app-wide `onRequest`
      // gate: Elysia `request` events are not re-scoped by
      // `as("scoped")` and propagate unfiltered through `.use()`, so an
      // onRequest check would 413 e.g. multipart uploads on every route
      // of a composed host app even though guardian never buffers those
      // bodies. Chunked bodies (no Content-Length) are counted as they
      // stream in `readBodyCapped`.
      const declared = Number(request.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        throw payloadTooLarge(maxBodyBytes);
      }

      const bytes = await readBodyCapped(request, maxBodyBytes);
      rawBodyByRequest.set(request, bytes);

      if (isJson) {
        if (bytes.byteLength === 0) return {};
        return JSON.parse(TEXT_DECODER.decode(bytes));
      }
      return TEXT_DECODER.decode(bytes);
    })
    .derive({ as: "global" }, ({ request }) => ({
      rawBody: rawBodyByRequest.get(request) ?? EMPTY_BODY,
    }))
    .as("scoped");
}
