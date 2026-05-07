import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@3flabs/guardian",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
    environment: "node",
    typecheck: { enabled: false },
  },
});
