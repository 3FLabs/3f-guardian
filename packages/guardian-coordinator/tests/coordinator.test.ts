import { afterEach, describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import type { SigningSuccess } from "@3flabs/guardian";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  loadCoordinatorConfig,
  runGuardianCoordinatorOnce,
  type GuardianCoordinatorOptions,
} from "../src/index.js";
import { buildGuardianFromEnv as buildCliGuardianFromEnv } from "../src/cli.js";
import { awsKmsSignTypedData, gcpKmsSignTypedData } from "../src/kms-signers.js";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const FACILITY = "0x2222222222222222222222222222222222222222";
const OTHER_FACILITY = "0x9999999999999999999999999999999999999999";
const GUARDIAN = "0x0000000000000000000000000000000000000001";
const HASH = `0x${"b".repeat(64)}` as `0x${string}`;
const OTHER_HASH = `0x${"c".repeat(64)}` as `0x${string}`;
const SIGNATURE = `0x${"a".repeat(130)}` as `0x${string}`;
const KMS_PRIVATE_KEY = `0x${"12".repeat(32)}` as const;
const KMS_ACCOUNT = privateKeyToAccount(KMS_PRIVATE_KEY);
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

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

const TYPED_DATA = {
  domain: {
    name: "GuardianTest",
    version: "1",
    chainId: 1,
    verifyingContract: FACILITY,
  },
  types: {
    Ping: [{ name: "id", type: "uint256" }],
  },
  primaryType: "Ping",
  message: {
    id: 1n,
  },
} as const;

const quiet = {
  log() {},
  error() {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

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

    await expect(runGuardianCoordinatorOnce(options)).resolves.toBeUndefined();
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

    await expect(runGuardianCoordinatorOnce(options)).resolves.toBeUndefined();
    expect(seen).toEqual(["set_request", "set_fund", "swap"]);
  });

  it("skips malformed rows without dropping valid rows in the same page", async () => {
    const errors: string[] = [];
    const signCalls: string[] = [];
    const submitBodies: unknown[] = [];
    const options = optionsFor({
      signIntentRequestBinding: async () => {
        signCalls.push("called");
        return Result.ok(SIGNING_SUCCESS);
      },
    });
    options.logger = {
      log() {},
      error(message) {
        errors.push(String(message));
      },
    };
    options.fetcher = async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://coordinator.test/v1/guardian/signing-requests?")) {
        return json({
          total: 2,
          page: 1,
          pageSize: 100,
          items: [{ ...SIGNING_REQUEST, kind: "unknown" }, SIGNING_REQUEST],
        });
      }
      if (url === `http://coordinator.test/v1/guardian/signing-requests/${REQUEST_ID}/submission`) {
        submitBodies.push(JSON.parse(String(init?.body)));
        return json({ status: "accepted", quorumReached: true, submissionCount: 1 });
      }
      throw new Error(`unexpected call ${url}`);
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toBeUndefined();
    expect(errors.some((message) => message.includes("skipping malformed"))).toBe(true);
    expect(signCalls).toHaveLength(1);
    expect(submitBodies).toEqual([{ chainId: 1, signature: SIGNATURE }]);
  });

  it("sends configured chain and facility filters to grunt-api", async () => {
    const urls: string[] = [];
    const options = optionsFor();
    options.chainIds = new Set([1, 8453]);
    options.facilities = new Set([FACILITY, OTHER_FACILITY]);
    options.fetcher = async (input) => {
      urls.push(String(input));
      return json({ total: 0, page: 1, pageSize: 100, items: [] });
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toBeUndefined();
    expect(
      urls.map((url) => {
        const params = new URL(url).searchParams;
        return { chainId: params.get("chainId"), facility: params.get("facility") };
      }),
    ).toEqual([
      { chainId: "1", facility: FACILITY },
      { chainId: "1", facility: OTHER_FACILITY },
      { chainId: "8453", facility: FACILITY },
      { chainId: "8453", facility: OTHER_FACILITY },
    ]);
  });

  it("treats empty filter sets as absent", async () => {
    const urls: string[] = [];
    const options = optionsFor();
    options.chainIds = new Set();
    options.facilities = new Set();
    options.fetcher = async (input) => {
      urls.push(String(input));
      return json({ total: 0, page: 1, pageSize: 100, items: [] });
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toBeUndefined();
    expect(urls).toHaveLength(1);
    const params = new URL(urls[0]!).searchParams;
    expect(params.has("chainId")).toBe(false);
    expect(params.has("facility")).toBe(false);
  });

  it("skips rows this guardian already handled", async () => {
    const signCalls: unknown[] = [];
    const options = optionsFor({
      signIntentRequestBinding: async () => {
        signCalls.push("called");
        return Result.ok(SIGNING_SUCCESS);
      },
    });
    options.fetcher = async (input) => {
      expect(String(input)).toContain("/v1/guardian/signing-requests?");
      return json({
        total: 1,
        page: 1,
        pageSize: 100,
        items: [{ ...SIGNING_REQUEST, mySubmission: { id: "mine" } }],
      });
    };

    await expect(runGuardianCoordinatorOnce(options)).resolves.toBeUndefined();
    expect(signCalls).toHaveLength(0);
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

    await expect(runGuardianCoordinatorOnce(options)).resolves.toBeUndefined();
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

    await expect(runGuardianCoordinatorOnce(options)).resolves.toBeUndefined();
    expect(signCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("loads the coordinator env config", () => {
    expect(
      loadCoordinatorConfig({
        COORDINATOR_BASE_URL: "https://coordinator.test/",
        COORDINATOR_API_KEY: "guardian-key",
        CHAIN_IDS: "1,8453",
        FACILITIES: FACILITY,
      }),
    ).toMatchObject({
      coordinatorBaseUrl: "https://coordinator.test",
      chainIds: new Set([1, 8453]),
      facilities: new Set([FACILITY]),
    });
  });

  it("ignores empty comma-only coordinator filters", () => {
    const config = loadCoordinatorConfig({
      COORDINATOR_BASE_URL: "https://coordinator.test/",
      COORDINATOR_API_KEY: "guardian-key",
      CHAIN_IDS: ",",
      FACILITIES: ",",
    });

    expect(config.chainIds).toBeUndefined();
    expect(config.facilities).toBeUndefined();
  });

  it("rejects non-local http coordinator URLs", () => {
    expect(() =>
      loadCoordinatorConfig({
        COORDINATOR_BASE_URL: "http://coordinator.test/",
        COORDINATOR_API_KEY: "guardian-key",
      }),
    ).toThrow(/https/);
    expect(() =>
      loadCoordinatorConfig({
        COORDINATOR_BASE_URL: "http://127.0.0.1.attacker.example/",
        COORDINATOR_API_KEY: "guardian-key",
      }),
    ).toThrow(/https/);
    expect(
      loadCoordinatorConfig({
        COORDINATOR_BASE_URL: "http://localhost:3000/",
        COORDINATOR_API_KEY: "guardian-key",
      }).coordinatorBaseUrl,
    ).toBe("http://localhost:3000");
    expect(
      loadCoordinatorConfig({
        COORDINATOR_BASE_URL: "http://127.0.0.1:3000/",
        COORDINATOR_API_KEY: "guardian-key",
      }).coordinatorBaseUrl,
    ).toBe("http://127.0.0.1:3000");
  });

  it("builds the runnable guardian from env", () => {
    const guardian = buildCliGuardianFromEnv({
      ...CLI_ENV,
      GUARDIAN_SIGNER_KEY: `0x${"11".repeat(32)}`,
      GUARDIAN_SWAP_PRICE_TOLERANCE_BPS: "0",
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

  it("builds a remote-http signer from env without a raw key", async () => {
    const signature = await KMS_ACCOUNT.signTypedData(TYPED_DATA);
    const fetchCalls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return json({ signature });
    });

    const guardian = buildCliGuardianFromEnv({
      ...CLI_ENV,
      GUARDIAN_SIGNER_PROVIDER: "remote_http",
      GUARDIAN_SIGNER_ADDRESS: KMS_ACCOUNT.address,
      GUARDIAN_REMOTE_SIGNER_URL: "http://localhost:9090/sign",
      GUARDIAN_REMOTE_SIGNER_BEARER_TOKEN: "remote-token",
      GUARDIAN_REMOTE_SIGNER_TIMEOUT_MS: "2500",
    });

    expect(guardian.metadata.guardianSigner).toBe(KMS_ACCOUNT.address);

    const result = await guardian.signTypedData(TYPED_DATA);

    if (result.isErr()) throw result.error;
    expect(result.value).toBe(signature);
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    if (!call) throw new Error("missing remote signer fetch call");
    expect(call.input).toBe("http://localhost:9090/sign");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    expect(call.init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer remote-token",
    });
    expect(JSON.parse(String(call.init?.body))).toEqual({
      typedData: {
        domain: {
          name: "GuardianTest",
          version: "1",
          chainId: 1,
          verifyingContract: FACILITY,
        },
        types: {
          Ping: [{ name: "id", type: "uint256" }],
        },
        primaryType: "Ping",
        message: {
          id: "1",
        },
      },
    });
  });

  it("rejects remote-http signatures from the wrong signer", async () => {
    const signature = await KMS_ACCOUNT.signTypedData(TYPED_DATA);
    vi.stubGlobal("fetch", async () => json({ signature }));

    const guardian = buildCliGuardianFromEnv({
      ...CLI_ENV,
      GUARDIAN_SIGNER_PROVIDER: "remote_http",
      GUARDIAN_SIGNER_ADDRESS: GUARDIAN,
      GUARDIAN_REMOTE_SIGNER_URL: "http://localhost:9090/sign",
    });

    const result = await guardian.signTypedData(TYPED_DATA);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/recover to GUARDIAN_SIGNER_ADDRESS/);
    }
  });

  it("rejects non-local http remote signer URLs", () => {
    expect(() =>
      buildCliGuardianFromEnv({
        ...CLI_ENV,
        GUARDIAN_SIGNER_PROVIDER: "remote_http",
        GUARDIAN_SIGNER_ADDRESS: GUARDIAN,
        GUARDIAN_REMOTE_SIGNER_URL: "http://127.0.0.1.attacker.example/sign",
      }),
    ).toThrow(/https/);
    expect(
      buildCliGuardianFromEnv({
        ...CLI_ENV,
        GUARDIAN_SIGNER_PROVIDER: "remote_http",
        GUARDIAN_SIGNER_ADDRESS: GUARDIAN,
        GUARDIAN_REMOTE_SIGNER_URL: "http://127.0.0.1:9090/sign",
      }).metadata.guardianSigner,
    ).toBe(GUARDIAN);
  });

  it("builds aws-kms and gcp-kms signers from env without a raw key", () => {
    const awsGuardian = buildCliGuardianFromEnv({
      ...CLI_ENV,
      GUARDIAN_SIGNER_PROVIDER: "aws_kms",
      GUARDIAN_SIGNER_ADDRESS: KMS_ACCOUNT.address,
      GUARDIAN_AWS_KMS_KEY_ID: "alias/guardian",
      AWS_REGION: "us-east-1",
    });
    expect(awsGuardian.metadata.guardianSigner).toBe(KMS_ACCOUNT.address);

    const gcpGuardian = buildCliGuardianFromEnv({
      ...CLI_ENV,
      GUARDIAN_SIGNER_PROVIDER: "gcp_kms",
      GUARDIAN_SIGNER_ADDRESS: KMS_ACCOUNT.address,
      GUARDIAN_GCP_KMS_KEY_VERSION:
        "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
    });
    expect(gcpGuardian.metadata.guardianSigner).toBe(KMS_ACCOUNT.address);
  });

  it("aws-kms signs the EIP-712 digest and returns an Ethereum signature", async () => {
    const derSignature = await derFromTypedDataSignature();
    const digests: Hex[] = [];
    const signer = awsKmsSignTypedData({
      keyId: "alias/guardian",
      guardianSigner: KMS_ACCOUNT.address,
      signDigest: async ({ keyId, digest }) => {
        expect(keyId).toBe("alias/guardian");
        digests.push(digest);
        return derSignature;
      },
    });

    const result = await signer(TYPED_DATA);

    if (result.isErr()) throw result.error;
    expect(digests).toEqual([hashTypedData(TYPED_DATA)]);
    await expect(recoverTypedDataAddress({ ...TYPED_DATA, signature: result.value })).resolves.toBe(
      KMS_ACCOUNT.address,
    );
  });

  it("gcp-kms normalizes high-S signatures before returning Ethereum hex", async () => {
    const derSignature = await derFromTypedDataSignature({ highS: true });
    const signer = gcpKmsSignTypedData({
      keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
      guardianSigner: KMS_ACCOUNT.address,
      signDigest: async ({ keyVersionName, digest }) => {
        expect(keyVersionName).toContain("/cryptoKeyVersions/1");
        expect(digest).toBe(hashTypedData(TYPED_DATA));
        return derSignature;
      },
    });

    const result = await signer(TYPED_DATA);

    if (result.isErr()) throw result.error;
    const s = BigInt(`0x${result.value.slice(66, 130)}`);
    expect(s).toBeLessThanOrEqual(SECP256K1_N / 2n);
    await expect(recoverTypedDataAddress({ ...TYPED_DATA, signature: result.value })).resolves.toBe(
      KMS_ACCOUNT.address,
    );
  });

  it("rejects checksum-invalid allowlist addresses", () => {
    expect(() =>
      buildCliGuardianFromEnv({
        ...CLI_ENV,
        GUARDIAN_SIGNER_KEY: `0x${"11".repeat(32)}`,
        GUARDIAN_REQUEST_FACTORIES: "1=0x52908400098527886E0F7030069857D2E4169Ee7",
      }),
    ).toThrow(/invalid address/);
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

async function derFromTypedDataSignature(options: { highS?: boolean } = {}): Promise<Uint8Array> {
  const signature = await KMS_ACCOUNT.signTypedData(TYPED_DATA);
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const rawS = BigInt(`0x${signature.slice(66, 130)}`);
  const s = options.highS ? SECP256K1_N - rawS : rawS;
  return derEncode(r, s);
}

function derEncode(r: bigint, s: bigint): Uint8Array {
  const rBytes = derInteger(r);
  const sBytes = derInteger(s);
  return concatBytes(
    Uint8Array.of(0x30, 2 + rBytes.length + 2 + sBytes.length),
    Uint8Array.of(0x02, rBytes.length),
    rBytes,
    Uint8Array.of(0x02, sBytes.length),
    sBytes,
  );
}

function derInteger(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  if (Number.parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
