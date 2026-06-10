import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { z } from "zod";

import type { GuardianAbstractions } from "./abstractions.js";

import { contentTypePlugin } from "./plugins/content-type.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { loggerPlugin } from "./plugins/logger.js";
import { rawBodyPlugin } from "./plugins/raw-body.js";
import { requestIdPlugin } from "./plugins/request-id.js";
import { versionHeaderPlugin } from "./plugins/version-header.js";

import { healthRoute } from "./routes/health.js";
import { versionRoute } from "./routes/version.js";
import { intentRequestBindingRoute } from "./routes/intent-request-binding.js";
import { intentFundBindingRoute } from "./routes/intent-fund-binding.js";
import { intentSwapRoute } from "./routes/intent-swap.js";
import { requestWhitelistingRoute } from "./routes/request-whitelisting.js";

/**
 * Construct a fully-wired Guardian server from a set of abstractions.
 *
 * Plugin composition (outer → inner):
 *   errorHandlerPlugin   ← catches all thrown values, emits §6.5 envelope
 *   versionHeaderPlugin  ← X-Guardian-Version on every response
 *   requestIdPlugin      ← resolves & echoes X-Request-Id
 *   loggerPlugin         ← child logger bound to {requestId}
 *   rawBodyPlugin        ← captures bytes for §5.4 HMAC verification
 *   contentTypePlugin    ← rejects non-JSON POSTs with 415
 *   per-route auth       ← bearer + scope + HMAC, attached inside route
 *
 * The server returned is a vanilla Elysia instance so callers retain the
 * ability to `.listen()`, `.handle()` for tests, or compose further.
 *
 * Composition caveats — guardian's request pipeline is global, so routes
 * a host adds to the returned instance inherit:
 *  - the §6.1 JSON-only content-type guard on POST / PUT (415 otherwise);
 *  - guardian's body parser for `application/json` and `text/*` bodies
 *    (other content types are left untouched for Elysia's own parser
 *    chain) and its `maxBodyBytes` cap (413 past the cap);
 *  - the `requestId` / `logger` / `rawBody` context keys, which shadow
 *    any same-named keys the host derives.
 */
export function buildGuardianServer(abs: GuardianAbstractions) {
  return new Elysia({ name: "guardian" })
    .use(
      openapi({
        path: "/openapi",
        // Without this, zod schemas attached via `body` / `response` are not
        // converted to JSON Schema and request bodies / 200 responses render
        // empty in the OpenAPI document. Zod v4 ships `toJSONSchema` natively.
        //
        // `io: "input"` documents the wire format (e.g. `zAddress`'s
        // `regex(...).transform(v => v.toLowerCase())` becomes
        // `{ type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }` instead of
        // collapsing to `{}`); `unrepresentable: "any"` keeps unrepresentable
        // shapes (transforms, branded types) from throwing and replaces them
        // with `{}` instead of erasing the whole schema.
        mapJsonSchema: {
          zod: (schema: z.ZodType) =>
            z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
        },
        documentation: {
          info: {
            title: "Guardian Service HTTP API",
            version: abs.metadata.build,
            description:
              "Off-chain signer that attests privileged on-chain actions. " +
              "See the v1 specification for the full normative contract.",
          },
          tags: [
            { name: "meta", description: "Liveness and metadata endpoints." },
            { name: "facility", description: "Facility actions (§7.3-7.5)." },
            {
              name: "whitelist-book",
              description: "Whitelist book actions (§7.6).",
            },
          ],
          components: {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
                description:
                  "Per-token bearer authentication (§5.1). Required for every " +
                  "/v1/* endpoint. Tokens flagged as HMAC-required additionally " +
                  "MUST be accompanied by `X-Guardian-Timestamp` and " +
                  "`X-Guardian-Signature` headers (§5.4).",
              },
            },
          },
          // Document-level default: every operation requires bearerAuth unless
          // it explicitly overrides with `security: []` (the unauthenticated
          // /health and /version endpoints do exactly that).
          security: [{ bearerAuth: [] }],
        },
      }),
    )
    .use(errorHandlerPlugin(abs.logger))
    .use(versionHeaderPlugin(abs.metadata.build))
    .use(requestIdPlugin)
    .use(loggerPlugin(abs.logger))
    .use(rawBodyPlugin(abs.maxBodyBytes))
    .use(contentTypePlugin)
    .use(healthRoute(abs))
    .use(versionRoute(abs))
    .use(intentRequestBindingRoute(abs))
    .use(intentFundBindingRoute(abs))
    .use(intentSwapRoute(abs))
    .use(requestWhitelistingRoute(abs));
}

export type GuardianServer = ReturnType<typeof buildGuardianServer>;
