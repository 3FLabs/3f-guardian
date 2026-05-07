/**
 * Per-file integration fixture. Use inside a `describe` /
 * `beforeAll` to boot a clean anvil instance for the worker, deploy
 * the full Guardian stack, and expose the resulting `AddressBook` plus
 * viem clients to every test in the file.
 *
 * Each vitest worker gets its own anvil instance (one per
 * `VITEST_POOL_ID`); state is shared across tests within the same
 * file but reset between workers.
 *
 * @example
 * const fixture = createIntegrationFixture();
 * beforeAll(fixture.setup);
 *
 * test("…", async () => {
 *   const { book, publicClient } = fixture.snapshot();
 *   // …
 * });
 */

import { inject } from "vitest";

import { currentWorkerId, getRpcUrl } from "./anvil-pool.js";
import { type IntegrationClients, createClients } from "./clients.js";
import { type AddressBook, type DeployOptions, deployGuardianStack } from "./deploy.js";

// Mirrors the augmentation in `global-setup.ts`. Duplicated here so it is
// visible to consumer packages (whose tsconfigs reach `test-fixture.ts`
// via `createIntegrationFixture` imports but never load `global-setup.ts`,
// which is referenced only from `vitest.integration.config.ts`).
declare module "vitest" {
  export interface ProvidedContext {
    anvilPort: number;
  }
}

export type IntegrationSnapshot = {
  readonly book: AddressBook;
  readonly clients: IntegrationClients;
  readonly rpcUrl: string;
};

export type IntegrationFixture = {
  readonly setup: () => Promise<void>;
  readonly snapshot: () => IntegrationSnapshot;
};

export function createIntegrationFixture(opts?: DeployOptions): IntegrationFixture {
  let snap: IntegrationSnapshot | undefined;

  return {
    async setup() {
      const port = inject("anvilPort");
      const workerId = currentWorkerId();
      const rpcUrl = getRpcUrl(port, workerId);
      const clients = createClients(rpcUrl);
      const book = await deployGuardianStack(clients, opts);
      snap = { book, clients, rpcUrl };
    },
    snapshot() {
      if (!snap) throw new Error("Fixture not initialised — call `setup` from beforeAll first");
      return snap;
    },
  };
}
