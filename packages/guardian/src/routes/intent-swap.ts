import { Elysia } from "elysia";

import type { GuardianAbstractions } from "../abstractions.js";
import { runSigning } from "../lib/signing.js";
import { pickErrorResponses, zSigningSuccess } from "../schemas/responses.js";
import { zIntentSwapBody } from "../schemas/intent-swap.js";

import { makeAuthPlugin } from "../plugins/auth.js";

/** §7.5 — POST /v1/facility/intent-swaps. Never returns 409. */
export function intentSwapRoute(abs: GuardianAbstractions) {
  const auth = makeAuthPlugin(abs);
  return new Elysia({ name: "guardian:route:intent-swap" }).use(auth("facility:intent-swaps")).post(
    "/v1/facility/intent-swaps",
    ({ body, requestId, tokenInfo, logger }) =>
      runSigning({
        abs,
        sign: abs.signIntentSwap,
        body,
        requestId,
        tokenInfo,
        logger,
      }),
    {
      // Documentation-only — see comment on intent-request-binding route.
      parse: "json",
      body: zIntentSwapBody,
      response: {
        200: zSigningSuccess,
        ...pickErrorResponses([400, 401, 403, 404, 422, 429, 500, 502, 503]),
      },
      detail: {
        tags: ["facility"],
        summary: "Attest swap between two intents (§7.5)",
        description:
          "Attests an unordered swap between exactly two intents. " +
          "Implementations MUST normalise leg order so [A,B] and [B,A] " +
          "produce byte-identical signature and payloadHash.",
      },
    },
  );
}
