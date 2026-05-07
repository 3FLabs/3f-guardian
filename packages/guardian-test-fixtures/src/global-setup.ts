/**
 * vitest globalSetup hook. Boots a single prool anvil pool for the
 * whole vitest run; each worker (`process.env.VITEST_POOL_ID`) gets a
 * unique anvil instance under that pool's path-routed URL.
 *
 * The pool's TCP port is published via `provide("anvilPort", port)` so
 * test files can read it with `inject("anvilPort")`.
 *
 * Usage in either package's `vitest.integration.config.ts`:
 *
 *   globalSetup: ["../guardian-test-fixtures/src/global-setup.ts"]
 */

import { startAnvilPool } from "./anvil-pool.js";

declare module "vitest" {
  export interface ProvidedContext {
    anvilPort: number;
  }
}

/**
 * vitest's `globalSetup` signature isn't exported as a stable type in
 * vitest 4 — just use a structural shape covering what we actually
 * call (`provide`).
 */
type GlobalSetupCtx = {
  readonly provide: (name: "anvilPort", value: number) => void;
};

export default async function setup(ctx: GlobalSetupCtx) {
  const pool = await startAnvilPool();
  ctx.provide("anvilPort", pool.port);
  return async () => {
    await pool.stop();
  };
}
