import { describe, expect, it } from "vitest";
import { Result } from "better-result";
import type { SigningSuccess } from "@3flabs/guardian";

import {
  loadCoordinatorConfig,
  runGuardianCoordinatorOnce,
  type GuardianCoordinatorOptions,
} from "../src/index.js";
import { buildGuardianFromEnv as buildCliGuardianFromEnv } from "../src/cli.js";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const FACILITY = "0x2222222222222222222222222222222222222222";
const GUARDIAN = "0x0000000000000000000000000000000000000001";
const HASH = `0x${"b".repeat(64)}` as `0x${string}`;
const OTHER_HASH = `0x${"c".repeat(64)}` as `0x${string}`;
const SIGNATURE = `0x${"a".repeat(130)}` as `0x${string}`;

const REQUEST_BODY = {
  chainId: 1,
  facility: FACILITY,
  intent: { id: "7" },
  requestContract: "0x3333333333333333333333333333333333333333",
  deadline: 1_800_000_000,
};

const SIGNING_REQUEST = {
  id: REQUEST_ID,
  kind: "set_request",
  chainId: 1,
  facility: FACILITY,
  payloadHash: HASH,
  body: REQUEST_BODY,
  mySubmission: null,
};

const SIGNING_SUCCESS = {
  guardian: GUARDIAN,
  signature: SIGNATURE,
  payloadHash: HASH,
  signedAt: "2026-04-22T10:15:00Z",
  checks: [],
} satisfies SigningSuccess;

const quiet = {
  log() {},
  error() {},
};

describe("guardian coordinator", () => {
  it("signs open requests directly and submits to grunt-api", async () => {
    const signCalls: unknown[] = [];
    const submitBodies: unknown[] = [];
    const options = optionsFor({
      signIntentRequestBinding: async (ctx, body) => {
        signCalls.push({ ctx, body });
        expect(ctx.chainId).toBe(1);
        expect(ctx.tokenId).toBe("guardian-coordinator");
        expect(ctx.signal).toBeInstanceOf(AbortSignal);
        expect(body).toEqual(REQUEST_BODY);
        return Result.ok(SIGNING_SUCCESS);
      },
    });

    options.fetcher = async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://coordinator.test/v1/guardian/signing-requests?")) {
        expect(init?.headers).toEqual({ "x-api-key": "guardian-key" });
        return json({ total: 1, page: 1, pageSize: 100, items: [SIGNING_REQUEST] });
      }

      if (url === `http://coordinator.test/v1/guardian/signing-requests/${REQUEST_ID}/submission`) {
        expect(init?.method).toBe("PUT");
        expect(init?.headers).toEqual({
          "content-type": "application/json",
          "x-api-key": "guardian-key",
        });
        submitBodies.push(JSON.parse(String(init?.body)));
        return json({ status: "accepted", quorumReached: true, submissionCount: 1 });
      }

      throw new Error(`unexpected call ${url}`);
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toEqual({
      seen: 1,
      submitted: 1,
      skipped: 0,
      failed: 0,
    });
    expect(signCalls).toHaveLength(1);
    expect(submitBodies).toEqual([{ chainId: 1, signature: SIGNATURE }]);
  });

  it("maps each signing kind to the matching guardian function", async () => {
    const seen: string[] = [];
    const options = optionsFor({
      signIntentRequestBinding: async () => {
        seen.push("set_request");
        return Result.ok(SIGNING_SUCCESS);
      },
      signIntentFundBinding: async () => {
        seen.push("set_fund");
        return Result.ok(SIGNING_SUCCESS);
      },
      signIntentSwap: async () => {
        seen.push("swap");
        return Result.ok(SIGNING_SUCCESS);
      },
    });
    options.fetcher = async (input) => {
      const url = String(input);
      if (url.startsWith("http://coordinator.test/v1/guardian/signing-requests?")) {
        return json({
          total: 3,
          page: 1,
          pageSize: 100,
          items: [
            SIGNING_REQUEST,
            {
              ...SIGNING_REQUEST,
              id: "650e8400-e29b-41d4-a716-446655440000",
              kind: "set_fund",
              body: {
                chainId: 1,
                facility: FACILITY,
                intent: { id: "7" },
                fundContract: "0x4444444444444444444444444444444444444444",
                positionManager: "0x5555555555555555555555555555555555555555",
                deadline: 1_800_000_000,
              },
            },
            {
              ...SIGNING_REQUEST,
              id: "750e8400-e29b-41d4-a716-446655440000",
              kind: "swap",
              body: {
                chainId: 1,
                facility: FACILITY,
                legs: [
                  {
                    intent: { id: "7" },
                    asset: "0x6666666666666666666666666666666666666666",
                    amount: "1",
                  },
                  {
                    intent: { id: "8" },
                    asset: "0x7777777777777777777777777777777777777777",
                    amount: "2",
                  },
                ],
                deadline: 1_800_000_000,
              },
            },
          ],
        });
      }
      return json({ status: "accepted", quorumReached: true, submissionCount: 1 });
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toMatchObject({
      submitted: 3,
      failed: 0,
    });
    expect(seen).toEqual(["set_request", "set_fund", "swap"]);
  });

  it("skips rows this guardian already handled", async () => {
    const options = optionsFor();
    options.fetcher = async (input) => {
      expect(String(input)).toContain("/v1/guardian/signing-requests?");
      return json({
        total: 1,
        page: 1,
        pageSize: 100,
        items: [{ ...SIGNING_REQUEST, mySubmission: { id: "mine" } }],
      });
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toEqual({
      seen: 1,
      submitted: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it("does not submit when the signer returns a different payloadHash", async () => {
    const calls: string[] = [];
    const options = optionsFor({
      signIntentRequestBinding: async () =>
        Result.ok({ ...SIGNING_SUCCESS, payloadHash: OTHER_HASH }),
    });
    options.fetcher = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("http://coordinator.test/v1/guardian/signing-requests?")) {
        return json({ total: 1, page: 1, pageSize: 100, items: [SIGNING_REQUEST] });
      }
      throw new Error(`unexpected call ${url}`);
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toEqual({
      seen: 1,
      submitted: 0,
      skipped: 0,
      failed: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects coordinator metadata that does not match the signed body", async () => {
    const signCalls: unknown[] = [];
    const options = optionsFor({
      signIntentRequestBinding: async () => {
        signCalls.push("called");
        return Result.ok(SIGNING_SUCCESS);
      },
    });
    const calls: string[] = [];
    options.fetcher = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("http://coordinator.test/v1/guardian/signing-requests?")) {
        return json({
          total: 1,
          page: 1,
          pageSize: 100,
          items: [{ ...SIGNING_REQUEST, chainId: 2 }],
        });
      }
      throw new Error(`unexpected call ${url}`);
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toEqual({
      seen: 1,
      submitted: 0,
      skipped: 0,
      failed: 1,
    });
    expect(signCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("loads the coordinator env config", () => {
    expect(
      loadCoordinatorConfig({
        COORDINATOR_BASE_URL: "http://coordinator.test/",
        COORDINATOR_API_KEY: "guardian-key",
        CHAIN_IDS: "1,8453",
        FACILITIES: FACILITY,
      }),
    ).toMatchObject({
      coordinatorBaseUrl: "http://coordinator.test",
      chainIds: new Set([1, 8453]),
      facilities: new Set([FACILITY]),
    });
  });

  it("builds the runnable guardian from env", () => {
    const guardian = buildCliGuardianFromEnv({
      ...CLI_ENV,
      GUARDIAN_SIGNER_KEY: `0x${"11".repeat(32)}`,
    });

    expect(guardian.metadata.supportedChains).toEqual([1]);
    expect(guardian.metadata.guardianSigner).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const client = guardian.getChainClient(1);
    expect(client.isErr()).toBe(false);
    if (client.isErr()) throw client.error;
    expect(client.value.chain?.id).toBe(1);
    expect(client.value.chain?.contracts?.multicall3?.address).toBe(
      "0xca11bde05977b3631167028862be2a173976ca11",
    );
    expect(guardian.getChainClient(2).isErr()).toBe(true);
  });
});

const CLI_ENV = {
  GUARDIAN_CHAIN_RPC_URLS: "1=http://127.0.0.1:8545",
  GUARDIAN_REQUEST_FACTORIES: "1=0x1111111111111111111111111111111111111111",
  GUARDIAN_REQUEST_OWNERS: "1=0x2222222222222222222222222222222222222222",
  GUARDIAN_REQUEST_PULLERS: "1=0x3333333333333333333333333333333333333333",
  GUARDIAN_REQUEST_CONSUMERS: "1=0x4444444444444444444444444444444444444444",
  GUARDIAN_ACCEPTED_FUNDS: "1=0x5555555555555555555555555555555555555555",
  GUARDIAN_FUND_OWNERS: "1=0x6666666666666666666666666666666666666666",
  GUARDIAN_PM_FACTORIES: "1=0x7777777777777777777777777777777777777777",
  GUARDIAN_PM_OWNERS: "1=0x8888888888888888888888888888888888888888",
};

function optionsFor(
  guardianOverrides: Partial<GuardianCoordinatorOptions["guardian"]> = {},
): GuardianCoordinatorOptions {
  return {
    coordinatorBaseUrl: "http://coordinator.test",
    coordinatorApiKey: "guardian-key",
    pollIntervalMs: 5_000,
    pageSize: 100,
    fetcher: async () => json({ total: 0, page: 1, pageSize: 100, items: [] }),
    logger: quiet,
    guardian: {
      metadata: {
        build: "0.0.0+test",
        guardianSigner: GUARDIAN,
        supportedChains: [1],
      },
      getChainClient: () => Result.ok({} as never),
      signTypedData: async () => Result.ok(SIGNATURE),
      signIntentRequestBinding: async () => Result.ok(SIGNING_SUCCESS),
      signIntentFundBinding: async () => Result.ok(SIGNING_SUCCESS),
      signIntentSwap: async () => Result.ok(SIGNING_SUCCESS),
      ...guardianOverrides,
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
