import { z } from "zod";

export const zHealthResponse = z
  .object({ status: z.literal("ok") })
  .strict()
  .describe("GET /health response (§7.1).");

export type HealthResponse = z.infer<typeof zHealthResponse>;
