import { z } from "zod";
import { zAddress, zChainId, zDeadlineSeconds } from "./primitives.ts";
import { zIntentRef } from "./intent.ts";

export const zIntentRequestBindingBody = z
  .object({
    chainId: zChainId.describe("EIP-155 chain id; MUST be in supportedChains."),
    facility: zAddress.describe("Facility contract on chainId."),
    intent: zIntentRef,
    requestContract: zAddress.describe("Request contract proposed for binding."),
    deadline: zDeadlineSeconds.describe(
      "Caller-defined Unix timestamp in seconds. Bound verbatim into the " +
        "signed payload (§7.7).",
    ),
  })
  .strict()
  .describe("POST /v1/facility/intent-request-bindings request (§7.3).");

export type IntentRequestBindingBody = z.infer<typeof zIntentRequestBindingBody>;
