import { Elysia } from "elysia";

import type { GuardianAbstractions } from "../abstractions.ts";
import { runSigning } from "../lib/signing.ts";
import { zErrorEnvelope } from "../schemas/responses.ts";
import {
  zRequestWhitelistingBody,
  zRequestWhitelistingResponse,
} from "../schemas/request-whitelisting.ts";

import { makeAuthPlugin } from "../plugins/auth.ts";

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
      ({ body, requestId, tokenInfo }) =>
        runSigning({
          abs,
          sign: abs.signRequestWhitelisting,
          body,
          requestId,
          tokenInfo,
        }),
      {
        body: zRequestWhitelistingBody,
        response: {
          200: zRequestWhitelistingResponse,
          400: zErrorEnvelope,
          401: zErrorEnvelope,
          403: zErrorEnvelope,
          404: zErrorEnvelope,
          422: zErrorEnvelope,
          429: zErrorEnvelope,
          500: zErrorEnvelope,
          502: zErrorEnvelope,
          503: zErrorEnvelope,
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
