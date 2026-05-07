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

import {
  buildGuardianServer,
  privateKeyToSignTypedData,
  ENDPOINT_SCOPES,
  UnauthenticatedError,
  UnsupportedChainError,
  type GuardianAbstractions,
  type SignIntentRequestBinding,
  type SignIntentFundBinding,
  type SignIntentSwap,
  type SignRequestWhitelisting,
  type TokenInfo,
} from "@3flabs/guardian";

const clients = {
  1: createPublicClient({ chain: mainnet, transport: http(process.env.RPC_MAINNET) }),
  8453: createPublicClient({ chain: base, transport: http(process.env.RPC_BASE) }),
} as const;

const TOKENS = new Map<string, TokenInfo>([
  // [bearerToken, { tokenId, scopes: new Set([...]), requiresHmac, hmacSecret? }]
]);

// Each sign* function: validate (Appendix-A checks), then build typed data and call
// ctx.signTypedData. The check primitives live in `@3flabs/guardian-defaults/checks`.
declare const signIntentRequestBinding: SignIntentRequestBinding;
declare const signIntentFundBinding:    SignIntentFundBinding;
declare const signIntentSwap:           SignIntentSwap;
declare const signRequestWhitelisting:  SignRequestWhitelisting;

const abs: GuardianAbstractions = {
  metadata: {
    build: process.env.BUILD_ID ?? "0.1.0",
    guardianSigner: "0x…",
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
  signTypedData: privateKeyToSignTypedData(process.env.GUARDIAN_SIGNER_KEY as Hex),
  signIntentRequestBinding,
  signIntentFundBinding,
  signIntentSwap,
  signRequestWhitelisting,
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

## License

MIT.
