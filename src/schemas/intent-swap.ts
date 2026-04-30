import { z } from "zod";
import { zAddress, zChainId, zDeadlineSeconds, zUintString } from "./primitives.ts";
import { zIntentRef } from "./intent.ts";

export const zSwapLeg = z
  .object({
    intent: zIntentRef.describe("Intent identifier for this side of the swap."),
    asset: zAddress.describe("Asset this leg is exchanging."),
    amount: zUintString.describe(
      "Asset amount in the asset's smallest unit (e.g. USDC base units).",
    ),
  })
  .strict();

export type SwapLeg = z.infer<typeof zSwapLeg>;

export const zIntentSwapBody = z
  .object({
    chainId: zChainId,
    facility: zAddress,
    legs: z
      .array(zSwapLeg)
      .length(2, "legs MUST contain exactly two entries")
      .describe(
        "Exactly two unordered entries. Order carries no semantic meaning " +
          "and the Guardian produces an identical signature for [A, B] and " +
          "[B, A] (§7.5).",
      ),
    deadline: zDeadlineSeconds,
  })
  .strict()
  .describe("POST /v1/facility/intent-swaps request (§7.5).");

export type IntentSwapBody = z.infer<typeof zIntentSwapBody>;
