import { Result } from "better-result";
import { Elysia } from "elysia";
import { describe, expect, it } from "vitest";

import {
  buildGuardianServer,
  ENDPOINT_SCOPES,
  RateLimitedError,
  UnauthenticatedError,
  UpstreamUnavailableError,
  type GuardianAbstractions,
  type SigningSuccess,
  type TokenInfo,
} from "../src/index.js";
import { computeBodyHmacHex } from "../src/lib/hmac.js";

/**
 * Build a stub abstraction good enough to exercise the HTTP shell. None
 * of the validate-and-sign functions perform real work; these tests
 * cover the auth + content-type + parse + 404 + timeout paths.
 */
function stubAbstractions(overrides: Partial<GuardianAbstractions> = {}): GuardianAbstractions {
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
    ...overrides,
  };
}

/** §6.2 client-identification headers, required on protected routes. */
const CLIENT_HEADERS = {
  "x-client-name": "smoke-tests",
  "x-client-version": "1.0.0",
} as const;

/** Structurally valid §7.3 body for the intent-request-bindings route. */
const VALID_BINDING_BODY = {
  chainId: 1,
  facility: "0x2222222222222222222222222222222222222222",
  intent: { id: "1" },
  requestContract: "0x3333333333333333333333333333333333333333",
  deadline: 1_800_000_000,
};

function postBinding(args: { headers?: Record<string, string>; body?: string } = {}): Request {
  return new Request("http://localhost/v1/facility/intent-request-bindings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer valid",
      ...CLIENT_HEADERS,
      ...args.headers,
    },
    body: args.body ?? JSON.stringify(VALID_BINDING_BODY),
  });
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

  it("POST to a signing route with valid auth, headers and body returns 200", async () => {
    const res = await app.handle(postBinding());
    expect(res.status).toBe(200);
    const body = (await res.json()) as SigningSuccess;
    expect(body.guardian).toBe("0x0000000000000000000000000000000000000001");
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

  it("accepts a mixed-case JSON content type (media types are case-insensitive)", async () => {
    const res = await app.handle(
      postBinding({ headers: { "content-type": "APPLICATION/JSON; charset=utf-8" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SigningSuccess;
    expect(body.signature).toBe("0x" + "a".repeat(130));
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

describe("404 mapping", () => {
  const app = buildGuardianServer(stubAbstractions());

  it("returns 404 not_found for an unknown route", async () => {
    const res = await app.handle(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("Unknown route");
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f]{8}-/);
  });

  it("returns 404 not_found for a method mismatch on a known route", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", { method: "GET" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("parse failures", () => {
  const app = buildGuardianServer(stubAbstractions());

  it("returns 400 bad_request for malformed JSON", async () => {
    const res = await app.handle(postBinding({ body: "{oops" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("Malformed JSON");
  });
});

describe("500 envelope hygiene", () => {
  it("never leaks an unknown thrown error's message to the client", async () => {
    const secret = "pg://user:SuperSecretPw@db.internal:5432 connect ECONNREFUSED";
    const app = buildGuardianServer(
      stubAbstractions({
        authenticate: async () => {
          throw new Error(secret);
        },
      }),
    );
    const res = await app.handle(postBinding());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SuperSecretPw");
    expect(text).not.toContain("db.internal");
    const body = JSON.parse(text) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Unexpected Guardian-side failure");
  });
});

describe("probeUpstream wiring", () => {
  it("short-circuits signing requests with the probe's 502/503 and Retry-After", async () => {
    let probed = 0;
    const app = buildGuardianServer(
      stubAbstractions({
        probeUpstream: () => {
          probed++;
          return Result.err(
            new UpstreamUnavailableError({
              message: "upstream down",
              status: 503,
              retryAfterSeconds: 30,
            }),
          );
        },
      }),
    );
    const res = await app.handle(postBinding());
    expect(res.status).toBe(503);
    expect(probed).toBe(1);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream_unavailable");
  });
});

describe("abstraction deadlines", () => {
  it("bounds a hung authenticate() with 503 and aborts the forwarded signal", async () => {
    let seen: AbortSignal | undefined;
    const app = buildGuardianServer(
      stubAbstractions({
        authenticate: (_token, options) => {
          seen = options?.signal;
          return new Promise(() => {});
        },
        timeouts: { authenticateMs: 50 },
      }),
    );
    const res = await app.handle(postBinding());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("upstream_unavailable");
    expect(body.message).toContain("authenticate");
    expect(seen?.aborted).toBe(true);
  });

  it("bounds a hung liveness() so /health fails fast with 503", async () => {
    const app = buildGuardianServer(
      stubAbstractions({
        liveness: () => new Promise(() => {}),
        timeouts: { livenessMs: 50 },
      }),
    );
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream_unavailable");
  });

  it("bounds a hung sign* call with 503 and aborts ctx.signal", async () => {
    let seen: AbortSignal | undefined;
    const app = buildGuardianServer(
      stubAbstractions({
        signIntentRequestBinding: (ctx) => {
          seen = ctx.signal;
          return new Promise(() => {});
        },
        timeouts: { signMs: 50 },
      }),
    );
    const res = await app.handle(postBinding());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream_unavailable");
    expect(seen?.aborted).toBe(true);
  });

  it("bounds a hung accountRateLimit() with 503 and aborts the forwarded signal", async () => {
    let seen: AbortSignal | undefined;
    const app = buildGuardianServer(
      stubAbstractions({
        accountRateLimit: (_info, options) => {
          seen = options?.signal;
          return new Promise(() => {});
        },
        timeouts: { rateLimitMs: 50 },
      }),
    );
    // The stub's default authenticate accepts "Bearer valid", so the
    // request reaches the rate-limit branch.
    const res = await app.handle(postBinding());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("upstream_unavailable");
    expect(body.message).toContain("accountRateLimit");
    expect(seen?.aborted).toBe(true);
  });

  it("a fast Err(RateLimitedError) still maps to 429 + Retry-After under the deadline wrapper", async () => {
    const app = buildGuardianServer(
      stubAbstractions({
        accountRateLimit: async () =>
          Result.err(new RateLimitedError({ message: "slow down", retryAfterSeconds: 7 })),
      }),
    );
    const res = await app.handle(postBinding());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });
});

describe("construction-time validation", () => {
  it.each([Number.NaN, 0, -1, 1.5])(
    "rejects maxBodyBytes = %s loudly at construction",
    (maxBodyBytes) => {
      expect(() => buildGuardianServer(stubAbstractions({ maxBodyBytes }))).toThrow(
        /maxBodyBytes must be a positive integer/,
      );
    },
  );

  it("rejects NaN / non-positive timeout overrides loudly at construction", () => {
    expect(() =>
      buildGuardianServer(stubAbstractions({ timeouts: { authenticateMs: Number.NaN } })),
    ).toThrow(/timeouts\.authenticateMs must be a positive finite number/);
    expect(() => buildGuardianServer(stubAbstractions({ timeouts: { signMs: 0 } }))).toThrow(
      /timeouts\.signMs must be a positive finite number/,
    );
  });
});

describe("body size cap", () => {
  it("rejects bodies past maxBodyBytes with 413 before authentication", async () => {
    let authCalls = 0;
    const app = buildGuardianServer(
      stubAbstractions({
        authenticate: async () => {
          authCalls++;
          return Result.err(new UnauthenticatedError({ message: "nope" }));
        },
        maxBodyBytes: 256,
      }),
    );
    const res = await app.handle(postBinding({ body: JSON.stringify({ pad: "x".repeat(300) }) }));
    expect(res.status).toBe(413);
    expect(authCalls).toBe(0);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("accepts bodies under the cap", async () => {
    const app = buildGuardianServer(stubAbstractions({ maxBodyBytes: 4096 }));
    const res = await app.handle(postBinding());
    expect(res.status).toBe(200);
  });

  it("rejects an oversized declared Content-Length before buffering or authentication", async () => {
    let authCalls = 0;
    const app = buildGuardianServer(
      stubAbstractions({
        authenticate: async () => {
          authCalls++;
          return Result.err(new UnauthenticatedError({ message: "nope" }));
        },
        maxBodyBytes: 256,
      }),
    );
    // The actual body is well under the 256-byte cap, so a 413 can only
    // come from the declared-length fast path.
    const res = await app.handle(postBinding({ headers: { "content-length": "9999" } }));
    expect(res.status).toBe(413);
    expect(authCalls).toBe(0);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("bad_request");
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(res.headers.get("X-Request-Id")).toBe(body.requestId);
  });

  it("does not apply the cap to host routes whose content types guardian never buffers", async () => {
    // Guardian's body cap must only gate the content types it buffers
    // (application/json, text/*) — a host urlencoded route declaring an
    // oversized Content-Length must reach the host's own parser chain,
    // not 413, even when composed at the parent-app level (request-phase
    // gates are never re-scoped by Elysia, so a cap there would fire on
    // every route of the composed app).
    const host = new Elysia()
      .use(buildGuardianServer(stubAbstractions({ maxBodyBytes: 256 })))
      .patch("/host-upload", ({ body }) => body as Record<string, string>, {
        parse: "urlencoded",
      });
    const res = await host.handle(
      new Request("http://localhost/host-upload", {
        method: "PATCH",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "9999",
        },
        body: "a=1&b=2",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: "1", b: "2" });
  });

  it("applies the cap to a parent app's own JSON routes (the parse hook is global)", async () => {
    // The body parser + cap ride an onParse hook registered
    // { as: "global" }, which `.as("scoped")` never demotes — so JSON
    // routes the HOST adds next to the guardian instance are capped
    // too, not just routes added to the returned instance.
    const host = new Elysia()
      .use(buildGuardianServer(stubAbstractions({ maxBodyBytes: 256 })))
      .post("/parent-json", ({ body }) => body);
    const res = await host.handle(
      new Request("http://localhost/parent-json", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "9999" },
        body: JSON.stringify({ small: true }),
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });
});

describe("§6.2 client-identification headers", () => {
  const app = buildGuardianServer(stubAbstractions());

  it("rejects an authenticated request missing X-Client-Name with 400", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid",
          "x-client-version": "1.0.0",
        },
        body: JSON.stringify(VALID_BINDING_BODY),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("rejects an authenticated request missing X-Client-Version with 400", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid",
          "x-guardian-signature": "deadbeef-live-signature",
          "x-client-name": "smoke-tests",
        },
        body: JSON.stringify(VALID_BINDING_BODY),
      }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect((JSON.parse(text) as { error: string }).error).toBe("bad_request");
    // Credential-echo regression: Elysia's ValidationError embeds the
    // whole header object (`found`) in its message — auth runs before
    // validation, so the echoed credentials are always LIVE ones. The
    // sanitized envelope must never contain them.
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("deadbeef-live-signature");
    expect(text).not.toContain("authorization");
    // ...while still telling the caller which header failed.
    expect(text).toContain("x-client-version");
  });

  it("rejects an authenticated request with a malformed X-Client-Version with 400", async () => {
    const res = await app.handle(postBinding({ headers: { "x-client-version": "banana" } }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect((JSON.parse(text) as { error: string }).error).toBe("bad_request");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("authorization");
  });

  it("maps a Guardian-side response-schema violation to 500, not 400", async () => {
    // The abstraction returns a payload violating zSigningSuccess. That
    // is a SERVER bug: blaming the caller with a 400 would have a
    // well-behaved client retry a request that can never succeed.
    const broken = buildGuardianServer(
      stubAbstractions({
        signIntentRequestBinding: async () =>
          Result.ok({
            guardian: "0x0000000000000000000000000000000000000001",
            signature: "not-a-hex-signature",
            payloadHash: ("0x" + "b".repeat(64)) as `0x${string}`,
            signedAt: "2026-04-22T10:15:00Z",
            checks: [],
          } as never),
      }),
    );
    const res = await broken.handle(postBinding());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    // The malformed internal payload must not be echoed to the caller.
    expect(body.message).not.toContain("not-a-hex-signature");
  });

  it("auth failures still preempt missing client headers (401 before 400)", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify(VALID_BINDING_BODY),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("does not reject a malformed X-Request-Id on protected routes (§3.7)", async () => {
    const res = await app.handle(postBinding({ headers: { "x-request-id": "NOT-A-UUID" } }));
    expect(res.status).toBe(200);
    const echoed = res.headers.get("X-Request-Id");
    expect(echoed).not.toBe("NOT-A-UUID");
    expect(echoed).toMatch(/^[0-9a-f]{8}-/);
  });
});

describe("response normalisation", () => {
  it("lower-cases mixed-case hex fields returned by a host abstraction", async () => {
    const app = buildGuardianServer(
      stubAbstractions({
        signIntentRequestBinding: async () =>
          Result.ok({
            guardian: "0x00000000000000000000000000000000000000AB" as `0x${string}`,
            signature: ("0x" + "A".repeat(130)) as `0x${string}`,
            payloadHash: ("0x" + "B".repeat(64)) as `0x${string}`,
            signedAt: "2026-04-22T10:15:00Z",
            checks: [],
          }),
      }),
    );
    const res = await app.handle(postBinding());
    expect(res.status).toBe(200);
    const body = (await res.json()) as SigningSuccess;
    expect(body.guardian).toBe("0x00000000000000000000000000000000000000ab");
    expect(body.signature).toBe("0x" + "a".repeat(130));
    expect(body.payloadHash).toBe("0x" + "b".repeat(64));
  });
});

describe("host composition", () => {
  it("leaves non-JSON, non-text bodies for the host's own parser chain", async () => {
    const app = buildGuardianServer(stubAbstractions()).patch(
      "/host-echo",
      ({ body }) => body as Record<string, string>,
      { parse: "urlencoded" },
    );
    const res = await app.handle(
      new Request("http://localhost/host-echo", {
        method: "PATCH",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1&b=2",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: "1", b: "2" });
  });
});

describe("HMAC-flagged tokens end-to-end (§5.4)", () => {
  const SECRET = "test-hmac-secret";
  const hmacToken: TokenInfo = {
    tokenId: "hmac-token",
    scopes: new Set(ENDPOINT_SCOPES),
    requiresHmac: true,
    hmacSecret: SECRET,
  };
  const app = buildGuardianServer(
    stubAbstractions({
      authenticate: async (token) =>
        token === "hmac-valid"
          ? Result.ok(hmacToken)
          : Result.err(new UnauthenticatedError({ message: "Unknown token" })),
    }),
  );
  const BODY = JSON.stringify(VALID_BINDING_BODY);

  function signedHeaders(body: string): Record<string, string> {
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      "content-type": "application/json",
      authorization: "Bearer hmac-valid",
      ...CLIENT_HEADERS,
      "x-guardian-timestamp": ts,
      "x-guardian-signature": computeBodyHmacHex(SECRET, ts, new TextEncoder().encode(body)),
    };
  }

  /** Deliver `json` in small chunks so the raw-body reader takes the streamed path. */
  function chunked(json: string, size = 5): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(json);
    let off = 0;
    return new ReadableStream({
      pull(controller) {
        if (off >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(off, off + size));
        off += size;
      },
    });
  }

  it("accepts a correctly signed buffered body", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers: signedHeaders(BODY),
        body: BODY,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts a correctly signed CHUNKED body — HMAC over the streamed byte path", async () => {
    // The §5.4 HMAC covers the EXACT wire bytes, which for a chunked
    // request are assembled by the raw-body reader's streaming branch.
    // This pins that the assembled bytes equal what the client signed.
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers: signedHeaders(BODY),
        body: chunked(BODY),
        // Required by the fetch spec for stream bodies.
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a body that does not match the signature with 401", async () => {
    const tampered = JSON.stringify({ ...VALID_BINDING_BODY, deadline: 1_800_000_001 });
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers: signedHeaders(BODY), // signed over BODY, sending tampered
        body: tampered,
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a missing signature on an HMAC-flagged token with 401", async () => {
    const headers = signedHeaders(BODY);
    delete headers["x-guardian-signature"];
    const res = await app.handle(
      new Request("http://localhost/v1/facility/intent-request-bindings", {
        method: "POST",
        headers,
        body: BODY,
      }),
    );
    expect(res.status).toBe(401);
  });
});
