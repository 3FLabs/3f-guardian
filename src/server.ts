import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";

import type { GuardianAbstractions } from "./abstractions.ts";

import { contentTypePlugin } from "./plugins/content-type.ts";
import { errorHandlerPlugin } from "./plugins/error-handler.ts";
import { rawBodyPlugin } from "./plugins/raw-body.ts";
import { requestIdPlugin } from "./plugins/request-id.ts";
import { versionHeaderPlugin } from "./plugins/version-header.ts";

import { healthRoute } from "./routes/health.ts";
import { versionRoute } from "./routes/version.ts";
import { intentRequestBindingRoute } from "./routes/intent-request-binding.ts";
import { intentFundBindingRoute } from "./routes/intent-fund-binding.ts";
import { intentSwapRoute } from "./routes/intent-swap.ts";
import { requestWhitelistingRoute } from "./routes/request-whitelisting.ts";

/**
 * Construct a fully-wired Guardian server from a set of abstractions.
 *
 * Plugin composition (outer → inner):
 *   errorHandlerPlugin   ← catches all thrown values, emits §6.5 envelope
 *   versionHeaderPlugin  ← X-Guardian-Version on every response
 *   requestIdPlugin      ← resolves & echoes X-Request-Id
 *   rawBodyPlugin        ← captures bytes for §5.4 HMAC verification
 *   contentTypePlugin    ← rejects non-JSON POSTs with 415
 *   per-route auth       ← bearer + scope + HMAC, attached inside route
 *
 * The server returned is a vanilla Elysia instance so callers retain the
 * ability to `.listen()`, `.handle()` for tests, or compose further.
 */
export function buildGuardianServer(abs: GuardianAbstractions) {
  return new Elysia({ name: "guardian" })
    .use(
      openapi({
        path: "/openapi",
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
        },
      }),
    )
    .use(errorHandlerPlugin)
    .use(versionHeaderPlugin(abs.metadata.build))
    .use(requestIdPlugin)
    .use(rawBodyPlugin)
    .use(contentTypePlugin)
    .use(healthRoute(abs))
    .use(versionRoute(abs))
    .use(intentRequestBindingRoute(abs))
    .use(intentFundBindingRoute(abs))
    .use(intentSwapRoute(abs))
    .use(requestWhitelistingRoute(abs));
}

export type GuardianServer = ReturnType<typeof buildGuardianServer>;
