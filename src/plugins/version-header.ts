import { Elysia } from "elysia";
import { PROTECTED_RESPONSE_HEADERS } from "../schemas/headers.ts";

/**
 * Adds §6.3 X-Guardian-Version on every response. The value is captured
 * once at plugin construction so we don't have to re-read it per request.
 */
export function versionHeaderPlugin(build: string) {
  return new Elysia({ name: "guardian:version-header" })
    .onRequest((ctx) => {
      ctx.set.headers[PROTECTED_RESPONSE_HEADERS.GUARDIAN_VERSION] = build;
    })
    .as("scoped");
}
