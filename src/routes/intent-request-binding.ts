import { Elysia } from "elysia";

import type { GuardianAbstractions } from "../abstractions.ts";
import { runSigning } from "../lib/signing.ts";
import { zErrorEnvelope, zSigningSuccess } from "../schemas/responses.ts";
import { zIntentRequestBindingBody } from "../schemas/intent-request-binding.ts";

import { makeAuthPlugin } from "../plugins/auth.ts";

/** §7.3 — POST /v1/facility/intent-request-bindings. Never returns 409. */
export function intentRequestBindingRoute(abs: GuardianAbstractions) {
  const auth = makeAuthPlugin(abs);
  return new Elysia({ name: "guardian:route:intent-request-binding" })
    .use(auth("facility:intent-request-bindings"))
    .post(
      "/v1/facility/intent-request-bindings",
      ({ body, requestId, tokenInfo }) =>
        runSigning({
          abs,
          sign: abs.signIntentRequestBinding,
          body,
          requestId,
          tokenInfo,
        }),
      {
        body: zIntentRequestBindingBody,
        response: {
          200: zSigningSuccess,
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
          tags: ["facility"],
          summary: "Attest intent ↔ request-contract binding (§7.3)",
          description:
            "Attests that a given intent may be bound to a given request " +
            "contract. Performs Appendix A.1 checks. Never returns 409.",
        },
      },
    );
}
