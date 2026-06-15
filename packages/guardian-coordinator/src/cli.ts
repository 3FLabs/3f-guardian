#!/usr/bin/env bun
import { pathToFileURL } from "node:url";

import { Result } from "better-result";
import { createPublicClient, http, isAddress, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import {
  makeSignIntentFundBinding,
  makeSignIntentRequestBinding,
  makeSignIntentSwap,
  privateKeyToSignTypedData,
  UnsupportedChainError,
} from "@3flabs/guardian";
import {
  buildIntentFundBindingChecks,
  buildIntentRequestBindingChecks,
  buildIntentSwapChecks,
  inMemoryCache,
  pinoLogger,
  zA1OnChainData,
} from "@3flabs/guardian-defaults";

import {
  loadCoordinatorConfig,
  runGuardianCoordinator,
  type CoordinatorGuardian,
} from "./index.js";

const DEFAULT_MAX_DEADLINE_SECONDS_AHEAD = 600;
const DEFAULT_EVENT_SCAN_BLOCK_RANGE = 10_000n;
const DEFAULT_EVENT_SCAN_MAX_LOOKBACK_BLOCKS = 1_000_000n;
const DEFAULT_SWAP_PRICE_TOLERANCE_BPS = 1;

export function buildGuardianFromEnv(
  env: Record<string, string | undefined> = process.env,
): CoordinatorGuardian {
  const privateKey = required(env, "GUARDIAN_SIGNER_KEY") as Hex;
  const guardianSigner = privateKeyToAccount(privateKey).address;
  const clients = parseRpcClients(required(env, "GUARDIAN_CHAIN_RPC_URLS"));
  const supportedChains = [...clients.keys()].sort((a, b) => a - b);

  const eip712DomainCache = inMemoryCache(z.object({ name: z.string(), version: z.string() }), {
    defaultTtlMs: 24 * 60 * 60_000,
    maxEntries: 256,
  });
  const a1OnChainCache = inMemoryCache(zA1OnChainData, {
    defaultTtlMs: 5 * 60_000,
    maxEntries: 1024,
  });

  const maxDeadlineSecondsAhead = positiveInt(
    env.GUARDIAN_MAX_DEADLINE_SECONDS_AHEAD,
    DEFAULT_MAX_DEADLINE_SECONDS_AHEAD,
  );

  return {
    metadata: {
      build: env.BUILD_ID ?? "0.1.0",
      guardianSigner,
      supportedChains,
    },
    logger: pinoLogger({
      pretty: env.NODE_ENV !== "production",
      bindings: { service: "guardian-coordinator" },
    }),
    getChainClient: (chainId) => {
      const client = clients.get(chainId);
      return client
        ? Result.ok(client)
        : Result.err(
            new UnsupportedChainError({ message: `Unsupported chain ${chainId}`, chainId }),
          );
    },
    signTypedData: privateKeyToSignTypedData(privateKey),
    signIntentRequestBinding: makeSignIntentRequestBinding({
      checks: buildIntentRequestBindingChecks({
        policy: {
          maxDeadlineSecondsAhead,
          acceptedRequestFactories: parseAddressMap(
            required(env, "GUARDIAN_REQUEST_FACTORIES"),
            "GUARDIAN_REQUEST_FACTORIES",
          ),
          acceptedOwners: parseAddressMap(
            required(env, "GUARDIAN_REQUEST_OWNERS"),
            "GUARDIAN_REQUEST_OWNERS",
          ),
          acceptedPullers: parseAddressMap(
            required(env, "GUARDIAN_REQUEST_PULLERS"),
            "GUARDIAN_REQUEST_PULLERS",
          ),
          acceptedConsumers: parseAddressMap(
            required(env, "GUARDIAN_REQUEST_CONSUMERS"),
            "GUARDIAN_REQUEST_CONSUMERS",
          ),
          eventScanBlockRange: positiveBigInt(
            env.GUARDIAN_EVENT_SCAN_BLOCK_RANGE,
            DEFAULT_EVENT_SCAN_BLOCK_RANGE,
          ),
          eventScanMaxLookbackBlocks: positiveBigInt(
            env.GUARDIAN_EVENT_SCAN_MAX_LOOKBACK_BLOCKS,
            DEFAULT_EVENT_SCAN_MAX_LOOKBACK_BLOCKS,
          ),
        },
        cache: a1OnChainCache,
      }),
      guardianSigner,
      cache: eip712DomainCache,
    }),
    signIntentFundBinding: makeSignIntentFundBinding({
      checks: buildIntentFundBindingChecks({
        policy: {
          maxDeadlineSecondsAhead,
          acceptedFunds: parseAddressMap(
            required(env, "GUARDIAN_ACCEPTED_FUNDS"),
            "GUARDIAN_ACCEPTED_FUNDS",
          ),
          acceptedOwners: parseAddressMap(
            required(env, "GUARDIAN_FUND_OWNERS"),
            "GUARDIAN_FUND_OWNERS",
          ),
        },
      }),
      guardianSigner,
      cache: eip712DomainCache,
    }),
    signIntentSwap: makeSignIntentSwap({
      checks: buildIntentSwapChecks({
        policy: {
          maxDeadlineSecondsAhead,
          acceptedPmFactories: parseAddressMap(
            required(env, "GUARDIAN_PM_FACTORIES"),
            "GUARDIAN_PM_FACTORIES",
          ),
          acceptedPmOwners: parseAddressMap(
            required(env, "GUARDIAN_PM_OWNERS"),
            "GUARDIAN_PM_OWNERS",
          ),
          swapPriceToleranceBps: positiveInt(
            env.GUARDIAN_SWAP_PRICE_TOLERANCE_BPS,
            DEFAULT_SWAP_PRICE_TOLERANCE_BPS,
          ),
        },
      }),
      guardianSigner,
      cache: eip712DomainCache,
    }),
  };
}

function parseRpcClients(value: string): Map<number, PublicClient> {
  const entries = new Map<number, PublicClient>();
  for (const item of value.split(",")) {
    const [rawChainId, ...rawUrlParts] = item.split("=");
    const chainId = positiveInt(rawChainId?.trim(), 0);
    const url = rawUrlParts.join("=").trim();
    if (!url) throw new Error(`invalid GUARDIAN_CHAIN_RPC_URLS entry: ${item}`);
    entries.set(chainId, createPublicClient({ transport: http(url) }) as PublicClient);
  }
  if (entries.size === 0) throw new Error("GUARDIAN_CHAIN_RPC_URLS must not be empty");
  return entries;
}

function parseAddressMap(value: string, name: string): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  for (const item of value.split(";")) {
    if (!item.trim()) continue;
    const [rawChainId, rawAddresses] = item.split("=");
    const chainId = positiveInt(rawChainId?.trim(), 0);
    const addresses = new Set(
      (rawAddresses ?? "")
        .split(",")
        .map((address) => address.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const address of addresses) {
      if (!isAddress(address, { strict: false })) {
        throw new Error(`${name} contains invalid address ${address}`);
      }
    }
    if (addresses.size === 0) throw new Error(`${name} has no addresses for chain ${chainId}`);
    map.set(chainId, addresses);
  }
  if (map.size === 0) throw new Error(`${name} must not be empty`);
  return map;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`expected positive integer: ${value}`);
  return parsed;
}

function positiveBigInt(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`expected positive bigint: ${value}`);
  return parsed;
}

async function main(): Promise<void> {
  await runGuardianCoordinator({
    ...loadCoordinatorConfig(process.env),
    guardian: buildGuardianFromEnv(process.env),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
