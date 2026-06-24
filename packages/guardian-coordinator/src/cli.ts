#!/usr/bin/env bun
import { pathToFileURL } from "node:url";

import { Result } from "better-result";
import {
  createPublicClient,
  defineChain,
  hashTypedData,
  http,
  isAddress,
  isHex,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  makeSignIntentFundBinding,
  makeSignIntentRequestBinding,
  makeSignIntentSwap,
  InternalError,
  privateKeyToSignTypedData,
  type SignTypedData,
  UnsupportedChainError,
  UpstreamUnavailableError,
} from "@3flabs/guardian";
import {
  buildIntentFundBindingChecks,
  buildIntentRequestBindingChecks,
  buildIntentSwapChecks,
} from "@3flabs/guardian-defaults";

import {
  loadCoordinatorConfig,
  positiveInt,
  required,
  runGuardianCoordinator,
  type CoordinatorGuardian,
} from "./index.js";
import { awsKmsSignTypedData, gcpKmsSignTypedData } from "./kms-signers.js";

const DEFAULT_MAX_DEADLINE_SECONDS_AHEAD = 600;
const DEFAULT_EVENT_SCAN_BLOCK_RANGE = 10_000n;
const DEFAULT_EVENT_SCAN_MAX_LOOKBACK_BLOCKS = 1_000_000n;
const DEFAULT_REMOTE_SIGNER_TIMEOUT_MS = 6_000;
const DEFAULT_SWAP_PRICE_TOLERANCE_BPS = 1;
const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";

export function buildGuardianFromEnv(
  env: Record<string, string | undefined> = process.env,
): CoordinatorGuardian {
  const signer = loadGuardianSigner(env);
  const clients = parseRpcClients(required(env, "GUARDIAN_CHAIN_RPC_URLS"));
  const supportedChains = [...clients.keys()].sort((a, b) => a - b);

  const maxDeadlineSecondsAhead = positiveInt(
    env.GUARDIAN_MAX_DEADLINE_SECONDS_AHEAD,
    DEFAULT_MAX_DEADLINE_SECONDS_AHEAD,
  );

  return {
    metadata: {
      build: env.BUILD_ID ?? "0.1.0",
      guardianSigner: signer.guardianSigner,
      supportedChains,
    },
    getChainClient: (chainId) => {
      const client = clients.get(chainId);
      return client
        ? Result.ok(client)
        : Result.err(
            new UnsupportedChainError({ message: `Unsupported chain ${chainId}`, chainId }),
          );
    },
    signTypedData: signer.signTypedData,
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
      }),
      guardianSigner: signer.guardianSigner,
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
      guardianSigner: signer.guardianSigner,
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
          swapPriceToleranceBps: nonNegativeInt(
            env.GUARDIAN_SWAP_PRICE_TOLERANCE_BPS,
            DEFAULT_SWAP_PRICE_TOLERANCE_BPS,
          ),
        },
      }),
      guardianSigner: signer.guardianSigner,
    }),
  };
}

type LoadedGuardianSigner = {
  guardianSigner: Address;
  signTypedData: SignTypedData;
};

function loadGuardianSigner(env: Record<string, string | undefined>): LoadedGuardianSigner {
  const provider = env.GUARDIAN_SIGNER_PROVIDER?.trim() || "private_key";
  switch (provider) {
    case "private_key": {
      const privateKey = required(env, "GUARDIAN_SIGNER_KEY") as Hex;
      return {
        guardianSigner: privateKeyToAccount(privateKey).address,
        signTypedData: privateKeyToSignTypedData(privateKey),
      };
    }
    case "remote_http": {
      const guardianSigner = requiredAddress(env, "GUARDIAN_SIGNER_ADDRESS");
      return {
        guardianSigner,
        signTypedData: remoteHttpSignTypedData({
          url: remoteSignerUrl(required(env, "GUARDIAN_REMOTE_SIGNER_URL")),
          guardianSigner,
          timeoutMs: positiveInt(
            env.GUARDIAN_REMOTE_SIGNER_TIMEOUT_MS,
            DEFAULT_REMOTE_SIGNER_TIMEOUT_MS,
          ),
          bearerToken: env.GUARDIAN_REMOTE_SIGNER_BEARER_TOKEN?.trim() || undefined,
        }),
      };
    }
    case "aws_kms": {
      const guardianSigner = requiredAddress(env, "GUARDIAN_SIGNER_ADDRESS");
      return {
        guardianSigner,
        signTypedData: awsKmsSignTypedData({
          keyId: required(env, "GUARDIAN_AWS_KMS_KEY_ID"),
          guardianSigner,
          region: env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || undefined,
        }),
      };
    }
    case "gcp_kms": {
      const guardianSigner = requiredAddress(env, "GUARDIAN_SIGNER_ADDRESS");
      return {
        guardianSigner,
        signTypedData: gcpKmsSignTypedData({
          keyVersionName: required(env, "GUARDIAN_GCP_KMS_KEY_VERSION"),
          guardianSigner,
        }),
      };
    }
    default:
      throw new Error(
        `unsupported GUARDIAN_SIGNER_PROVIDER ${provider}; expected private_key, remote_http, aws_kms, or gcp_kms`,
      );
  }
}

function remoteHttpSignTypedData(args: {
  url: string;
  guardianSigner: Address;
  timeoutMs: number;
  bearerToken?: string | undefined;
}): SignTypedData {
  return async (parameters) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(args.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(args.bearerToken ? { authorization: `Bearer ${args.bearerToken}` } : {}),
          },
          body: stringifyJson({ typedData: parameters }),
          signal: controller.signal,
        });
      } catch (cause) {
        return Result.err(remoteSignerRequestError(cause, controller.signal, args.timeoutMs));
      }

      if (!response.ok) {
        return Result.err(
          new UpstreamUnavailableError({
            message: `Remote signer returned HTTP ${response.status}`,
            status: response.status >= 500 ? 503 : 502,
          }),
        );
      }

      const payload = await readJson(response, controller.signal, args.timeoutMs);
      if (payload.isErr()) return Result.err(payload.error);

      const signature = signatureFromRemotePayload(payload.value);
      if (!signature) {
        return Result.err(
          new InternalError({ message: "Remote signer response missing signature" }),
        );
      }

      let recovered: Address;
      try {
        recovered = await recoverAddress({ hash: hashTypedData(parameters), signature });
      } catch (cause) {
        const error = new InternalError({
          message: "Remote signer signature was not recoverable",
        });
        error.cause = cause;
        return Result.err(error);
      }
      if (recovered.toLowerCase() !== args.guardianSigner.toLowerCase()) {
        return Result.err(
          new InternalError({
            message: "Remote signer signature did not recover to GUARDIAN_SIGNER_ADDRESS",
          }),
        );
      }

      return Result.ok(signature);
    } finally {
      clearTimeout(timeout);
    }
  };
}

function remoteSignerRequestError(
  cause: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): UpstreamUnavailableError {
  const error = new UpstreamUnavailableError({
    message: signal.aborted
      ? `Remote signer request timed out after ${timeoutMs}ms`
      : "Remote signer request failed",
    status: 503,
  });
  error.cause = cause;
  return error;
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Result<unknown, InternalError | UpstreamUnavailableError>> {
  try {
    return Result.ok(await response.json());
  } catch (cause) {
    if (signal.aborted) {
      const error = new UpstreamUnavailableError({
        message: `Remote signer request timed out after ${timeoutMs}ms`,
        status: 503,
      });
      error.cause = cause;
      return Result.err(error);
    }
    const error = new InternalError({ message: "Remote signer response was not JSON" });
    error.cause = cause;
    return Result.err(error);
  }
}

function signatureFromRemotePayload(payload: unknown): Hex | undefined {
  if (typeof payload === "string" && isSignatureHex(payload)) return payload;
  if (!payload || typeof payload !== "object" || !("signature" in payload)) return undefined;

  const signature = (payload as { signature?: unknown }).signature;
  return typeof signature === "string" && isSignatureHex(signature) ? signature : undefined;
}

function isSignatureHex(value: string): value is Hex {
  return isHex(value) && value.length === 132;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
}

function requiredAddress(env: Record<string, string | undefined>, key: string): Address {
  const value = required(env, key);
  if (!isAddress(value)) throw new Error(`${key} must be a valid address`);
  return value;
}

function remoteSignerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("GUARDIAN_REMOTE_SIGNER_URL must use https unless it points at localhost");
  }
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = host.split(".");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (ipv4.length === 4 &&
      ipv4[0] === "127" &&
      ipv4.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255))
  );
}

function parseRpcClients(value: string): Map<number, PublicClient> {
  const entries = new Map<number, PublicClient>();
  for (const item of value.split(",")) {
    const [rawChainId, ...rawUrlParts] = item.split("=");
    const chainId = positiveInt(rawChainId?.trim(), 0);
    const url = rawUrlParts.join("=").trim();
    if (!url) throw new Error(`invalid GUARDIAN_CHAIN_RPC_URLS entry: ${item}`);
    entries.set(
      chainId,
      createPublicClient({
        chain: defineCoordinatorChain(chainId, url),
        transport: http(url),
      }) as PublicClient,
    );
  }
  if (entries.size === 0) throw new Error("GUARDIAN_CHAIN_RPC_URLS must not be empty");
  return entries;
}

function defineCoordinatorChain(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  });
}

function parseAddressMap(value: string, name: string): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  for (const item of value.split(";")) {
    if (!item.trim()) continue;
    const [rawChainId, rawAddresses] = item.split("=");
    const chainId = positiveInt(rawChainId?.trim(), 0);
    const addresses = new Set<string>();
    for (const rawAddress of (rawAddresses ?? "").split(",")) {
      const address = rawAddress.trim();
      if (!address) continue;
      if (!isAddress(address)) {
        throw new Error(`${name} contains invalid address ${address}`);
      }
      addresses.add(address.toLowerCase());
    }
    if (addresses.size === 0) throw new Error(`${name} has no addresses for chain ${chainId}`);
    map.set(chainId, addresses);
  }
  if (map.size === 0) throw new Error(`${name} must not be empty`);
  return map;
}

function positiveBigInt(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`expected positive bigint: ${value}`);
  return parsed;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const raw = value?.trim() || String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`expected non-negative integer: ${raw}`);
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
