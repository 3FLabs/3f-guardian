# @3flabs/guardian

HTTP shell for the **Guardian** off-chain signer service — the v1 contract specified at
[gist b50021fb3ee2c059d228b4dcddbb577e](https://gist.github.com/maxencerb/b50021fb3ee2c059d228b4dcddbb577e).

The package never sees a private key, an HMAC secret, or a chain RPC URL. Hosts implement
a typed `GuardianAbstractions` and pass it to `buildGuardianServer(abs)`. Default building
blocks (logger, rate limiter, cache, Appendix-A check builders, on-chain ABIs) live in the
companion [`@3flabs/guardian-defaults`](https://npmjs.com/package/@3flabs/guardian-defaults).

## Install

```bash
bun add @3flabs/guardian
# or
npm install @3flabs/guardian
```

Peer runtime: any ESM-compatible Node ≥ 20 / Bun ≥ 1.1.

## Quick start

```ts
import { Result } from "better-result";
import { http, createPublicClient, type Hex } from "viem";
import { mainnet, base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import {
  buildGuardianServer,
  privateKeyToSignTypedData,
  makeSignIntentRequestBinding,
  makeSignIntentFundBinding,
  makeSignIntentSwap,
  makeSignRequestWhitelisting,
  UnauthenticatedError,
  UnsupportedChainError,
  type GuardianAbstractions,
  type TokenInfo,
} from "@3flabs/guardian";
import {
  buildIntentRequestBindingChecks,
  buildIntentFundBindingChecks,
  buildIntentSwapChecks,
  buildRequestWhitelistingChecks,
} from "@3flabs/guardian-defaults/checks";
import { inMemoryCache } from "@3flabs/guardian-defaults/cache";

const clients = {
  1: createPublicClient({ chain: mainnet, transport: http(process.env.RPC_MAINNET) }),
  8453: createPublicClient({ chain: base, transport: http(process.env.RPC_BASE) }),
} as const;

const TOKENS = new Map<string, TokenInfo>([
  // [bearerToken, { tokenId, scopes: new Set([...]), requiresHmac, hmacSecret? }]
]);

const PRIVATE_KEY = process.env.GUARDIAN_SIGNER_KEY as Hex | undefined;
if (!PRIVATE_KEY) throw new Error("Missing GUARDIAN_SIGNER_KEY");
const guardianSigner = privateKeyToAccount(PRIVATE_KEY).address;
const signTypedData = privateKeyToSignTypedData(PRIVATE_KEY);

// Optional shared cache for ERC-5267 `eip712Domain()` reads (one read
// amortised across every signing call to that contract).
const eip712DomainCache = inMemoryCache<{ name: string; version: string }>({
  defaultTtlMs: 24 * 60 * 60_000,
});

const abs: GuardianAbstractions = {
  metadata: {
    build: process.env.BUILD_ID ?? "0.1.0",
    guardianSigner,
    supportedChains: [1, 8453],
  },
  liveness: async () => Result.ok(),
  getChainClient: (chainId) => {
    const client = clients[chainId as keyof typeof clients];
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
  // Each `makeSign*` factory wires a defaults-package check runner into a
  // ready-to-use validate-and-sign abstraction: the runner evaluates
  // Appendix-A on-chain checks, this package fetches the EIP-712 domain
  // (`eip712Domain()` per ERC-5267) and signs the matching typed-data.
  signIntentRequestBinding: makeSignIntentRequestBinding({
    checks: buildIntentRequestBindingChecks({ policy: /* see defaults README */ }),
    guardianSigner,
    cache: eip712DomainCache,
  }),
  signIntentFundBinding: makeSignIntentFundBinding({
    checks: buildIntentFundBindingChecks({ policy: /* … */ }),
    guardianSigner,
    cache: eip712DomainCache,
  }),
  signIntentSwap: makeSignIntentSwap({
    checks: buildIntentSwapChecks({ policy: /* … */ }),
    guardianSigner,
    cache: eip712DomainCache,
  }),
  signRequestWhitelisting: makeSignRequestWhitelisting({
    checks: buildRequestWhitelistingChecks({ policy: /* … */, guardianSigner }),
    guardianSigner,
    cache: eip712DomainCache,
  }),
};

buildGuardianServer(abs).listen(3000);
```

`buildGuardianServer` returns a vanilla [Elysia](https://elysiajs.com/) instance, so callers
retain full access to `.listen()`, `.handle()` (for tests), and `.use()` for further
composition.

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
- `accountRateLimit?(tokenInfo): Promise<Result<RateLimitWindow, GuardianError>>` — populates §6.3 `X-RateLimit-*` headers; `Err(RateLimitedError)` yields 429 with `Retry-After`. Use `inMemoryRateLimiter()` from `@3flabs/guardian-defaults`.
- `probeUpstream?(): Result<void, UpstreamUnavailableError>` — request-time upstream probe.

`TokenInfo`:

```ts
type TokenInfo = {
  readonly tokenId: string;
  readonly scopes: ReadonlySet<EndpointScope>;   // see ENDPOINT_SCOPES
  readonly requiresHmac: boolean;
  readonly hmacSecret?: string;                   // required when requiresHmac is true
};
```

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

For `intent-swaps`, `canonicaliseSwapLegs` sorts legs by ascending intent id (asset address as tie-break) so `[A, B]` and `[B, A]` produce byte-identical `signature` and `payloadHash` (§7.5).

The orchestrators accept an optional `Eip712DomainCache` (structurally compatible with `AsyncCache<{ name; version }>` from `@3flabs/guardian-defaults/cache`) so the per-contract `eip712Domain()` read is amortised across signing calls. `fetchEip712DomainNameVersion` is exported separately for callers that compose their own runners.

## `SigningContext`

Passed to every `sign*` abstraction:

- `chainId`, `client` — viem `PublicClient` for that chain
- `requestId`, `tokenId` — for log correlation
- `now` — wall-clock snapshotted at request entry (deadline checks rely on this)
- `signTypedData` — host EIP-712 signer
- `logger` — child-bound to `{ requestId, tokenId, chainId }`

## Endpoints

| Method | Path | Scope | 409? |
|--------|------|-------|------|
| GET    | `/health`                                  | (unauthenticated) | — |
| GET    | `/version`                                 | (unauthenticated) | — |
| POST   | `/v1/facility/intent-request-bindings`     | `facility:intent-request-bindings`     | no  |
| POST   | `/v1/facility/intent-fund-bindings`        | `facility:intent-fund-bindings`        | yes |
| POST   | `/v1/facility/intent-swaps`                | `facility:intent-swaps`                | no  |
| POST   | `/v1/whitelist-book/request-whitelistings` | `whitelist-book:request-whitelistings` | no  |

OpenAPI spec at `/openapi/json`; Scalar UI at `/openapi`.

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
`UnsupportedMediaTypeError`, `UnsupportedChainError`, `NotFoundError`, `StateConflictError`,
`ValidationFailedError`, `RateLimitedError`, `InternalError`, `UpstreamUnavailableError`)
are exported so abstraction implementations can construct them directly. The
`SigningError` and `GuardianError` discriminated unions help typing custom runners.

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
