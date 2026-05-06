# @3flabs/guardian-defaults

Default building blocks for [`@3flabs/guardian`](https://npmjs.com/package/@3flabs/guardian) hosts.

Three subsystems, each independently usable:

- **Logger** — pino + pino-pretty backed structured logger.
- **Rate limiter** — single-process fixed-window in-memory counter, pluggable store.
- **Checks** — Appendix-A check-runner builders for the four signing endpoints. Adapter ports
  for protocol-specific contract reads keep the package ABI-agnostic.

## Install

```bash
bun add @3flabs/guardian @3flabs/guardian-defaults
```

## Logger

```ts
import { pinoLogger } from "@3flabs/guardian-defaults/logger";

const logger = pinoLogger({
  level: "info",
  pretty: process.env.NODE_ENV !== "production",
  bindings: { service: "guardian" },
});

const abs: GuardianAbstractions = { ...rest, logger };
```

`pretty` auto-disables when stdout is not a TTY (production deployments get NDJSON).
A conservative `redact` list masks `Authorization`, `X-Guardian-Signature`, and `hmacSecret`
fields if they appear in the structured payload.

## Rate limiter

```ts
import { inMemoryRateLimiter } from "@3flabs/guardian-defaults/rate-limit";

const accountRateLimit = inMemoryRateLimiter({
  limit: 60,
  windowSeconds: 60,
});

const abs: GuardianAbstractions = { ...rest, accountRateLimit };
```

Single-process by default. For multi-replica deployments, supply your own `store: RateLimitStore`
backed by a transactional primitive (Redis `INCR + EXPIRE`, Cloudflare Durable Object).

## Checks

Each builder evaluates the corresponding Appendix-A checks and returns
`Result<CheckEntry[], ValidationFailedError | UpstreamUnavailableError | …>`.

Hosts compose this with their own typed-data builder & call `ctx.signTypedData` after a
green run:

```ts
import {
  buildIntentSwapChecks,
  acceptedSwapPair,
  type IntentSwapPolicy,
  type SwapPriceOracle,
} from "@3flabs/guardian-defaults/checks";

const checks = buildIntentSwapChecks({
  policy: {
    maxDeadlineSecondsAhead: 600,
    swapPriceToleranceBps: 5,
    acceptedSwapPairs: new Map([[1, new Set([acceptedSwapPair(USDC, WETH)])]]),
  },
  oracle: { readReferencePriceWad: async (ctx, { assetA, assetB }) => /* WAD */ },
});

const signIntentSwap: SignIntentSwap = async (ctx, body) => {
  const r = await checks(ctx, body);
  if (r.isErr()) return r as never;
  // ... build typed data, call ctx.signTypedData(...), return SigningSuccess
};
```

The four builders:

| Endpoint | Builder | Adapter ports |
|---|---|---|
| `intent-request-bindings` (§A.1) | `buildIntentRequestBindingChecks` | `RequestContractReader` |
| `intent-fund-bindings` (§A.2)    | `buildIntentFundBindingChecks`    | `FundContractReader` |
| `intent-swaps` (§A.3)            | `buildIntentSwapChecks`           | `SwapPriceOracle` |
| `request-whitelistings` (§A.4)   | `buildRequestWhitelistingChecks`  | `RequestContractReader`, `WhitelistBookReader` |

`buildIntentFundBindingChecks` is the only runner whose error union includes
`StateConflictError` (§A.2 fund-state is the only 409-class check in v1). Per §6.6.1,
it returns `ValidationFailedError` over `StateConflictError` when both classes fail.

## License

MIT.
