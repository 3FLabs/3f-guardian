# @3flabs/guardian-defaults

Default building blocks for [`@3flabs/guardian`](https://npmjs.com/package/@3flabs/guardian) hosts.

Four subsystems, each independently usable via a dedicated subpath export so tree-shaking
stays effective:

- **Logger** (`/logger`) — pino + pino-pretty backed structured logger.
- **Rate limiter** (`/rate-limit`) — single-process fixed-window in-memory counter with a pluggable store.
- **Cache** (`/cache`) — generic `AsyncCache<V>` interface plus an in-memory implementation, used by §A.1 / §A.4 to amortise on-chain reads.
- **Checks** (`/checks`) — Appendix-A check-runner builders for the four signing endpoints, plus the on-chain ABIs they read.

The package depends on `@3flabs/guardian` for its types (`Logger`, `TokenInfo`, `RateLimitWindow`,
`SigningContext`, error classes, body schemas) and on `viem` for the on-chain reads.

## Install

```bash
bun add @3flabs/guardian @3flabs/guardian-defaults
# or
npm install @3flabs/guardian @3flabs/guardian-defaults
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

`PinoLoggerOptions`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `level` | `"trace" \| "debug" \| "info" \| "warn" \| "error" \| "fatal"` | `LOG_LEVEL` env, else `"info"` | |
| `pretty` | `boolean` | auto: `process.stdout.isTTY` | When `false`, emits NDJSON for log shippers. |
| `bindings` | `Record<string, unknown>` | — | Top-level fields stamped onto every record. |
| `redact` | `readonly string[]` | conservative defaults | Pino redact paths. The default list masks `Authorization`, `X-Guardian-Signature`, `X-Guardian-Timestamp`, and any field literally named `hmacSecret` / `secret`. |

The returned value is a `pino.Logger` cast to the Guardian `Logger` contract.

## Rate limiter

```ts
import { inMemoryRateLimiter } from "@3flabs/guardian-defaults/rate-limit";

const accountRateLimit = inMemoryRateLimiter({
  limit: 60,
  windowSeconds: 60,
});

const abs: GuardianAbstractions = { ...rest, accountRateLimit };
```

`RateLimiterOptions`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `limit` | `number` | required | Requests permitted per window. Must be a positive integer. |
| `windowSeconds` | `number` | required | Width of the fixed window. Must be > 0. |
| `now` | `() => number` | `Date.now` | Clock injection for tests. |
| `keyOf` | `(token: TokenInfo) => string` | `(t) => t.tokenId` | Extract the rate-limit key. |
| `store` | `RateLimitStore` | `inMemoryRateLimitStore()` | Pluggable storage. |

For multi-replica deployments, supply your own `RateLimitStore` backed by a transactional
primitive (Redis `INCR + EXPIRE`, Cloudflare Durable Object). The single-process Map-based
default is not atomic across processes.

## Cache

```ts
import { inMemoryCache } from "@3flabs/guardian-defaults/cache";
import type { AsyncCache } from "@3flabs/guardian-defaults/cache";
import type { A1OnChainData } from "@3flabs/guardian-defaults/checks";

const cache: AsyncCache<A1OnChainData> = inMemoryCache({
  defaultTtlMs: 5 * 60_000,
  maxEntries: 1000,
});
```

`InMemoryCacheOptions`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `defaultTtlMs` | `number` | unset | Applied when `set` is called without `ttlMs`. If omitted, entries live forever (until evicted by `maxEntries`). |
| `maxEntries` | `number` | `0` (unbounded) | Soft LRU bound. On overflow: sweep expired, then trim oldest insertion-ordered entries. |
| `now` | `() => number` | `Date.now` | Clock injection for tests. |

`AsyncCache<V>` is a 3-method interface (`get`, `set`, `delete`). Implementations are free
to back it with Redis / Memcached / KV; transport-backed adapters MUST handle their own
serialisation (the in-memory cache stores by reference and side-steps serialisation entirely).

The §A.1 and §A.4 check builders accept an optional `cache` to amortise the
multicall + role-events scan across requests targeting the same request contract.

## Checks

Each builder evaluates the corresponding Appendix-A checks and returns a
`CheckRunner<Body, NeedsConflict>` — an async function taking `(SigningContext, Body)` and
yielding `Result<readonly CheckEntry[], CheckRunnerError<NeedsConflict>>`. On a green run
the entries are returned `Ok`; otherwise the error union is `ValidationFailedError | UpstreamUnavailableError`
(plus `StateConflictError` for §A.2).

Hosts compose this with the typed-data builders + sign-runner orchestrators in
`@3flabs/guardian` to produce a drop-in `SignIntent…` / `SignRequestWhitelisting`
abstraction:

```ts
import {
  buildIntentSwapChecks,
  type IntentSwapPolicy,
} from "@3flabs/guardian-defaults/checks";
import { makeSignIntentSwap } from "@3flabs/guardian";

const policy: IntentSwapPolicy = {
  maxDeadlineSecondsAhead: 600,
  swapPriceToleranceBps: 1,
  acceptedPmFactories: new Map([
    [1, new Set(["0xPositionManagerFactoryAddress"])],
  ]),
  acceptedPmOwners: new Map([
    [1, new Set(["0xAcceptedOwnerAddress"])],
  ]),
};

const signIntentSwap = makeSignIntentSwap({
  checks: buildIntentSwapChecks({ policy }),
  guardianSigner: "0x…", // metadata.guardianSigner
});
```

`makeSign*` reads each verifying contract's EIP-712 domain (`name`/`version`)
via ERC-5267 `eip712Domain()` and hands the matching typed-data to
`ctx.signTypedData`. Pass an optional `cache` (`AsyncCache<{ name; version }>`
— `inMemoryCache` qualifies) to amortise the domain read across signing calls.

For callers that need the raw building blocks, the four `build*TypedData`
helpers (`buildIntentRequestBindingTypedData`, `buildIntentFundBindingTypedData`,
`buildIntentSwapTypedData`, `buildWhitelistRequestTypedData` /
`buildUnwhitelistRequestTypedData`) are exported alongside the orchestrators.

Note: the runner reads the on-chain state itself via `ctx.client` and the bundled ABIs
(see [ABIs](#abis) below). There is **no** oracle adapter port — the package is
viem-driven, not ABI-agnostic.

### The four builders

| Endpoint | Builder | `deps` |
|---|---|---|
| `intent-request-bindings` (§A.1) | `buildIntentRequestBindingChecks` | `{ policy: IntentRequestBindingPolicy, cache?, cacheTtlMs? }` |
| `intent-fund-bindings` (§A.2)    | `buildIntentFundBindingChecks`    | `{ policy: IntentFundBindingPolicy }` |
| `intent-swaps` (§A.3)            | `buildIntentSwapChecks`           | `{ policy: IntentSwapPolicy }` |
| `request-whitelistings` (§A.4)   | `buildRequestWhitelistingChecks`  | `{ policy: RequestWhitelistingPolicy, guardianSigner: Address, cache?, cacheTtlMs? }` |

`buildIntentFundBindingChecks` is the only runner whose error union includes
`StateConflictError` — the §A.2 fund-state check is the only 409-class check in v1. Per
§6.6.1 it returns `ValidationFailedError` over `StateConflictError` when both classes fail.

### Policy shapes

Every policy keys per-chain accepted sets by EIP-155 chain id; address comparisons are
case-insensitive.

```ts
type IntentRequestBindingPolicy = {
  maxDeadlineSecondsAhead: number;
  acceptedRequestFactories: ReadonlyMap<number, ReadonlySet<string>>;
  acceptedOwners:           ReadonlyMap<number, ReadonlySet<string>>;
  acceptedPullers:          ReadonlyMap<number, ReadonlySet<string>>;
  acceptedConsumers:        ReadonlyMap<number, ReadonlySet<string>>;
  eventScanBlockRange:        bigint;  // chunk size for getLogs
  eventScanMaxLookbackBlocks: bigint;  // give-up horizon
};

type IntentFundBindingPolicy = {
  maxDeadlineSecondsAhead: number;
  acceptedFunds:  ReadonlyMap<number, ReadonlySet<string>>;
  acceptedOwners: ReadonlyMap<number, ReadonlySet<string>>;
};

type IntentSwapPolicy = {
  maxDeadlineSecondsAhead: number;
  acceptedPmFactories: ReadonlyMap<number, ReadonlySet<string>>;
  acceptedPmOwners:    ReadonlyMap<number, ReadonlySet<string>>;
  swapPriceToleranceBps: number;       // 1 absorbs the ~1 wei mulDiv rounding
};

type RequestWhitelistingPolicy = IntentRequestBindingPolicy & {
  maxNonceAboveFloor: bigint;          // per-validator nonce window in the whitelist book
};
```

### Helpers

- `failed(description, reason)` / `passed(description)` / `skipped(description)` — `CheckEntry`
  builders. Re-exported from `@3flabs/guardian` so hosts writing their own runners get
  the same shape.
- `checkDeadline`, `checkMembership`, `checkNonceWindow`, `checkSwapPriceTolerance`,
  `rollUp` — primitives the bundled runners are built from. Useful when assembling
  custom check arrays.

## ABIs

The on-chain reads happen against bundled ABIs and constants, exported from the package
root for hosts that want to issue their own contract calls (e.g., to enrich responses or
to implement adjacent flows the Guardian doesn't sign for):

| Export | What it is |
|---|---|
| `facilityAbi` | Facility contract — `getIntent(id)` for §A.2. |
| `fundAbi` | Fund contract — `Ownable.owner()` plus role / order-state views. |
| `requestAbi` | Request contract — `Ownable.owner()` plus the `RolesUpdated` event scanned in §A.1. |
| `requestFactoryAbi` | Request factory — `isRequest(addr)` for §A.1, `RequestCreated` event for the deployment-block lookup. |
| `positionManagerAbi` | Position manager — `owner / assets / pendingFees / virtualShareOffset` for §A.3. |
| `positionManagerFactoryAbi` | Position-manager factory — `isPositionManager(addr)` for §A.3. |
| `whitelistBookAbi` | Whitelist book — `validatorNonceFloor` and `isNonceConsumed` for §A.4. |
| `ORDER_STATE` / `ORDER_STATE_NAME` / `OrderState` | Numeric enum + reverse map for `IFund.state(Order)`. |
| `DEPOSITOR_ROLE` | `keccak256("DEPOSITOR_ROLE")` constant referenced by §A.2. |
| `ROLE_PULLER` / `ROLE_CONSUMER` | Role bitfield constants used by the §A.1 role-events scan. |
| `VIRTUAL_ASSETS` | The `1n` constant grunt's `LibView.convertToShares` adds to `totalAssets` (used in the §A.3 share-price math). |

## Running integration tests

The four §A.1–§A.4 check runners are integration-tested against a real on-chain
deployment. Each vitest worker spins up its own anvil (via [prool](https://github.com/wevm/prool)),
deploys the Guardian-relevant slice of the 3F protocol (Facility, RequestFactory + a real
Request, PositionManagerFactory + a real PositionManager, RequestWhitelist proxy,
`OwnableMockFund`, two MockERC20s, multicall3 at the canonical address), and runs the
runner against the live state.

- `tests/integration/intent-request-binding.integration.test.ts` — §A.1 happy path,
  rogue contract (Facility passed where a Request is expected), bad puller list.
- `tests/integration/intent-fund-binding.integration.test.ts` — §A.2 happy path plus
  rotated-owner case (`OwnableMockFund.setOwner(…)` mutates the on-chain owner mid-test).
- `tests/integration/intent-swap.integration.test.ts` — §A.3 with one PM leg + one debt
  leg priced at the empty-PM share price, neither-leg-PM, bad PM owner.
- `tests/integration/request-whitelisting.integration.test.ts` — §A.4 whitelist op at
  `nonce == floor == 0`, unwhitelist op (skips per-contract §A.1), nonce-window violation.

Prerequisite: `anvil` on `PATH`. From the repo root:

```bash
bun run test:integration
```

The shared anvil pool, deployment script, and foundry artifacts live in the private
`@3flabs/guardian-test-fixtures` workspace package and are never published.

## License

MIT.
