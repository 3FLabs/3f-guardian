/**
 * viem client triplet for the per-worker anvil URL.
 *
 *  - `publicClient`  — read-only views (used by the Guardian itself).
 *  - `walletClient`  — the funded deployer / role-granter.
 *  - `testClient`    — anvil cheat-codes (`mine`, `setBalance`, …).
 *
 * The deployer account is the first anvil dev account; its private
 * key is documented in foundry's docs (and is fine to embed since
 * anvil never reaches mainnet).
 */

import {
  type Account,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  publicActions,
  type PublicClient,
  type TestClient,
  walletActions,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

/** First anvil dev account (deterministic across runs). */
export const ANVIL_DEPLOYER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const satisfies Hex;

/** Canonical Multicall3 address used across every EVM chain. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const anvilLocalhost = defineChain({
  id: 31337,
  name: "Anvil Localhost",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  contracts: {
    multicall3: { address: MULTICALL3_ADDRESS },
  },
});

export type IntegrationClients = {
  readonly account: Account;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly testClient: TestClient;
};

export function createClients(
  rpcUrl: string,
  deployerPk: Hex = ANVIL_DEPLOYER_PK,
): IntegrationClients {
  const account = privateKeyToAccount(deployerPk);
  const transport = http(rpcUrl);

  const publicClient = createPublicClient({ chain: anvilLocalhost, transport });
  const walletClient = createWalletClient({ chain: anvilLocalhost, transport, account });
  // testClient extends both public + wallet so deploy helpers can reuse a single client.
  const testClient = createTestClient({
    chain: anvilLocalhost,
    transport,
    mode: "anvil",
    account,
  })
    .extend(publicActions)
    .extend(walletActions);

  return { account, publicClient, walletClient, testClient };
}
