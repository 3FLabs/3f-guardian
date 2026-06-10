/**
 * prool-backed anvil pool used by both packages' integration tests.
 *
 * One server, many anvil instances multiplexed by URL path
 * (`http://127.0.0.1:<port>/<workerId>`). Each vitest worker has its
 * own `VITEST_POOL_ID` and therefore its own anvil — no cross-test
 * state bleed.
 *
 * The `anvil` binary must be on `PATH` (foundry install). prool itself
 * does NOT bundle a binary.
 *
 * @see https://github.com/wevm/prool
 */

import { Instance, Server } from "prool";

export type AnvilPool = {
  readonly port: number;
  stop(): Promise<void>;
};

/**
 * Boot a fresh anvil pool. Defaults: clean (no fork), instant mining,
 * 31337 chainId, 10 funded dev accounts.
 */
export async function startAnvilPool(opts?: { port?: number; limit?: number }): Promise<AnvilPool> {
  const server = Server.create({
    // Cap the pool so stray/forged worker ids can't spawn unbounded anvil
    // processes; comfortably above any realistic vitest worker count.
    limit: opts?.limit ?? 64,
    instance: Instance.anvil({
      chainId: 31337,
      // No `blockTime` — default is instant mining (one block per tx)
      // which is exactly what tests want. Anvil rejects `--block-time 0`.
      accounts: 10,
      // EIP-170 default (24576 bytes) is below the unoptimised Facility
      // contract size; bump it for tests so deploys don't trip on the
      // CreateContractSizeLimit EVM error. The deployed bytecode is
      // identical regardless of this setting — anvil just relaxes the
      // check at deploy time.
      codeSizeLimit: 1_000_000,
    }),
  });

  // Bind ourselves instead of calling `server.start()`: prool ignores `host`
  // whenever `port` is falsy (its port-0 branch is a bare `server.listen(cb)`,
  // which binds an OS-assigned port on ALL interfaces), and its start() has no
  // reject path, so a fixed-port EADDRINUSE would surface as an uncaught
  // 'error' event that kills the process. Listening directly keeps the pool
  // loopback-only and makes bind failures catchable by the caller.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(opts?.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("prool server did not bind to a port");
  }

  return {
    port: address.port,
    async stop() {
      await server.stop();
    },
  };
}

/** Path-routed RPC URL for a given vitest worker. */
export function getRpcUrl(port: number, workerId: string | number): string {
  return `http://127.0.0.1:${port}/${workerId}`;
}

/** Pull the worker id from `process.env.VITEST_POOL_ID` (set by vitest 4 forks pool). */
export function currentWorkerId(): string {
  return process.env.VITEST_POOL_ID ?? "1";
}
