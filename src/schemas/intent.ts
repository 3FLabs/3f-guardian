import { z } from "zod";
import { zUintString } from "./primitives.ts";

export const zIntentRef = z
  .object({
    id: zUintString.describe("Intent identifier. Resolved on-chain at signing time (§C.1)."),
  })
  .strict();

export type IntentRef = z.infer<typeof zIntentRef>;
