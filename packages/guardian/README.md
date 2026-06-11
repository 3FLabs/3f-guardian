# @3flabs/guardian

HTTP shell for the **Guardian** off-chain signer service — the v1 contract specified at
[gist b50021fb3ee2c059d228b4dcddbb577e](https://gist.github.com/maxencerb/b50021fb3ee2c059d228b4dcddbb577e).

The package never sees a private key, an HMAC secret, or a chain RPC URL. Hosts implement
a typed `GuardianAbstractions` and pass it to `buildGuardianServer(abs)`. Default building
blocks (logger, rate limiter, cache, Appendix-A check builders, on-chain ABIs) live in the
companion [`@3flabs/guardian-defaults`](https://npmjs.com/package/@3flabs/guardian-defaults).

## Contents

- [Install](#install)
- [Quickstart — running a signer on a private key](#quickstart--running-a-signer-on-a-private-key)
- [`GuardianAbstractions` at a glance](#guardianabstractions-at-a-glance)
- [Timeouts, body cap & upstream probe](#timeouts-body-cap--upstream-probe)
- [EIP-712 typed-data builders](#eip-712-typed-data-builders)
- [`SigningContext`](#signingcontext)
- [Endpoints](#endpoints)
  - [Required request headers (§6.2)](#required-request-headers-62)
- [Error envelope (§6.5)](#error-envelope-65)
- [Running integration tests](#running-integration-tests)

## Install

```bash
bun add @3flabs/guardian @3flabs/guardian-defaults viem better-result
# or
npm install @3flabs/guardian @3flabs/guardian-defaults viem better-result
```

Peer runtime: any ESM-compatible Node ≥ 22 / Bun ≥ 1.1.

## Quickstart — running a signer on a private key

The shortest fully-functional Guardian. Wires a dev private-key signer, an in-memory
bearer-token directory, viem RPC clients per chain, the four §A check runners from
`@3flabs/guardian-defaults`, and the `makeSign*` orchestrators from this package.

```ts
// src/server.ts
import { Result } from "better-result";
import { http, createPublicClient, type Hex, type PublicClient } from "viem";
import { mainnet, base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import {
  buildGuardianServer,
  ENDPOINT_SCOPES,
  makeSignIntentFundBinding,
  makeSignIntentRequestBinding,
  makeSignIntentSwap,
  makeSignRequestWhitelisting,
  privateKeyToSignTypedData,
  UnauthenticatedError,
  UnsupportedChainError,
  type GuardianAbstractions,
  type TokenInfo,
} from "@3flabs/guardian";
import { pinoLogger } from "@3flabs/guardian-defaults/logger";
import { inMemoryRateLimiter } from "@3flabs/guardian-defaults/rate-limit";
import { inMemoryCache } from "@3flabs/guardian-defaults/cache";
import {
  buildIntentFundBindingChecks,
  buildIntentRequestBindingChecks,
  buildIntentSwapChecks,
  buildRequestWhitelistingChecks,
  zA1OnChainData,
  type IntentFundBindingPolicy,
  type IntentRequestBindingPolicy,
  type IntentSwapPolicy,
  type RequestWhitelistingPolicy,
} from "@3flabs/guardian-defaults/checks";

// 1. Signer (dev only — production uses KMS/HSM-backed `SignTypedData`).
const PRIVATE_KEY = process.env.GUARDIAN_SIGNER_KEY as Hex | undefined;
if (!PRIVATE_KEY) throw new Error("Missing GUARDIAN_SIGNER_KEY");
const guardianSigner = privateKeyToAccount(PRIVATE_KEY).address;
const signTypedData = privateKeyToSignTypedData(PRIVATE_KEY);

// 2. Per-chain viem clients. Cast each to the generic `PublicClient`
//    so chain-narrowed types (e.g. base's deposit-tx formatter) widen
//    to the shape `getChainClient` expects.
const clients: Record<number, PublicClient> = {
  1: createPublicClient({
    chain: mainnet,
    transport: http(process.env.RPC_MAINNET),
  }) as PublicClient,
  8453: createPublicClient({
    chain: base,
    transport: http(process.env.RPC_BASE),
  }) as PublicClient,
};
const supportedChains = Object.keys(clients).map(Number);

// 3. Bearer-token directory.
const TOKENS = new Map<string, TokenInfo>([
  [
    process.env.DEV_BEARER_TOKEN ?? "dev-token",
    { tokenId: "dev", scopes: new Set(ENDPOINT_SCOPES), requiresHmac: false },
  ],
]);

// 4. Caches: ERC-5267 domain (long TTL) + §A.1/§A.4 on-chain reads (short TTL).
//    Each cache takes a schema (any Standard Schema — zod here) that
//    re-validates every hit on read; a value that fails to parse is a miss.
const eip712DomainCache = inMemoryCache(z.object({ name: z.string(), version: z.string() }), {
  defaultTtlMs: 24 * 60 * 60_000,
  maxEntries: 256,
});
const a1OnChainCache = inMemoryCache(zA1OnChainData, {
  defaultTtlMs: 5 * 60_000,
  maxEntries: 1024,
});

// 5. Policies. Empty Sets cause the runner to fail every check —
//    populate with the factory / owner / puller / consumer / fund /
//    position-manager addresses your deployment trusts. See the
//    `@3flabs/guardian-defaults` README for full type docs.
const requestBindingPolicy: IntentRequestBindingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedRequestFactories: new Map([[1, new Set<string>(/* "0xRequestFactory" */)]]),
  acceptedOwners: new Map([[1, new Set<string>(/* "0xOwner" */)]]),
  acceptedPullers: new Map([[1, new Set<string>(/* "0xPuller" */)]]),
  acceptedConsumers: new Map([[1, new Set<string>(/* "0xConsumer" */)]]),
  eventScanBlockRange: 10_000n,
  eventScanMaxLookbackBlocks: 1_000_000n,
};
const fundBindingPolicy: IntentFundBindingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedFunds: new Map([[1, new Set<string>(/* "0xFund" */)]]),
  acceptedOwners: new Map([[1, new Set<string>(/* "0xOwner" */)]]),
};
const swapPolicy: IntentSwapPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedPmFactories: new Map([[1, new Set<string>(/* "0xPmFactory" */)]]),
  acceptedPmOwners: new Map([[1, new Set<string>(/* "0xPmOwner" */)]]),
  swapPriceToleranceBps: 1,
};
const whitelistingPolicy: RequestWhitelistingPolicy = {
  ...requestBindingPolicy,
  maxNonceAboveFloor: 100n,
};

// 6. Wire the abstractions and listen.
const abs: GuardianAbstractions = {
  metadata: {
    build: process.env.BUILD_ID ?? "0.1.0",
    guardianSigner,
    supportedChains,
  },
  logger: pinoLogger({ level: "info", bindings: { service: "guardian" } }),
  liveness: async () => Result.ok(),
  getChainClient: (chainId) => {
    const client = clients[chainId];
    return client
      ? Result.ok(client)
      : Result.err(new UnsupportedChainError({ message: "unsupported", chainId }));
  },
  authenticate: async (token) => {
    const info = TOKENS.get(token);
    return info
      ? Result.ok(info)
      : Result.err(new UnauthenticatedError({ message: "Unknown token" }));
  },
  signTypedData,
  accountRateLimit: inMemoryRateLimiter({ limit: 60, windowSeconds: 60 }),

  // Each `makeSign*` factory wires a defaults-package check runner into a
  // ready-to-use validate-and-sign abstraction: the runner evaluates §A
  // on-chain checks, this package fetches the EIP-712 domain
  // (`eip712Domain()` per ERC-5267) and signs the matching typed-data.
  signIntentRequestBinding: makeSignIntentRequestBinding({
    checks: buildIntentRequestBindingChecks({
      policy: requestBindingPolicy,
      cache: a1OnChainCache,
    }),
    guardianSigner,
    cache: eip712DomainCache,
  }),
  signIntentFundBinding: makeSignIntentFundBinding({
    checks: buildIntentFundBindingChecks({ policy: fundBindingPolicy }),
    guardianSigner,
    cache: eip712DomainCache,
  }),
  signIntentSwap: makeSignIntentSwap({
    checks: buildIntentSwapChecks({ policy: swapPolicy }),
    guardianSigner,
    cache: eip712DomainCache,
  }),
  signRequestWhitelisting: makeSignRequestWhitelisting({
    checks: buildRequestWhitelistingChecks({
      policy: whitelistingPolicy,
      guardianSigner,
      cache: a1OnChainCache,
    }),
    guardianSigner,
    cache: eip712DomainCache,
  }),
};

buildGuardianServer(abs).listen(3000);
```

`buildGuardianServer` returns a vanilla [Elysia](https://elysiajs.com/) instance, so callers
retain full access to `.listen()`, `.handle()` (for tests), and `.use()` for further
composition. Composition caveats — parts of guardian's request pipeline reach beyond the
routes it defines:

- the §6.1 JSON-only content-type guard on POST / PUT (415 otherwise), guardian's body
  parser for `application/json` and `text/*` bodies, and its `maxBodyBytes` cap (413 past
  the cap) apply to **every route of the entire composed application** — any app, at any
  depth, that `.use()`s the guardian instance — not just routes added to the returned
  instance. Other content types (multipart, urlencoded, …) are left untouched for Elysia's
  own parser chain everywhere, and the cap is enforced only on the content types guardian
  buffers;
- the `requestId` / `logger` / `rawBody` context keys shadow any same-named keys the host
  derives.

For the per-subsystem deep dive (logger options, rate-limiter store interface, cache TTL
semantics, full policy type tables), see the
[`@3flabs/guardian-defaults` README](https://npmjs.com/package/@3flabs/guardian-defaults).

## `GuardianAbstractions` at a glance

Required:

- `metadata: GuardianMetadata` — static `{ build, guardianSigner, supportedChains }` exposed at GET `/version`.
- `liveness: () => Promise<Result<void, GuardianError>>` — readiness probe (§7.1).
- `getChainClient(chainId): Result<PublicClient, UnsupportedChainError>` — viem client per chain.
- `authenticate(token): Promise<Result<TokenInfo, UnauthenticatedError>>` — bearer → token info.
- `signTypedData: SignTypedData` — host-owned EIP-712 signer (use `privateKeyToSignTypedData(hex)` for dev, KMS/HSM in prod).
- `signIntentRequestBinding`, `signIntentFundBinding`, `signIntentSwap`, `signRequestWhitelisting` — the four §7.3-7.6 validate-and-sign abstractions.

Optional:

- `logger?: Logger` — pino-compatible. Falls back to `noopLogger`. Use `pinoLogger()` from `@3flabs/guardian-defaults`.
- `accountRateLimit?(tokenInfo, options?): Promise<Result<RateLimitWindow, GuardianError>>` — populates §6.3 `X-RateLimit-*` headers; `Err(RateLimitedError)` yields 429 with `Retry-After`. Use `inMemoryRateLimiter()` from `@3flabs/guardian-defaults`.
- `probeUpstream?(): Result<void, UpstreamUnavailableError>` — consulted at the top of every signing request; `Err` short-circuits with the probe's own 502/503 `upstream_unavailable` before any chain access.
- `timeouts?: GuardianTimeouts` — per-call deadlines for the async abstractions. See [Timeouts, body cap & upstream probe](#timeouts-body-cap--upstream-probe).
- `maxBodyBytes?: number` — cap (bytes) on buffered request bodies. Default 1 MiB (`DEFAULT_MAX_BODY_BYTES`).

`TokenInfo`:

```ts
type TokenInfo = {
  readonly tokenId: string;
  readonly scopes: ReadonlySet<EndpointScope>;   // see ENDPOINT_SCOPES
  readonly requiresHmac: boolean;
  readonly hmacSecret?: string;                   // required when requiresHmac is true
};
```

## Timeouts, body cap & upstream probe

Every host abstraction call is bounded by a per-call deadline. `GuardianAbstractions.timeouts`
overrides the defaults (exported as `DEFAULT_GUARDIAN_TIMEOUTS`):

| Field | Bounds | Default |
|---|---|---|
| `authenticateMs` | `authenticate(token)` | 2 000 ms |
| `rateLimitMs` | `accountRateLimit(tokenInfo)` | 1 000 ms |
| `livenessMs` | `liveness()` (GET `/health`) | 5 000 ms |
| `signMs` | a whole `sign*` validate-and-sign call | 6 000 ms |

On expiry the shell responds `503 upstream_unavailable` and logs the abstraction name at
error level. The deadlines apply sequentially on one signing request
(`authenticate` → `accountRateLimit` → `sign*`), so the worst-case sum
`authenticateMs + rateLimitMs + signMs` (9 s with the defaults) must stay below the HTTP
server's idle timeout (`Bun.serve` defaults to 10 s), otherwise the socket is reset before
the 503 envelope can be written. Hosts raising any deadline past that budget must also pass
a larger `idleTimeout` to `.listen()` (`Bun.serve` accepts up to 255 s). Overrides are
validated at construction: any non-finite or ≤ 0 value throws a `TypeError`, so
misconfiguration fails loudly at startup instead of turning every call into an instant 503.

`authenticate`, `accountRateLimit` and `liveness` receive an optional `{ signal: AbortSignal }`
argument (type `AbstractionCallOptions`), and `SigningContext` carries an optional `signal` —
each aborts when the corresponding deadline expires. Implementations SHOULD forward the
signal to their I/O so a timed-out call stops consuming resources; ignoring it is safe (the
shell races the call against the deadline regardless).

`maxBodyBytes` (default 1 MiB, exported as `DEFAULT_MAX_BODY_BYTES`) caps the request body
the shell buffers for §5.4 HMAC verification and JSON parsing. Bodies past the cap are
rejected with 413 (`bad_request` envelope code, thrown as the exported `PayloadTooLargeError`)
before authentication. Hosts deploying via `Bun.serve` SHOULD also set `maxRequestBodySize`
as a transport-level backstop.

`probeUpstream`, when supplied, is consulted at the top of every signing request and
short-circuits with the probe's own 502/503 `upstream_unavailable` before any chain access —
useful when the host has already detected that its upstream is down.

## EIP-712 typed-data builders

Each of the four signing surfaces ships:

- `build*TypedData(...)` — pure builder returning `{ typedData, payloadHash }`. Useful for tests and bespoke signers.
- `makeSign*(...)` — orchestrator that composes a host-supplied check runner, the typed-data builder, ERC-5267 `eip712Domain()` resolution, `ctx.signTypedData`, and the §6.4 SigningSuccess assembly.

| Endpoint | Builder | Orchestrator | Verifying contract |
|---|---|---|---|
| `intent-request-bindings` (§A.1) | `buildIntentRequestBindingTypedData` | `makeSignIntentRequestBinding` | `body.facility` |
| `intent-fund-bindings` (§A.2)    | `buildIntentFundBindingTypedData`    | `makeSignIntentFundBinding`    | `body.facility` |
| `intent-swaps` (§A.3)            | `buildIntentSwapTypedData`           | `makeSignIntentSwap`           | `body.facility` |
| `request-whitelistings` (§A.4)   | `buildWhitelistRequestTypedData` / `buildUnwhitelistRequestTypedData` | `makeSignRequestWhitelisting` | `body.whitelistBook` |

Typehashes mirror the on-chain verifiers (grunt's `Facility*` and the `RequestWhitelist` repo); `domainName` and `version` are read from `eip712Domain()` per ERC-5267. The `tests/typed-data/typehashes.test.ts` suite cross-checks each typehash against the literal pinned in the contract.

Every builder throws if `domain.verifyingContract` does not equal (case-insensitively) the
body's verifying contract — `body.facility` for the three intent builders,
`body.whitelistBook` for the whitelist / unwhitelist builders.

For `intent-swaps`, `canonicaliseSwapLegs` sorts legs by ascending intent id (asset address as tie-break) so `[A, B]` and `[B, A]` produce byte-identical `signature` and `payloadHash` (§7.5).

The orchestrators accept an optional `Eip712DomainCache` (structurally compatible with `AsyncCache<{ name; version }>` from `@3flabs/guardian-defaults/cache`) so the per-contract `eip712Domain()` read is amortised across signing calls. `fetchEip712DomainNameVersion` is exported separately for callers that compose their own runners.

A caller-supplied verifying contract (`facility` / `whitelistBook`) with no code, no
ERC-5267 support, or a reverting `eip712Domain()` yields `404 not_found`;
`503 upstream_unavailable` is reserved for transport-level RPC failures, and neither error
message embeds raw viem error text.

## `SigningContext`

Passed to every `sign*` abstraction:

- `chainId`, `client` — viem `PublicClient` for that chain
- `requestId`, `tokenId` — for log correlation
- `now` — wall-clock snapshotted at request entry (deadline checks rely on this)
- `signTypedData` — host EIP-712 signer
- `logger` — child-bound to `{ requestId, tokenId, chainId }`
- `signal` — optional; aborts when the `signMs` deadline expires (forward it to on-chain
  reads / KMS calls so a timed-out request stops consuming resources)

## Endpoints

| Method | Path | Scope | 409? |
|--------|------|-------|------|
| GET    | `/health`                                  | (unauthenticated) | — |
| GET    | `/version`                                 | (unauthenticated) | — |
| POST   | `/v1/facility/intent-request-bindings`     | `facility:intent-request-bindings`     | no  |
| POST   | `/v1/facility/intent-fund-bindings`        | `facility:intent-fund-bindings`        | yes |
| POST   | `/v1/facility/intent-swaps`                | `facility:intent-swaps`                | no  |
| POST   | `/v1/whitelist-book/request-whitelistings` | `whitelist-book:request-whitelistings` | no  |

OpenAPI spec at `/openapi/json`; Scalar UI at `/openapi`. The document declares the 413 and
415 responses on every POST route, and response hex fields (`guardian`, `signature`,
`payloadHash`, `address`) carry the lower-case wire patterns actually emitted (e.g.
`^0x[0-9a-f]{40}$`); request bodies keep accepting any case.

Request-shape notes:

- Unknown routes and method mismatches return `404 {"error":"not_found","message":"Unknown route"}`.
- JSON content types are matched case-insensitively per RFC 7231
  (`Application/Json; charset=utf-8` is accepted); non-JSON content types on POST yield 415.
- A malformed JSON body returns `400 bad_request` (message `"Malformed JSON: …"`).
  Parse-phase rejections (400 / 413) are emitted before authentication; validation-phase
  body 400s still come after 401 / 403.
- Decimal uint256 string fields (`intent.id`, swap-leg `amount`, whitelisting `nonce`)
  reject strings longer than 78 digits and any non-numeric input as a clean field-level 400.

### Required request headers (§6.2)

`X-Client-Name` (1-64 chars of `[A-Za-z0-9._-]`) and `X-Client-Version` (Semantic Version
2.0.0) are **required on every protected `/v1/*` route** and rendered as OpenAPI
parameters; a missing or malformed value yields `400 bad_request` (auth runs first, so
401 / 403 still preempt the header 400). `X-Request-Id` and the `X-Guardian-*` HMAC headers
are documented but not schema-validated: a malformed request id is replaced per §3.7, and
every §5.4 HMAC violation maps to 401 per §5.4.3.

## Error envelope (§6.5)

All non-2xx responses share:

```json
{
  "error": "<machine_readable_code>",
  "message": "<human_readable_description>",
  "requestId": "<uuid>",
  "details": { /* optional */ },
  "checks": [ /* present for validation_failed, MAY be present for state_conflict */ ]
}
```

Tagged error classes (`UnauthenticatedError`, `ForbiddenError`, `BadRequestError`,
`UnsupportedMediaTypeError`, `PayloadTooLargeError`, `UnsupportedChainError`,
`NotFoundError`, `StateConflictError`, `ValidationFailedError`, `RateLimitedError`,
`InternalError`, `UpstreamUnavailableError`) are exported so abstraction implementations
can construct them directly. The `SigningError` and `GuardianError` discriminated unions
help typing custom runners.

`UpstreamUnavailableError` accepts an optional `retryAfterSeconds`; when set, the 502/503
response carries a `Retry-After` header. Unexpected (non-tagged) thrown values always
produce a 500 envelope with the fixed message `"Unexpected Guardian-side failure"` — the
real error is only visible in server-side logs.

## Running integration tests

The package ships an integration suite that boots a real anvil per vitest worker (via
[prool](https://github.com/wevm/prool)), deploys the Guardian-relevant slice of the 3F
protocol, and exercises the four `makeSign*` orchestrators end-to-end:

- `tests/integration/eip712-domain.integration.test.ts` — verifies
  `fetchEip712DomainNameVersion` reads `{ name: "3F", version: "1" }` from the deployed
  Facility and `{ name: "3fRequestWhitelist", version: "1" }` from the RequestWhitelist
  proxy, plus cache amortisation.
- `tests/integration/sign-runners.integration.test.ts` — proves each `makeSign*` produces
  signatures that recover to the configured signer. The `makeSignIntentRequestBinding`
  case additionally submits the signature on-chain via `Facility.setRequest(…)` from a
  facilitator-roled account and asserts the receipt is `success` — which verifies the
  contract accepts the off-chain digest.

Prerequisite: `anvil` on `PATH`. From the repo root:

```bash
bun run test:integration
```

The shared anvil pool, deployment script, and foundry artifacts live in the private
`@3flabs/guardian-test-fixtures` workspace package and are never published.

## License

MIT.
