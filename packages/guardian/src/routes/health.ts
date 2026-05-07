import { Elysia } from "elysia";

import type { GuardianAbstractions } from "../abstractions.js";
import { zHealthResponse } from "../schemas/health.js";
import { errorResponses } from "../schemas/responses.js";
import { unwrapOrThrow } from "../lib/result.js";

/**
 * §7.1 — liveness probe. 200 iff prepared to accept authenticated requests;
 * 503 otherwise (signing key lost, all RPCs down, etc.).
 *
 * Unauthenticated and not subject to HMAC requirements.
 */
export function healthRoute(abs: GuardianAbstractions) {
  return new Elysia({ name: "guardian:route:health" }).get(
    "/health",
    async () => {
      unwrapOrThrow(await abs.liveness());
      return { status: "ok" } as const;
    },
    {
      response: { 200: zHealthResponse, 503: errorResponses[503] },
      detail: {
        tags: ["meta"],
        summary: "Liveness probe (§7.1)",
        description:
          "Returns 200 iff the Guardian is prepared to accept authenticated " +
          "requests; 503 otherwise. Unauthenticated.",
        // Override the document-level bearerAuth requirement: /health is
        // unauthenticated per §7.1.
        security: [],
      },
    },
  );
}
