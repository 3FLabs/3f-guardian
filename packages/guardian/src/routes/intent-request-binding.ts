import { Elysia } from "elysia";

import type { GuardianAbstractions } from "../abstractions.js";
import { runSigning } from "../lib/signing.js";
import { zProtectedRequestHeaders } from "../schemas/headers.js";
import { pickErrorResponses, zSigningSuccess } from "../schemas/responses.js";
import { zIntentRequestBindingBody } from "../schemas/intent-request-binding.js";

import { makeAuthPlugin } from "../plugins/auth.js";

/** §7.3 — POST /v1/facility/intent-request-bindings. Never returns 409. */
export function intentRequestBindingRoute(abs: GuardianAbstractions) {
  const auth = makeAuthPlugin(abs);
  return new Elysia({ name: "guardian:route:intent-request-binding" })
    .use(auth("facility:intent-request-bindings"))
    .post(
      "/v1/facility/intent-request-bindings",
      ({ body, requestId, tokenInfo, logger }) =>
        runSigning({
          abs,
          sign: abs.signIntentRequestBinding,
          body,
          requestId,
          tokenInfo,
          logger,
        }),
      {
        // `parse: "json"` is documentation-only: the global rawBodyPlugin's
        // onParse already produces the parsed body. We declare it per-route so
        // `@elysiajs/openapi` can emit `requestBody.content["application/json"]`
        // — its body-content loop only renders content for parsers whose
        // `fn` is a string, never for plain function-typed onParse hooks.
        parse: "json",
        body: zIntentRequestBindingBody,
        headers: zProtectedRequestHeaders,
        response: {
          200: zSigningSuccess,
          ...pickErrorResponses([400, 401, 403, 404, 413, 415, 422, 429, 500, 502, 503]),
        },
        detail: {
          tags: ["facility"],
          summary: "Attest intent ↔ request-contract binding (§7.3)",
          description:
            "Attests that a given intent may be bound to a given request " +
            "contract. Performs Appendix A.1 checks. Never returns 409.",
        },
      },
    );
}
