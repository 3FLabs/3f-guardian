import { Result } from "better-result";
import { describe, expect, it } from "vitest";

import {
  buildGuardianServer,
  ENDPOINT_SCOPES,
  UnauthenticatedError,
  type GuardianAbstractions,
  type SigningSuccess,
  type TokenInfo,
} from "../src/index.ts";

/**
 * Build a stub abstraction good enough to exercise the HTTP shell. None
 * of the validate-and-sign functions are reached in these tests; we only
 * check the auth + content-type + 404 paths.
 */
function stubAbstractions(): GuardianAbstractions {
  const tokenInfo: TokenInfo = {
    tokenId: "test-token",
    scopes: new Set(ENDPOINT_SCOPES),
    requiresHmac: false,
  };

  const success: SigningSuccess = {
    guardian: "0x0000000000000000000000000000000000000001",
    signature: ("0x" + "a".repeat(130)) as `0x${string}`,
    payloadHash: ("0x" + "b".repeat(64)) as `0x${string}`,
    signedAt: "2026-04-22T10:15:00Z",
    checks: [],
  };

  return {
    metadata: {
      build: "0.0.0+test",
      guardianSigner: "0x0000000000000000000000000000000000000001",
      supportedChains: [1, 8453],
    },
    liveness: async () => Result.ok(),
    getChainClient: () => {
      // Stub: never actually called in these tests.
      return Result.ok({} as never);
    },
    signTypedData: async () => Result.ok(("0x" + "a".repeat(130)) as `0x${string}`),
    authenticate: async (token) => {
      if (token === "valid") return Result.ok(tokenInfo);
      return Result.err(new UnauthenticatedError({ message: "Unknown token" }));
    },
    signIntentRequestBinding: async () => Result.ok(success),
    signIntentFundBinding: async () => Result.ok(success),
    signIntentSwap: async () => Result.ok(success),
    signRequestWhitelisting: async () =>
      Result.ok({
        ...success,
        address: "0x0000000000000000000000000000000000000001",
        nonce: "7",
      }),
  };
}

describe("Guardian server smoke", () => {
  const app = buildGuardianServer(stubAbstractions());

  it("GET /health returns 200 with {status:'ok'}", async () => {
    const res = await app.handle(new Request("http://localhost/health", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    // §6.3 — X-Guardian-Version present on every response.
    expect(res.headers.get("X-Guardian-Version")).toBe("0.0.0+test");
    // §3.7 — X-Request-Id always present.
    expect(res.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("GET /version returns the configured metadata", async () => {
    const res = await app.handle(new Request("http://localhost/version"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      apiVersion: "v1",
      build: "0.0.0+test",
      guardianSigner: "0x0000000000000000000000000000000000000001",
      supportedChains: [1, 8453],
    });
  });

  it("rejects POST without Authorization with 401", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  it("rejects POST with non-JSON content-type with 415", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          authorization: "Bearer valid",
        },
        body: "not json",
      }),
    );
    expect(res.status).toBe(415);
  });

  it("echoes a caller-supplied X-Request-Id when canonical", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const res = await app.handle(
      new Request("http://localhost/health", {
        headers: { "x-request-id": id },
      }),
    );
    expect(res.headers.get("X-Request-Id")).toBe(id);
  });

  it("replaces a malformed X-Request-Id with a generated one (§3.7)", async () => {
    const res = await app.handle(
      new Request("http://localhost/health", {
        headers: { "x-request-id": "NOT-A-UUID" },
      }),
    );
    const echoed = res.headers.get("X-Request-Id");
    expect(echoed).not.toBe("NOT-A-UUID");
    expect(echoed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
