import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { noopLogger, runSigning, zIntentRequestBindingBody } from "@3flabs/guardian";
import { requestAbi, requestFactoryAbi } from "@3flabs/guardian-defaults";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  parseAbiParameters,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import { buildGuardianFromEnv } from "../src/cli.js";
import { loadCoordinatorConfig, runGuardianCoordinatorOnce } from "../src/index.js";

const CHAIN_ID = 31337;
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const FACTORY = "0x1111111111111111111111111111111111111111";
const FACILITY = "0x2222222222222222222222222222222222222222";
const REQUEST_CONTRACT = "0x3333333333333333333333333333333333333333";
const OWNER = "0x4444444444444444444444444444444444444444";
const PULLER: Address = "0x5555555555555555555555555555555555555555";
const CONSUMER: Address = "0x6666666666666666666666666666666666666666";

// Head 5,000,000 with a 20,000-block lookback: the window is
// [4,980,000, 5,000,000] and never reaches genesis.
const HEAD = 5_000_000n;
const LOOKBACK = 20_000n;
const BEFORE_WINDOW = HEAD - LOOKBACK - 1n;

type RpcError = { code: number; message: string };

/**
 * Per-test JSON-RPC behaviour. Defaults: the factory recognises the
 * request contract, it has code at every block (so it predates the
 * window), and every log chunk is empty.
 */
let rpc: {
  ownerReturnData: Hex;
  code: Hex | RpcError;
  logs: unknown[];
  calls: Array<{ method: string; params: unknown[] }>;
};

beforeEach(() => {
  rpc = {
    ownerReturnData: encodeAbiParameters([{ type: "address" }], [OWNER]),
    code: "0x6080",
    logs: [],
    calls: [],
  };
});

function ethCall(to: string): Hex {
  if (to === MULTICALL3) {
    // Stage 1: request.owner(), factory.isRequest(request).
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: rpc.ownerReturnData },
        { success: true, returnData: encodeAbiParameters([{ type: "bool" }], [true]) },
      ],
    });
  }
  // Facility eip712Domain(), read when building the typed data.
  return encodeAbiParameters(
    parseAbiParameters("bytes1, string, string, uint256, address, bytes32, uint256[]"),
    ["0x0f", "Facility", "1", BigInt(CHAIN_ID), FACILITY, zeroHash, []],
  );
}

function answer(method: string, params: unknown[]): { result: unknown } | { error: RpcError } {
  switch (method) {
    case "eth_call":
      return { result: ethCall(String((params[0] as { to: string }).to).toLowerCase()) };
    case "eth_blockNumber":
      return { result: numberToHex(HEAD) };
    case "eth_getCode":
      return typeof rpc.code === "string" ? { result: rpc.code } : { error: rpc.code };
    case "eth_getLogs":
      return { result: rpc.logs };
    default:
      return { error: { code: -32601, message: `unexpected ${method}` } };
  }
}

let server: Server;
let rpcUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw);
      rpc.calls.push({ method, params });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...answer(method, params) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    GUARDIAN_SIGNER_KEY: `0x${"11".repeat(32)}`,
    GUARDIAN_CHAIN_RPC_URLS: `${CHAIN_ID}=${rpcUrl}`,
    GUARDIAN_REQUEST_FACTORIES: `${CHAIN_ID}=${FACTORY}`,
    GUARDIAN_REQUEST_OWNERS: `${CHAIN_ID}=${OWNER}`,
    GUARDIAN_REQUEST_PULLERS: `${CHAIN_ID}=${PULLER}`,
    GUARDIAN_REQUEST_CONSUMERS: `${CHAIN_ID}=${CONSUMER}`,
    GUARDIAN_ACCEPTED_FUNDS: `${CHAIN_ID}=0x7777777777777777777777777777777777777777`,
    GUARDIAN_FUND_OWNERS: `${CHAIN_ID}=0x8888888888888888888888888888888888888888`,
    GUARDIAN_PM_FACTORIES: `${CHAIN_ID}=0x9999999999999999999999999999999999999999`,
    GUARDIAN_PM_OWNERS: `${CHAIN_ID}=0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa`,
    GUARDIAN_EVENT_SCAN_BLOCK_RANGE: "10000",
    GUARDIAN_EVENT_SCAN_MAX_LOOKBACK_BLOCKS: String(LOOKBACK),
    ...overrides,
  };
}

function signRequestBinding(environment: Record<string, string>) {
  const guardian = buildGuardianFromEnv(environment);
  return runSigning({
    abs: guardian,
    sign: guardian.signIntentRequestBinding,
    body: zIntentRequestBindingBody.parse({
      chainId: CHAIN_ID,
      facility: FACILITY,
      intent: { id: "7" },
      requestContract: REQUEST_CONTRACT,
      deadline: Math.floor(Date.now() / 1000) + 300,
    }),
    requestId: "550e8400-e29b-41d4-a716-446655440000",
    tokenInfo: { tokenId: "test", scopes: new Set(), requiresHmac: false },
    logger: noopLogger,
  });
}

function count(method: string): number {
  return rpc.calls.filter((call) => call.method === method).length;
}

/** Raw JSON-RPC log at a block inside the window. */
function log(address: string, topics: Hex[], data: Hex, logIndex: number) {
  return {
    address,
    topics,
    data,
    blockNumber: numberToHex(4_995_000n),
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: `0x${"cd".repeat(32)}`,
    transactionIndex: "0x0",
    logIndex: numberToHex(logIndex),
    removed: false,
  };
}

function rolesUpdated(user: Address, roles: bigint, logIndex: number) {
  return log(
    REQUEST_CONTRACT,
    encodeEventTopics({
      abi: requestAbi,
      eventName: "RolesUpdated",
      args: { user, roles },
    }) as Hex[],
    "0x",
    logIndex,
  );
}

const PULLER_CHECK = "puller role on request contract is held only by accepted parties";
const CONSUMER_CHECK = "consumer role on request contract is held only by accepted parties";
const FACTORY_CHECK = "request contract was deployed by an accepted factory";

const rejectedAsTooOld = {
  checks: expect.arrayContaining([
    expect.objectContaining({
      description: PULLER_CHECK,
      passed: false,
      reason: expect.stringMatching(/onLookbackExhausted=fail/),
    }),
    expect.objectContaining({ description: CONSUMER_CHECK, passed: false }),
  ]),
};

describe("GUARDIAN_ON_LOOKBACK_EXHAUSTED", () => {
  it("fails closed when unset, so a misspelled variable name cannot re-enable skip", async () => {
    for (const environment of [
      env(),
      env({ GUARDIAN_ON_LOOKBACK_EXHAUSTED: " " }),
      env({ GUARDIAN_ON_LOOKBACK_EXHAUST: "skip" }),
    ]) {
      await expect(signRequestBinding(environment)).rejects.toMatchObject(rejectedAsTooOld);
    }
  });

  it("signs with the role checks skipped only when set to exactly skip", async () => {
    const signed = await signRequestBinding(env({ GUARDIAN_ON_LOOKBACK_EXHAUSTED: "skip" }));
    expect(signed.checks).toEqual(
      expect.arrayContaining([
        { description: PULLER_CHECK, passed: true, skipped: true },
        { description: CONSUMER_CHECK, passed: true, skipped: true },
      ]),
    );
    // skip keeps scanning the window for rogue grants; it never probes.
    expect(count("eth_getCode")).toBe(0);
    expect(count("eth_getLogs")).toBe(3);
  });

  it("rejects unknown values at construction", () => {
    for (const value of ["reject", "FAIL", "Skip", "true"]) {
      expect(() => buildGuardianFromEnv(env({ GUARDIAN_ON_LOOKBACK_EXHAUSTED: value }))).toThrow(
        /GUARDIAN_ON_LOOKBACK_EXHAUSTED must be skip or fail/,
      );
    }
  });
});

describe("creation lookup under fail", () => {
  it("rejects a contract that already had code before the window without scanning logs", async () => {
    await expect(signRequestBinding(env())).rejects.toMatchObject(rejectedAsTooOld);
    const probes = rpc.calls.filter((call) => call.method === "eth_getCode");
    expect(probes.map((call) => call.params)).toEqual([
      [REQUEST_CONTRACT, numberToHex(BEFORE_WINDOW)],
    ]);
    expect(count("eth_getLogs")).toBe(0);
  });

  it("scans and signs a contract deployed inside the window", async () => {
    rpc.code = "0x";
    rpc.logs = [
      log(
        FACTORY,
        encodeEventTopics({ abi: requestFactoryAbi, eventName: "RequestCreated" }) as Hex[],
        encodeAbiParameters(parseAbiParameters("address, address, address, address"), [
          REQUEST_CONTRACT,
          FACTORY,
          FACTORY,
          FACTORY,
        ]),
        0,
      ),
      rolesUpdated(PULLER, 1n, 1),
      rolesUpdated(CONSUMER, 2n, 2),
    ];

    const signed = await signRequestBinding(env());

    expect(signed.checks).toEqual(
      expect.arrayContaining([
        { description: PULLER_CHECK, passed: true, skipped: false },
        { description: CONSUMER_CHECK, passed: true, skipped: false },
      ]),
    );
    // The deployment sits in the newest chunk, so the scan stops there.
    expect(count("eth_getLogs")).toBe(1);
  });

  it("falls back to the scan when the RPC cannot serve historical state", async () => {
    rpc.code = { code: -32000, message: "missing trie node" };
    await expect(signRequestBinding(env())).rejects.toMatchObject(rejectedAsTooOld);
    expect(count("eth_getLogs")).toBe(3);
  });

  it("rejects a contract with no code at all before any lookup", async () => {
    rpc.ownerReturnData = "0x";
    rpc.code = "0x";
    await expect(signRequestBinding(env())).rejects.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({ description: FACTORY_CHECK, passed: false }),
      ]),
    });
    expect(count("eth_getCode")).toBe(0);
    expect(count("eth_getLogs")).toBe(0);
  });
});

describe("per-chain coordinator base URL", () => {
  it("keeps a /v2/chains/<id> prefix ahead of the /v1 paths", async () => {
    const config = loadCoordinatorConfig({
      COORDINATOR_BASE_URL: "https://coordinator.example/v2/chains/31337/",
      COORDINATOR_API_KEY: "key",
      CHAIN_IDS: "31337",
    });
    const urls: string[] = [];
    await runGuardianCoordinatorOnce({
      ...config,
      guardian: buildGuardianFromEnv(env()),
      fetcher: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ total: 0, page: 1, pageSize: 100, items: [] }));
      },
    });
    expect(urls).toEqual([
      "https://coordinator.example/v2/chains/31337/v1/guardian/signing-requests?status=open&page=1&pageSize=100&chainId=31337",
    ]);
  });
});
