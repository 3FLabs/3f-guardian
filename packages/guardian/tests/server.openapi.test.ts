import { Result } from "better-result";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildGuardianServer,
  UnauthenticatedError,
  type GuardianAbstractions,
  type SigningSuccess,
} from "../src/index.js";

function stubAbstractions(): GuardianAbstractions {
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
    getChainClient: () => Result.ok({} as never),
    signTypedData: async () => Result.ok(("0x" + "a".repeat(130)) as `0x${string}`),
    authenticate: async () => Result.err(new UnauthenticatedError({ message: "Unknown token" })),
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

type OpenApiOperation = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  responses: Record<
    string,
    { description?: string; content?: Record<string, { schema?: Record<string, unknown> }> }
  >;
};

const SIGNING_PATHS = [
  "/v1/facility/intent-request-bindings",
  "/v1/facility/intent-fund-bindings",
  "/v1/facility/intent-swaps",
  "/v1/whitelist-book/request-whitelistings",
] as const;

describe("OpenAPI document", () => {
  let doc: { paths: Record<string, { post?: OpenApiOperation }> };

  beforeAll(async () => {
    const app = buildGuardianServer(stubAbstractions());
    const res = await app.handle(new Request("http://localhost/openapi/json"));
    expect(res.status).toBe(200);
    doc = (await res.json()) as typeof doc;
  });

  it("documents the §6.2 client headers as required parameters on every signing route", () => {
    for (const path of SIGNING_PATHS) {
      const op = doc.paths[path]?.post;
      expect(op, path).toBeDefined();
      const byName = new Map(op!.parameters?.map((p) => [p.name, p]));
      expect(byName.get("x-client-name")?.required, path).toBe(true);
      expect(byName.get("x-client-version")?.required, path).toBe(true);
      expect(byName.get("x-request-id")?.required, path).toBe(false);
      expect(byName.get("x-guardian-timestamp")?.required, path).toBe(false);
      expect(byName.get("x-guardian-signature")?.required, path).toBe(false);
    }
  });

  it("documents 413 and 415 on every signing route", () => {
    for (const path of SIGNING_PATHS) {
      const responses = doc.paths[path]!.post!.responses;
      expect(responses["413"], path).toBeDefined();
      expect(responses["415"], path).toBeDefined();
      expect(responses["413"]!.description).toContain("bad_request");
      expect(responses["415"]!.description).toContain("bad_request");
    }
  });

  it("renders response hex fields with the lower-case wire pattern", () => {
    const schema = doc.paths["/v1/facility/intent-request-bindings"]!.post!.responses["200"]!
      .content!["application/json"]!.schema as {
      properties: Record<string, { pattern?: string }>;
    };
    expect(schema.properties.guardian?.pattern).toBe("^0x[0-9a-f]{40}$");
    expect(schema.properties.signature?.pattern).toBe("^0x[0-9a-f]{130}$");
    expect(schema.properties.payloadHash?.pattern).toBe("^0x[0-9a-f]{64}$");
  });

  it("keeps documenting request bodies (mixed-case input pattern) on the request side", () => {
    // Guard against regressions in the io:"input" mapping: request-side
    // primitives still accept any case on the wire.
    const op = doc.paths["/v1/facility/intent-request-bindings"]!.post! as OpenApiOperation & {
      requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> };
    };
    const body = op.requestBody?.content?.["application/json"]?.schema as {
      properties: Record<string, { pattern?: string }>;
    };
    expect(body.properties.facility?.pattern).toBe("^0x[0-9a-fA-F]{40}$");
  });
});
