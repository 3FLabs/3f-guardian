import { Elysia } from "elysia";

import type { GuardianAbstractions } from "../abstractions.ts";
import { runSigning } from "../lib/signing.ts";
import { zErrorEnvelope, zSigningSuccess } from "../schemas/responses.ts";
import { zIntentFundBindingBody } from "../schemas/intent-fund-binding.ts";

import { makeAuthPlugin } from "../plugins/auth.ts";

/**
 * §7.4 — POST /v1/facility/intent-fund-bindings.
 *
 * The fund-state check (Appendix A.2) is the only 409-class check in v1;
 * everything else is 422-class. Per §6.6.1 a request that fails one
 * 409-class and one 422-class check returns 422.
 */
export function intentFundBindingRoute(abs: GuardianAbstractions) {
  const auth = makeAuthPlugin(abs);
  return new Elysia({ name: "guardian:route:intent-fund-binding" })
    .use(auth("facility:intent-fund-bindings"))
    .post(
      "/v1/facility/intent-fund-bindings",
      ({ body, requestId, tokenInfo }) =>
        runSigning({
          abs,
          sign: abs.signIntentFundBinding,
          body,
          requestId,
          tokenInfo,
        }),
      {
        body: zIntentFundBindingBody,
        response: {
          200: zSigningSuccess,
          400: zErrorEnvelope,
          401: zErrorEnvelope,
          403: zErrorEnvelope,
          404: zErrorEnvelope,
          409: zErrorEnvelope,
          422: zErrorEnvelope,
          429: zErrorEnvelope,
          500: zErrorEnvelope,
          502: zErrorEnvelope,
          503: zErrorEnvelope,
        },
        detail: {
          tags: ["facility"],
          summary: "Attest intent ↔ fund-contract binding (§7.4)",
          description:
            "Attests that a given intent may be bound to a given fund " +
            "contract. Performs Appendix A.2 checks. Returns 409 iff the " +
            "fund-state check fails alone.",
        },
      },
    );
}
