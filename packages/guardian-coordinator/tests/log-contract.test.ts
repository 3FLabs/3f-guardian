import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Result } from "better-result";
import type { SigningSuccess } from "@3flabs/guardian";

import { runGuardianCoordinatorCycle, type GuardianCoordinatorOptions } from "../src/index.js";
import { fatalLine, startupLine } from "../src/cli.js";

/**
 * Verifies log-contract.json in both directions against real emissions:
 * every pattern is produced by at least one code path, and every
 * produced line matches at least one pattern. Monitoring builds its
 * regexes from that file, so a failure here means downstream alerting
 * would break.
 */
const contract = JSON.parse(
  readFileSync(new URL("../log-contract.json", import.meta.url), "utf8"),
) as { patterns: Record<string, string> };

const FACILITY = "0x2222222222222222222222222222222222222222";
const GUARDIAN = "0x0000000000000000000000000000000000000001";
const HASH = `0x${"b".repeat(64)}` as `0x${string}`;
const SIGNATURE = `0x${"a".repeat(130)}` as `0x${string}`;

const VALID_BODY = {
  chainId: 1,
  facility: FACILITY,
  intent: { id: "7" },
  requestContract: "0x3333333333333333333333333333333333333333",
  deadline: 1_800_000_000,
};

const VALID_ROW = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  kind: "set_request",
  chainId: 1,
  facility: FACILITY,
  payloadHash: HASH,
  body: VALID_BODY,
  mySubmission: null,
};

const SIGNING_SUCCESS = {
  guardian: GUARDIAN,
  signature: SIGNATURE,
  payloadHash: HASH,
  signedAt: "2026-08-14T10:00:00Z",
  checks: [],
} satisfies SigningSuccess;

function optionsWith(
  fetcher: GuardianCoordinatorOptions["fetcher"],
  logger: GuardianCoordinatorOptions["logger"],
): GuardianCoordinatorOptions {
  return {
    coordinatorBaseUrl: "http://coordinator.test",
    coordinatorApiKey: "guardian-key",
    pollIntervalMs: 5_000,
    pageSize: 100,
    fetcher,
    logger,
    guardian: {
      metadata: { build: "1.2.3", guardianSigner: GUARDIAN, supportedChains: [1] },
      getChainClient: () => Result.ok({} as never),
      signTypedData: async () => Result.ok(SIGNATURE),
      signIntentRequestBinding: async () => Result.ok(SIGNING_SUCCESS),
      signIntentFundBinding: async () => Result.ok(SIGNING_SUCCESS),
      signIntentSwap: async () => Result.ok(SIGNING_SUCCESS),
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("log contract", () => {
  it("matches every emitted line and exercises every pattern", async () => {
    const lines: string[] = [];
    const logger = {
      log: (...args: unknown[]) => void lines.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => void lines.push(args.map(String).join(" ")),
    };

    // One page driving the submitted, malformed and signing-failed
    // paths: a valid row, a row with an unknown kind, and a row whose
    // chainId contradicts its body.
    await runGuardianCoordinatorCycle(
      optionsWith(async (input) => {
        if (String(input).startsWith("http://coordinator.test/v1/guardian/signing-requests?")) {
          return json({
            total: 3,
            page: 1,
            pageSize: 100,
            items: [VALID_ROW, { ...VALID_ROW, kind: "unknown" }, { ...VALID_ROW, chainId: 2 }],
          });
        }
        return json({ status: "accepted", quorumReached: true, submissionCount: 1 });
      }, logger),
    );

    // A failing poll drives poll_failed plus the ok:false heartbeat.
    await runGuardianCoordinatorCycle(
      optionsWith(async () => {
        throw new TypeError("fetch failed");
      }, logger),
    );

    const guardian = optionsWith(undefined, undefined).guardian;
    lines.push(startupLine(guardian), fatalLine(new Error("COORDINATOR_BASE_URL is required")));

    const patterns = Object.entries(contract.patterns).map(
      ([name, source]) => [name, new RegExp(source)] as const,
    );
    for (const [name, pattern] of patterns) {
      expect(
        lines.some((line) => pattern.test(line)),
        `pattern "${name}" was not emitted by any exercised code path`,
      ).toBe(true);
    }
    for (const line of lines) {
      expect(
        patterns.some(([, pattern]) => pattern.test(line)),
        `emitted line not covered by log-contract.json: ${line}`,
      ).toBe(true);
    }
  });
});
