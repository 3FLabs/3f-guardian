import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopLogger, runSigning, zIntentRequestBindingBody } from "@3flabs/guardian";
import {
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  parseAbiParameters,
  zeroHash,
} from "viem";

import { buildGuardianFromEnv } from "../src/cli.js";
import { loadCoordinatorConfig, runGuardianCoordinatorOnce } from "../src/index.js";

const CHAIN_ID = 8453;
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const FACILITY = "0x2222222222222222222222222222222222222222";
const REQUEST_CONTRACT = "0x3333333333333333333333333333333333333333";
const OWNER = "0x4444444444444444444444444444444444444444";

// A request contract recognised by the factory but deployed before the
// lookback window: every getLogs chunk is empty, so the scan ends `tooOld`.
const RPC_RESULTS = {
  eth_blockNumber: "0x4c4b40", // 5,000,000 > lookback, so the window never reaches genesis
  eth_getLogs: [],
};

function ethCall(to: string): string {
  if (to === MULTICALL3) {
    // Stage 1: request.owner(), factory.isRequest(request).
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: encodeAbiParameters([{ type: "address" }], [OWNER]) },
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

let server: Server;
let rpcUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw);
      const result =
        method === "eth_call"
          ? ethCall(String(params[0].to).toLowerCase())
          : RPC_RESULTS[method as keyof typeof RPC_RESULTS];
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id, error: { code: -32601, message: `unexpected ${method}` } }
            : { jsonrpc: "2.0", id, result },
        ),
      );
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
    GUARDIAN_REQUEST_FACTORIES: `${CHAIN_ID}=0x1111111111111111111111111111111111111111`,
    GUARDIAN_REQUEST_OWNERS: `${CHAIN_ID}=${OWNER}`,
    GUARDIAN_REQUEST_PULLERS: `${CHAIN_ID}=0x5555555555555555555555555555555555555555`,
    GUARDIAN_REQUEST_CONSUMERS: `${CHAIN_ID}=0x6666666666666666666666666666666666666666`,
    GUARDIAN_ACCEPTED_FUNDS: `${CHAIN_ID}=0x7777777777777777777777777777777777777777`,
    GUARDIAN_FUND_OWNERS: `${CHAIN_ID}=0x8888888888888888888888888888888888888888`,
    GUARDIAN_PM_FACTORIES: `${CHAIN_ID}=0x9999999999999999999999999999999999999999`,
    GUARDIAN_PM_OWNERS: `${CHAIN_ID}=0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa`,
    GUARDIAN_EVENT_SCAN_BLOCK_RANGE: "10000",
    GUARDIAN_EVENT_SCAN_MAX_LOOKBACK_BLOCKS: "20000",
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

const PULLER = "puller role on request contract is held only by accepted parties";
const CONSUMER = "consumer role on request contract is held only by accepted parties";

describe("GUARDIAN_ON_LOOKBACK_EXHAUSTED", () => {
  it("defaults to skipping the role checks, so unset env signs as before", async () => {
    for (const environment of [env(), env({ GUARDIAN_ON_LOOKBACK_EXHAUSTED: "skip" })]) {
      const signed = await signRequestBinding(environment);
      expect(signed.checks).toEqual(
        expect.arrayContaining([
          { description: PULLER, passed: true, skipped: true },
          { description: CONSUMER, passed: true, skipped: true },
        ]),
      );
    }
  });

  it("fail rejects a request contract older than the lookback window", async () => {
    await expect(
      signRequestBinding(env({ GUARDIAN_ON_LOOKBACK_EXHAUSTED: "fail" })),
    ).rejects.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          description: PULLER,
          passed: false,
          reason: expect.stringMatching(/onLookbackExhausted=fail/),
        }),
        expect.objectContaining({ description: CONSUMER, passed: false }),
      ]),
    });
  });

  it("rejects unknown values at construction", () => {
    for (const value of ["reject", "FAIL", "true"]) {
      expect(() => buildGuardianFromEnv(env({ GUARDIAN_ON_LOOKBACK_EXHAUSTED: value }))).toThrow(
        /GUARDIAN_ON_LOOKBACK_EXHAUSTED must be skip or fail/,
      );
    }
  });
});

describe("per-chain coordinator base URL", () => {
  it("keeps a /v2/chains/<id> prefix ahead of the /v1 paths", async () => {
    const config = loadCoordinatorConfig({
      COORDINATOR_BASE_URL: "https://guardian.3f.xyz/v2/chains/8453/",
      COORDINATOR_API_KEY: "key",
      CHAIN_IDS: "8453",
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
      "https://guardian.3f.xyz/v2/chains/8453/v1/guardian/signing-requests?status=open&page=1&pageSize=100&chainId=8453",
    ]);
  });
});
