import { z } from "zod";
import { zAddress, zChainId, zDeadlineSeconds, zUintStringBelowMax } from "./primitives.ts";
import { zSigningSuccess } from "./responses.ts";

export const zWhitelistOperation = z.enum(["whitelist", "unwhitelist"]);
export type WhitelistOperation = z.infer<typeof zWhitelistOperation>;

const zRequestContracts = z
  .array(zAddress)
  .min(1, "requestContracts MUST be non-empty")
  .refine(
    (xs) => new Set(xs.map((a) => a.toLowerCase())).size === xs.length,
    "requestContracts MUST NOT contain duplicates (case-insensitive)",
  )
  .describe(
    "Request contracts subject to operation. Non-empty, no case-insensitive " +
      "duplicates (§7.6).",
  );

export const zRequestWhitelistingBody = z
  .object({
    chainId: zChainId,
    whitelistBook: zAddress.describe("Whitelist book contract on chainId."),
    operation: zWhitelistOperation.describe(
      "whitelist | unwhitelist. Mixed batches not supported.",
    ),
    requestContracts: zRequestContracts,
    nonce: zUintStringBelowMax.describe(
      "Replay-protection nonce; sentinel 2^256 − 1 rejected as 400 (§7.6).",
    ),
    deadline: zDeadlineSeconds,
  })
  .strict()
  .describe("POST /v1/whitelist-book/request-whitelistings request (§7.6).");

export type RequestWhitelistingBody = z.infer<typeof zRequestWhitelistingBody>;

export const zRequestWhitelistingResponse = zSigningSuccess
  .extend({
    address: zAddress.describe(
      "Signing address bound into the EIP-712 payload as a structural " +
        "parameter. Equal to guardian in v1, exposed separately because the " +
        "on-chain whitelist book carries it as an explicit payload " +
        "parameter (§7.6.1).",
    ),
    nonce: zUintStringBelowMax.describe("Verbatim echo of the request nonce (§7.6.1)."),
  })
  .describe("Whitelisting signing success response (§7.6.1).");

export type RequestWhitelistingResponse = z.infer<typeof zRequestWhitelistingResponse>;
