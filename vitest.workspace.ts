import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/guardian/vitest.config.ts",
  "packages/guardian-defaults/vitest.config.ts",
]);
