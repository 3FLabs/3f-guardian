# 3f-guardian

HTTP shell for the **Guardian** off-chain signer service — the v1 contract specified at
[gist b50021fb3ee2c059d228b4dcddbb577e](https://gist.github.com/maxencerb/b50021fb3ee2c059d228b4dcddbb577e).

The Guardian attests privileged on-chain actions: a caller submits the intended action,
the Guardian evaluates a fixed catalogue of policy & on-chain checks, and on success
returns an EIP-712 signature that the caller submits alongside its transaction.

This package is the **HTTP shell only**. Policy implementations, signing keys, RPC
endpoints, token storage and rate-limit accounting are passed in as a typed
`GuardianAbstractions` object — the package never sees a private key, an HMAC
secret, or a chain RPC URL.

## Stack

- [Elysia](https://elysiajs.com/) on [Bun](https://bun.sh/) for routing
- [Zod](https://zod.dev) for schema validation; Elysia's standard-schema bridge feeds the schemas straight into [`@elysiajs/openapi`](https://elysiajs.com/plugins/openapi)
- [viem](https://viem.sh/) for chain reads & EIP-712 signing
- [better-result](https://better-result.dev) for typed `Result<T, E>` flow
- [@noble/hashes](https://github.com/paulmillr/noble-hashes) for HMAC-SHA-256 (§5.4)
- [oxlint](https://oxc.rs/docs/guide/usage/linter/quickstart) + [oxfmt](https://oxc.rs/docs/guide/usage/formatter/quickstart) for lint & format
- [vitest](https://vitest.dev) for tests

## Layout

```
src/
├─ abstractions.ts          types-only contract a host fulfils
├─ server.ts                buildGuardianServer(abs) ⇒ Elysia
├─ index.ts                 public re-exports
├─ errors/
│   ├─ tagged.ts            TaggedError classes (one per §6.5 code)
│   └─ envelope.ts          tagged-error → §6.5 envelope (exhaustive)
├─ schemas/                 zod primitives, headers, per-endpoint bodies & responses
├─ plugins/                 raw-body, request-id, version, content-type, auth, error-handler
├─ routes/                  one file per endpoint
├─ signers/
│   └─ private-key.ts       privateKeyToSignTypedData — viem-backed dev signer
└─ lib/                     hmac, time, request-id, checks, result, signing
tests/                      vitest suites (HMAC, primitives, signer, server smoke)
```

## Wiring abstractions

`GuardianAbstractions` is a typed contract. The host implements every field; the
shell never has access to the private key, HMAC secrets, or RPC URLs.

```ts
import { Result } from "better-result";
import { http, createPublicClient, type Hex } from "viem";
import { mainnet, base } from "viem/chains";

import {
  buildGuardianServer,
  privateKeyToSignTypedData,
  UnauthenticatedError,
  UnsupportedChainError,
  type GuardianAbstractions,
  type TokenInfo,
} from "3f-guardian";

const clients = {
  1: createPublicClient({ chain: mainnet, transport: http(process.env.RPC_MAINNET) }),
  8453: createPublicClient({ chain: base, transport: http(process.env.RPC_BASE) }),
} as const;

const TOKENS = new Map<string, TokenInfo>([
  // [bearerToken, { tokenId, scopes, requiresHmac, hmacSecret? }]
]);

const abs: GuardianAbstractions = {
  metadata: {
    build: process.env.BUILD_ID ?? "0.1.0",
    guardianSigner: "0x…", // address corresponding to GUARDIAN_SIGNER_KEY
    supportedChains: [1, 8453],
  },

  liveness: async () => Result.ok(),

  getChainClient: (chainId) => {
    const client = clients[chainId as keyof typeof clients];
    return client
      ? Result.ok(client)
      : Result.err(
          new UnsupportedChainError({
            message: `chainId ${chainId} not supported`,
            chainId,
          }),
        );
  },

  authenticate: async (token) => {
    const info = TOKENS.get(token);
    return info
      ? Result.ok(info)
      : Result.err(new UnauthenticatedError({ message: "Unknown token" }));
  },

  // Dev signer: viem privateKeyToAccount under the hood. Production
  // hosts substitute a KMS-/HSM-backed implementation of the same
  // SignTypedData type.
  signTypedData: privateKeyToSignTypedData(process.env.GUARDIAN_SIGNER_KEY as Hex),

  signIntentRequestBinding: /* … your A.1 checks + ctx.signTypedData(...) */,
  signIntentFundBinding:    /* … your A.2 checks + ctx.signTypedData(...) */,
  signIntentSwap:           /* … your A.3 checks + ctx.signTypedData(...) */,
  signRequestWhitelisting:  /* … your A.4 checks + ctx.signTypedData(...) */,
};

buildGuardianServer(abs).listen(3000);
```

Per-endpoint `sign*` functions receive a `SigningContext` carrying:

- `chainId`, `client` — viem `PublicClient` for that chain
- `requestId`, `tokenId` — for log correlation
- `now` — wall-clock snapshotted at request entry
- `signTypedData` — the host signer (no private key argument)

They return a `Promise<Result<SuccessShape, SigningError>>`. The error union is
narrow per endpoint (see `abstractions.ts`); `intent-fund-bindings` is the only
endpoint whose union includes `StateConflictError` (the §A.2 fund-state check is
the only 409-class check in v1).

## Endpoints

| Method | Path                                                | Scope                                            | 409? |
|--------|-----------------------------------------------------|--------------------------------------------------|------|
| GET    | `/health`                                           | (unauthenticated)                                | —    |
| GET    | `/version`                                          | (unauthenticated)                                | —    |
| POST   | `/v1/facility/intent-request-bindings`              | `facility:intent-request-bindings`               | no   |
| POST   | `/v1/facility/intent-fund-bindings`                 | `facility:intent-fund-bindings`                  | yes  |
| POST   | `/v1/facility/intent-swaps`                         | `facility:intent-swaps`                          | no   |
| POST   | `/v1/whitelist-book/request-whitelistings`          | `whitelist-book:request-whitelistings`           | no   |

OpenAPI spec is mounted at `/openapi/json`; Scalar UI at `/openapi`.

## Auth flow (§5)

1. `Authorization: Bearer <token>` is required on every protected route.
2. The shell calls `abs.authenticate(token)` to resolve a `TokenInfo`. Unknown / revoked / malformed → `401 unauthenticated`.
3. The route's required scope is checked against `tokenInfo.scopes`. Missing → `403 forbidden`. The response message MUST NOT reveal which scopes the token holds (§5.2).
4. If `tokenInfo.requiresHmac` is true, the shell verifies `X-Guardian-Timestamp` (±60s) and `X-Guardian-Signature` over the byte sequence `<unix_seconds_ascii>.<raw_body_bytes>` using `tokenInfo.hmacSecret` (§5.4). Any failure → `401 unauthenticated` with an informative-only `message`.
5. Optional `abs.accountRateLimit(tokenInfo)` populates the `X-RateLimit-*` headers; an `Err(RateLimitedError)` from it yields `429` with `Retry-After`.

The auth check runs in Elysia's `derive` (pre-validation) phase so `401` / `403` take precedence over body-shape `400`s — matching §6.6 ordering.

## Error envelope (§6.5)

All non-2xx responses share:

```json
{
  "error": "<machine_readable_code>",
  "message": "<human_readable_description>",
  "requestId": "<uuid>",
  "details": { /* optional, code-specific */ },
  "checks": [ /* present for validation_failed, MAY be present for state_conflict */ ]
}
```

Codes: `unauthenticated`, `forbidden`, `bad_request`, `not_found`,
`unsupported_chain`, `state_conflict`, `validation_failed`, `rate_limited`,
`internal_error`, `upstream_unavailable`. Every code maps deterministically from a
`TaggedError` class in `src/errors/tagged.ts`; `resolveError` is exhaustive over
the union and a new tag fails the build until handled.

## Scripts

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint
bun run format      # oxfmt
bun run test        # vitest run
bun run dev         # bun --watch src/index.ts (library entry; you supply your own bootstrap)
```

## Tests

```
tests/lib/hmac.test.ts                 §5.4.2 HMAC byte format & timing-safe compare
tests/schemas/primitives.test.ts       §3 wire format invariants
tests/signers/private-key.test.ts      sign → verifyTypedData round-trip + Err path
tests/server.smoke.test.ts             health, version, 401, 415, X-Request-Id behaviour
```

## License

UNLICENSED — internal 3F Labs project.
