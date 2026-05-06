# @3flabs/guardian

HTTP shell for the **Guardian** off-chain signer service — the v1 contract specified at
[gist b50021fb3ee2c059d228b4dcddbb577e](https://gist.github.com/maxencerb/b50021fb3ee2c059d228b4dcddbb577e).

The package never sees a private key, an HMAC secret, or a chain RPC URL. Hosts implement
a typed `GuardianAbstractions` and pass it to `buildGuardianServer(abs)`. Default building
blocks (logger, rate limiter, Appendix-A checks) live in
[`@3flabs/guardian-defaults`](https://npmjs.com/package/@3flabs/guardian-defaults).

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
  UnauthenticatedError,
  UnsupportedChainError,
  type GuardianAbstractions,
  type TokenInfo,
} from "@3flabs/guardian";

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
    guardianSigner: "0x…",
    supportedChains: [1, 8453],
  },
  liveness: async () => Result.ok(),
  getChainClient: (chainId) => {
    const client = clients[chainId as keyof typeof clients];
    return client
      ? Result.ok(client)
      : Result.err(new UnsupportedChainError({ message: `unsupported`, chainId }));
  },
  authenticate: async (token) => {
    const info = TOKENS.get(token);
    return info
      ? Result.ok(info)
      : Result.err(new UnauthenticatedError({ message: "Unknown token" }));
  },
  signTypedData: privateKeyToSignTypedData(process.env.GUARDIAN_SIGNER_KEY as Hex),
  signIntentRequestBinding: /* … */ undefined as never,
  signIntentFundBinding:    /* … */ undefined as never,
  signIntentSwap:           /* … */ undefined as never,
  signRequestWhitelisting:  /* … */ undefined as never,
};

buildGuardianServer(abs).listen(3000);
```

`SigningContext` (passed to every `sign*` abstraction) carries:

- `chainId`, `client` — viem `PublicClient` for that chain
- `requestId`, `tokenId` — for log correlation
- `now` — wall-clock snapshotted at request entry
- `signTypedData` — host EIP-712 signer
- `logger` — child-bound to `{ requestId, tokenId, chainId }`

## Logger

Optional `logger` field on `GuardianAbstractions`. Pass any pino-compatible instance, or
use `pinoLogger()` from `@3flabs/guardian-defaults`. Falls back to `noopLogger` if absent.

## Rate-limit enforcement

Optional `accountRateLimit(tokenInfo)` returning `Result<RateLimitWindow, GuardianError>`.

- `Ok(window)` populates the §6.3 `X-RateLimit-{Limit,Remaining,Reset}` headers.
- `Err(RateLimitedError)` yields 429 with `Retry-After`.

A drop-in implementation lives in `@3flabs/guardian-defaults` (`inMemoryRateLimiter`).

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

## License

MIT.
