import { z } from "zod";
import { zAddress, zChainId } from "./primitives.ts";

export const zVersionResponse = z
  .object({
    apiVersion: z.literal("v1").describe("Major version served at this base URL."),
    build: z
      .string()
      .min(1)
      .describe("Semver of the Guardian build, OPTIONALLY suffixed with +<commit>."),
    guardianSigner: zAddress.describe("Address corresponding to GUARDIAN_SIGNER_KEY."),
    supportedChains: z.array(zChainId).describe("EIP-155 chain ids the Guardian will accept."),
  })
  .strict()
  .describe("GET /version response (§7.2).");

export type VersionResponse = z.infer<typeof zVersionResponse>;
