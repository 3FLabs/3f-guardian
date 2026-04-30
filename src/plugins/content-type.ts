import { Elysia } from "elysia";
import { UnsupportedMediaTypeError } from "../errors/tagged.ts";

/**
 * §6.1 — POST bodies MUST be sent with `Content-Type: application/json;
 * charset=utf-8`. Other media types MUST be rejected with 415.
 *
 * We accept `application/json` with or without an explicit `charset=utf-8`
 * (RFC 8259 §8.1 makes UTF-8 the default for JSON), but reject anything
 * else outright.
 */
export const contentTypePlugin = new Elysia({ name: "guardian:content-type" })
  // onRequest runs before parse/validation, so a 415 takes priority over
  // a body-shape 400 — which matches the §6.1 / §6.6 ordering.
  .onRequest((ctx) => {
    if (ctx.request.method !== "POST" && ctx.request.method !== "PUT") return;
    const ct = ctx.request.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) {
      throw new UnsupportedMediaTypeError({
        message: "Content-Type MUST be application/json (§6.1).",
      });
    }
  })
  .as("scoped");
