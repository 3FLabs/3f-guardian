import { Elysia } from "elysia";

import type { GuardianAbstractions } from "../abstractions.js";
import { runSigning } from "../lib/signing.js";
import { pickErrorResponses } from "../schemas/responses.js";
import {
  zRequestWhitelistingBody,
  zRequestWhitelistingResponse,
} from "../schemas/request-whitelisting.js";

import { makeAuthPlugin } from "../plugins/auth.js";

/**
 * §7.6 — POST /v1/whitelist-book/request-whitelistings.
 *
 * Response carries the §7.6.1 extensions (`address`, `nonce`). For
 * `operation = "whitelist"` per-contract Appendix-A.1 checks apply; for
 * `operation = "unwhitelist"` only the deadline + nonce checks apply.
 * Never returns 409.
 */
export function requestWhitelistingRoute(abs: GuardianAbstractions) {
  const auth = makeAuthPlugin(abs);
  return new Elysia({ name: "guardian:route:request-whitelisting" })
    .use(auth("whitelist-book:request-whitelistings"))
    .post(
      "/v1/whitelist-book/request-whitelistings",
      ({ body, requestId, tokenInfo, logger }) =>
        runSigning({
          abs,
          sign: abs.signRequestWhitelisting,
          body,
          requestId,
          tokenInfo,
          logger,
        }),
      {
        // Documentation-only — see comment on intent-request-binding route.
        parse: "json",
        body: zRequestWhitelistingBody,
        response: {
          200: zRequestWhitelistingResponse,
          ...pickErrorResponses([400, 401, 403, 404, 422, 429, 500, 502, 503]),
        },
        detail: {
          tags: ["whitelist-book"],
          summary: "Attest request-contract whitelist batch (§7.6)",
          description:
            "Whitelists or unwhitelists one or more request contracts in " +
            "a single batch. Response includes the bound signing address " +
            "and a verbatim echo of the request nonce.",
        },
      },
    );
}
