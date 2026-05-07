/**
 * Deterministic test accounts. Each test gets the same set so failures
 * reproduce. Private keys are dev-only — never reuse in production.
 *
 * The Guardian signing tests need keys for: a `guardian` (signs facility
 * payloads), three `validators` (sign request-whitelist payloads — three
 * because `RequestWhitelist.initialize` enforces `quorum < validators.length`,
 * so a quorum of 2 — needed for the §7.6 e2e tests — requires at least
 * three validators), plus a funded `owner` / `facilitator` / `puller` /
 * `consumer` that wear roles on the deployed contracts.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account, Hex } from "viem";

export type TestAccount = {
  readonly account: Account;
  readonly address: Account["address"];
  readonly privateKey: Hex;
};

const KEYS = {
  // First anvil dev key — also our deployer in `clients.ts`.
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  // Subsequent anvil dev keys (deterministic mnemonic).
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  facilitator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  guardian: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  puller: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  consumer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  validator1: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  validator2: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  validator3: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
} as const satisfies Record<string, Hex>;

function make(privateKey: Hex): TestAccount {
  const account = privateKeyToAccount(privateKey);
  return { account, address: account.address, privateKey };
}

export const testAccounts = {
  deployer: make(KEYS.deployer),
  owner: make(KEYS.owner),
  facilitator: make(KEYS.facilitator),
  guardian: make(KEYS.guardian),
  puller: make(KEYS.puller),
  consumer: make(KEYS.consumer),
  validator1: make(KEYS.validator1),
  validator2: make(KEYS.validator2),
  validator3: make(KEYS.validator3),
} as const;

export type TestAccountName = keyof typeof testAccounts;
