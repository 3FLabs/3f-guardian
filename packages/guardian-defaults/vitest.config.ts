import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@3flabs/guardian-defaults",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
    environment: "node",
    typecheck: { enabled: false },
  },
  resolve: {
    // The workspace's `exports` map points consumers at `./dist/index.js`,
    // which is correct for published artifacts but means tests would
    // require a prior `bun run build`. Aliasing here lets vitest pick up
    // the source directly so `bun run test` works on a fresh clone.
    alias: {
      "@3flabs/guardian": fileURLToPath(new URL("../guardian/src/index.ts", import.meta.url)),
    },
  },
});
