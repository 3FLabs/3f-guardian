import { z } from "zod";

export const zCheckEntry = z
  .object({
    description: z
      .string()
      .min(1)
      .describe(
        "Human-readable description of what was checked. Wording is " +
          "informative and MAY change between Guardian builds.",
      ),
    passed: z
      .boolean()
      .describe(
        "true if the check did not block signing; false if it failed. " +
          "A check reported with skipped:true MUST also report passed:true.",
      ),
    skipped: z
      .boolean()
      .describe("true if the check did not apply to this request and was not evaluated."),
    reason: z
      .string()
      .min(1)
      .optional()
      .describe("Human-readable explanation of the failure. Required when passed is false."),
  })
  .strict()
  .describe("Single entry of the §6.4.1 checks array.");

export type CheckEntry = z.infer<typeof zCheckEntry>;

export const zChecks = z.array(zCheckEntry).describe("Checks array (§6.4.1).");
