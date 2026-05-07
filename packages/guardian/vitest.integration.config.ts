import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@3flabs/guardian:integration",
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    typecheck: { enabled: false },
    globalSetup: [
      fileURLToPath(new URL("../guardian-test-fixtures/src/global-setup.ts", import.meta.url)),
    ],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@3flabs/guardian-test-fixtures": fileURLToPath(
        new URL("../guardian-test-fixtures/src/index.ts", import.meta.url),
      ),
    },
  },
});
