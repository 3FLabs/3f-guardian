import { z } from "zod";
import { zAddress, zChainId, zDeadlineSeconds } from "./primitives.js";
import { zIntentRef } from "./intent.js";

export const zIntentFundBindingBody = z
  .object({
    chainId: zChainId,
    facility: zAddress.describe("Facility contract on chainId."),
    intent: zIntentRef,
    fundContract: zAddress.describe("Fund contract proposed for binding."),
    positionManager: zAddress.describe("Target / deposit-asset position manager."),
    deadline: zDeadlineSeconds,
  })
  .strict()
  .describe("POST /v1/facility/intent-fund-bindings request (§7.4).");

export type IntentFundBindingBody = z.infer<typeof zIntentFundBindingBody>;
