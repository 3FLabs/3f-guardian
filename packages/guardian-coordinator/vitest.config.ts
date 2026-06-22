import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@3flabs/guardian-coordinator",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    typecheck: { enabled: false },
  },
  resolve: {
    alias: {
      "@3flabs/guardian": fileURLToPath(new URL("../guardian/src/index.ts", import.meta.url)),
      "@3flabs/guardian-defaults": fileURLToPath(
        new URL("../guardian-defaults/src/index.ts", import.meta.url),
      ),
    },
  },
});
