import { Elysia } from "elysia";

import type { GuardianAbstractions } from "../abstractions.js";
import { zVersionResponse, type VersionResponse } from "../schemas/version.js";

/**
 * §7.2 — build and protocol metadata. Unauthenticated.
 */
export function versionRoute(abs: GuardianAbstractions) {
  return new Elysia({ name: "guardian:route:version" }).get(
    "/version",
    (): VersionResponse => ({
      apiVersion: "v1",
      build: abs.metadata.build,
      guardianSigner: abs.metadata.guardianSigner,
      supportedChains: abs.metadata.supportedChains,
    }),
    {
      response: { 200: zVersionResponse },
      detail: {
        tags: ["meta"],
        summary: "Build and protocol metadata (§7.2)",
      },
    },
  );
}
