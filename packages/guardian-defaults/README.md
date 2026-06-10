# @3flabs/guardian-defaults

Default building blocks for [`@3flabs/guardian`](https://npmjs.com/package/@3flabs/guardian) hosts.

Four subsystems, each independently usable via a dedicated subpath export so tree-shaking
stays effective:

- **Logger** (`/logger`) — pino + pino-pretty backed structured logger.
- **Rate limiter** (`/rate-limit`) — single-process fixed-window in-memory counter with a pluggable store.
- **Cache** (`/cache`) — generic `AsyncCache<V>` interface plus an in-memory implementation, used by §A.1 / §A.4 to amortise on-chain reads, and by the `makeSign*` orchestrators to amortise ERC-5267 `eip712Domain()` reads.
- **Checks** (`/checks`) — Appendix-A check-runner builders for the four signing endpoints. (The on-chain ABIs they read are exported from the package root — see the [ABIs](#abis) section.)

The package depends on `@3flabs/guardian` for its types (`Logger`, `TokenInfo`, `RateLimitWindow`,
`SigningContext`, error classes, body schemas) and on `viem` for the on-chain reads.

## Contents

- [Install](#install)
- [Full quickstart — a working Guardian on a private key](#full-quickstart--a-working-guardian-on-a-private-key)
- [Logger](#logger)
- [Rate limiter](#rate-limiter)
- [Cache](#cache)
- [Checks](#checks)
  - [The four builders](#the-four-builders)
  - [Scan & failure semantics](#scan--failure-semantics)
  - [Policy shapes](#policy-shapes)
  - [Helpers](#helpers)
- [ABIs](#abis)
- [Running integration tests](#running-integration-tests)
- [License](#license)

## Install

```bash
bun add @3flabs/guardian @3flabs/guardian-defaults viem better-result
# or
npm install @3flabs/guardian @3flabs/guardian-defaults viem better-result
```

## Full quickstart — a working Guardian on a private key

Copy-pastable. Provide `GUARDIAN_SIGNER_KEY`, the RPC URLs, and at least one bearer token
in env, then `bun run src/server.ts` (or `node --import tsx src/server.ts`). The result is a
fully functional HTTP shell that:

- authenticates `Authorization: Bearer …` against an in-memory token map,
- rate-limits per token (60 req / 60 s),
- runs the §A check runners (real on-chain reads via viem),
- signs the EIP-712 typed-data with the configured private key,
- caches `eip712Domain()` reads + §A.1/§A.4 on-chain reads in-process.

Replace the `*ADDRESSES` and the bearer token with your real values; everything else is
ready as-is. The address sets are deliberately empty `Set<string>` placeholders — the
runner will *fail every check* until you populate them, which makes it obvious where the
host policy needs to live.

```ts
// src/server.ts
import { Result } from "better-result";
import { http, createPublicClient, type Hex, type PublicClient } from "viem";
import { mainnet, base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

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
  type A1OnChainData,
  type IntentFundBindingPolicy,
  type IntentRequestBindingPolicy,
  type IntentSwapPolicy,
  type RequestWhitelistingPolicy,
} from "@3flabs/guardian-defaults/checks";

// ── 1. Signing key ────────────────────────────────────────────────────
//
// Dev only. Production deployments substitute a KMS / HSM-backed
// `SignTypedData` for `privateKeyToSignTypedData`; the host owns the
// key, this package never sees it.
const PRIVATE_KEY = process.env.GUARDIAN_SIGNER_KEY as Hex | undefined;
if (!PRIVATE_KEY) throw new Error("Missing GUARDIAN_SIGNER_KEY");
const guardianSigner = privateKeyToAccount(PRIVATE_KEY).address;
const signTypedData = privateKeyToSignTypedData(PRIVATE_KEY);

// ── 2. Chain clients ──────────────────────────────────────────────────
//
// Typed as `Record<number, PublicClient>` and individually cast so the
// chain-narrowed generics viem produces (e.g. base's deposit-tx
// formatter) are widened to the generic `PublicClient` shape
// `GuardianAbstractions.getChainClient` expects. The Guardian only
// reads on-chain views, so a chain-less generic `PublicClient` is
// sufficient.
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

// ── 3. Bearer-token directory ─────────────────────────────────────────
//
// Tiny in-memory map for the quickstart. Real deployments pull this
// from the host's secret store. `requiresHmac: true` would additionally
// gate the route on §5.4 timestamp + body-HMAC verification using
// `hmacSecret`.
const TOKENS = new Map<string, TokenInfo>([
  [
    process.env.DEV_BEARER_TOKEN ?? "dev-token",
    {
      tokenId: "dev",
      scopes: new Set(ENDPOINT_SCOPES),
      requiresHmac: false,
    },
  ],
]);

// ── 4. Caches ─────────────────────────────────────────────────────────
//
// Two independent caches — see the "Cache" section below for the
// rationale on splitting them. Sized for a small operator; bump
// `maxEntries` for high-traffic deployments.
const eip712DomainCache = inMemoryCache<{ name: string; version: string }>({
  defaultTtlMs: 24 * 60 * 60_000, // 24h — domains are immutable absent a contract upgrade
  maxEntries: 256,
});
const a1OnChainCache = inMemoryCache<A1OnChainData>({
  defaultTtlMs: 5 * 60_000, // 5min — Request roles change rarely but not never
  maxEntries: 1024,
});

// ── 5. Policies ───────────────────────────────────────────────────────
//
// Per-chain accepted-set membership. The runner FAILS each check when
// its accepted set is empty, so populate these with the real factory /
// owner / puller / consumer / fund / position-manager addresses your
// deployment trusts. Address comparisons are case-insensitive.
const requestBindingPolicy: IntentRequestBindingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedRequestFactories: new Map([
    [1, new Set<string>(/* "0xRequestFactoryOnMainnet" */)],
    [8453, new Set<string>(/* "0xRequestFactoryOnBase" */)],
  ]),
  acceptedOwners: new Map([
    [1, new Set<string>(/* "0xOwner1", "0xOwner2", … */)],
    [8453, new Set<string>()],
  ]),
  acceptedPullers: new Map([
    [1, new Set<string>(/* "0xPullerSafe" */)],
    [8453, new Set<string>()],
  ]),
  acceptedConsumers: new Map([
    [1, new Set<string>(/* "0xConsumer" */)],
    [8453, new Set<string>()],
  ]),
  eventScanBlockRange: 10_000n,
  eventScanMaxLookbackBlocks: 1_000_000n,
};

const fundBindingPolicy: IntentFundBindingPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedFunds: new Map([
    [1, new Set<string>(/* "0xFundContract" */)],
    [8453, new Set<string>()],
  ]),
  acceptedOwners: new Map([
    [1, new Set<string>(/* "0xOwner1" */)],
    [8453, new Set<string>()],
  ]),
};

const swapPolicy: IntentSwapPolicy = {
  maxDeadlineSecondsAhead: 600,
  acceptedPmFactories: new Map([
    [1, new Set<string>(/* "0xPositionManagerFactory" */)],
    [8453, new Set<string>()],
  ]),
  acceptedPmOwners: new Map([
    [1, new Set<string>(/* "0xOwner1" */)],
    [8453, new Set<string>()],
  ]),
  swapPriceToleranceBps: 1, // ~1 wei mulDiv rounding tolerance
};

const whitelistingPolicy: RequestWhitelistingPolicy = {
  ...requestBindingPolicy, // same accepted sets — whitelist op runs §A.1 per-contract
  maxNonceAboveFloor: 100n,
};

// ── 6. Abstractions object ────────────────────────────────────────────
const abs: GuardianAbstractions = {
  metadata: {
    build: process.env.BUILD_ID ?? "0.1.0",
    guardianSigner,
    supportedChains,
  },
  logger: pinoLogger({
    level: "info",
    pretty: process.env.NODE_ENV !== "production",
    bindings: { service: "guardian" },
  }),
  liveness: async () => Result.ok(),
  getChainClient: (chainId) => {
    const client = clients[chainId];
    return client
      ? Result.ok(client)
      : Result.err(
          new UnsupportedChainError({ message: `Unsupported chain ${chainId}`, chainId }),
        );
  },
  authenticate: async (token) => {
    const info = TOKENS.get(token);
    return info
      ? Result.ok(info)
      : Result.err(new UnauthenticatedError({ message: "Unknown token" }));
  },
  signTypedData,
  accountRateLimit: inMemoryRateLimiter({ limit: 60, windowSeconds: 60 }),

  // The four §7 sign-runners. Each composes:
  //   real check runner (this package) → typed-data builder + ERC-5267
  //   `eip712Domain()` resolution + `signTypedData` (@3flabs/guardian).
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

// ── 7. Listen ─────────────────────────────────────────────────────────
buildGuardianServer(abs).listen(3000);
console.log("Guardian listening on :3000");
console.log(`  GET  http://localhost:3000/health`);
console.log(`  GET  http://localhost:3000/version`);
console.log(`  GET  http://localhost:3000/openapi`);
```

Smoke test:

```bash
curl -s localhost:3000/health
# {"status":"ok"}

curl -s localhost:3000/version
# {"apiVersion":"v1","build":"0.1.0","guardianSigner":"0x…","supportedChains":[1,8453]}

curl -s localhost:3000/v1/facility/intent-request-bindings \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -H "X-Client-Name: smoke-test" \
  -H "X-Client-Version: 1.0.0" \
  -d '{ "chainId": 1, "facility": "0x…", "intent": { "id": "1" }, "requestContract": "0x…", "deadline": 9999999999 }'
# either { ...SigningSuccess } or { error: "validation_failed", checks: [...] }
```

The §6.2 `X-Client-Name` / `X-Client-Version` headers are required on every protected
`/v1/*` route — a missing or malformed value yields `400 bad_request`.

`buildGuardianServer` returns a vanilla [Elysia](https://elysiajs.com/) instance — `.listen`,
`.handle` (for tests), `.use` (for further composition) all work as you'd expect.

## Logger

```ts
import { pinoLogger } from "@3flabs/guardian-defaults/logger";

const logger = pinoLogger({
  level: "info",
  pretty: process.env.NODE_ENV !== "production",
  bindings: { service: "guardian" },
});
```

`PinoLoggerOptions`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `level` | `"trace" \| "debug" \| "info" \| "warn" \| "error" \| "fatal" \| "silent"` | `LOG_LEVEL` env, else `"info"` | `LOG_LEVEL` is case-insensitive and accepts the syslog-style alias `warning` (→ `warn`); unrecognised values fall back to `"info"` with a one-time stderr warning instead of crashing pino at construction. |
| `pretty` | `boolean` | auto: `process.stdout.isTTY` | When `false`, emits NDJSON for log shippers. |
| `bindings` | `Record<string, unknown>` | — | Top-level fields stamped onto every record. |
| `redact` | `readonly string[]` | `DEFAULT_REDACT_PATHS` | Pino redact paths. The defaults mask `Authorization`, `X-Guardian-Signature`, `X-Guardian-Timestamp`, and `hmacSecret` / `secret` / `privateKey` fields up to two levels deep (e.g. `auth.tokenInfo.hmacSecret`). |

Supplying `redact` REPLACES the defaults. `DEFAULT_REDACT_PATHS` is exported from
`@3flabs/guardian-defaults/logger` so hosts can merge it with their own paths:

```ts
import { DEFAULT_REDACT_PATHS, pinoLogger } from "@3flabs/guardian-defaults/logger";

const logger = pinoLogger({
  redact: [...DEFAULT_REDACT_PATHS, "config.db.password"],
});
```

Note pino wildcards match exactly one path segment — there is no recursive wildcard — so
secrets nested three or more levels deep still need host-supplied paths.

The returned value is a `pino.Logger` cast to the Guardian `Logger` contract.

## Rate limiter

```ts
import { inMemoryRateLimiter } from "@3flabs/guardian-defaults/rate-limit";

const accountRateLimit = inMemoryRateLimiter({
  limit: 60,
  windowSeconds: 60,
});
```

`RateLimiterOptions`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `limit` | `number` | required | Requests permitted per window. Must be a positive integer. |
| `windowSeconds` | `number` | required | Width of the fixed window. Must be > 0. |
| `now` | `() => number` | `Date.now` | Clock injection for tests. |
| `keyOf` | `(token: TokenInfo) => string` | `(t) => t.tokenId` | Extract the rate-limit key. |
| `store` | `RateLimitStore` | `inMemoryRateLimitStore()` | Pluggable storage. |

`RateLimitStore` exposes `read` / `write` plus an optional atomic
`consume(key, limit, windowSeconds, nowSec)` returning a `RateLimitDecision`
(`{ allowed, count, resetUnixSeconds }`; both types are exported from
`@3flabs/guardian-defaults/rate-limit`). The limiter delegates the check-and-increment to
`store.consume` when available; for custom stores exposing only `read` / `write` it
serialises the read-modify-write per key in-process, so a concurrent burst cannot bypass
the per-token limit — but that fallback is single-process safe only. The bundled
`inMemoryRateLimitStore` implements `consume`.

For multi-replica deployments, supply your own `RateLimitStore` and implement `consume` on
a transactional primitive (Redis `INCR` + `EXPIRE`, a Cloudflare Durable Object). The
single-process Map-based default is not atomic across processes.

`resetUnixSeconds` and `retryAfterSeconds` are rounded up to whole seconds, so `Retry-After`
and `X-RateLimit-Reset` are always RFC-9110-valid integers even with a fractional
`windowSeconds`.

## Cache

Two distinct cache surfaces — keep them separate so TTLs and eviction policies can diverge.

| Cache | Value type | What it caches | Sensible TTL |
|---|---|---|---|
| EIP-712 domain | `{ name: string; version: string }` | `eip712Domain()` reads per `(chainId, verifyingContract)` — used by the `makeSign*` orchestrators in `@3flabs/guardian`. | 24h (immutable absent contract upgrade) |
| §A.1 / §A.4 on-chain | `A1OnChainData` | Request-contract roles + factory linkage scanned by the §A.1 runner (also used by §A.4 per-contract). | 1–5 min |

```ts
import { inMemoryCache, type AsyncCache } from "@3flabs/guardian-defaults/cache";
import type { A1OnChainData } from "@3flabs/guardian-defaults/checks";

const eip712DomainCache: AsyncCache<{ name: string; version: string }> = inMemoryCache({
  defaultTtlMs: 24 * 60 * 60_000,
  maxEntries: 256,
});

const a1OnChainCache: AsyncCache<A1OnChainData> = inMemoryCache({
  defaultTtlMs: 5 * 60_000,
  maxEntries: 1024,
});
```

`InMemoryCacheOptions`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `defaultTtlMs` | `number` | unset | Applied when `set` is called without `ttlMs`. If omitted, entries live forever (until evicted by `maxEntries`). |
| `maxEntries` | `number` | `4096` (`DEFAULT_MAX_ENTRIES`) | Soft LRU bound. On overflow: sweep expired, then trim oldest insertion-ordered entries. Pass an explicit `0` to opt back into unbounded growth. |
| `now` | `() => number` | `Date.now` | Clock injection for tests. |

`set` throws on a non-finite or non-positive per-call `ttlMs` (e.g. `NaN` from an unset env
var) instead of silently creating an immortal or instantly-expiring entry; callers already
treat a throwing `set` as best-effort per the `AsyncCache` contract.

`AsyncCache<V>` is a 3-method interface (`get`, `set`, `delete`). Implementations are free
to back it with Redis / Memcached / KV; transport-backed adapters MUST handle their own
serialisation (the in-memory cache stores by reference and side-steps serialisation entirely).

## Checks

Each builder evaluates the corresponding Appendix-A checks and returns a
`CheckRunner<Body, NeedsConflict>` — an async function taking `(SigningContext, Body)` and
yielding `Result<readonly CheckEntry[], CheckRunnerError<NeedsConflict>>`. On a green run
the entries are returned `Ok`; otherwise the error union is `ValidationFailedError | UpstreamUnavailableError`
(plus `StateConflictError` for §A.2).

Hosts compose the builder's runner with the typed-data orchestrators in `@3flabs/guardian`
to produce a drop-in `SignIntent…` / `SignRequestWhitelisting` abstraction — see the
quickstart above for the full wiring of all four endpoints.

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

### Scan & failure semantics

The §A.1 role-events scan (also run per request contract by §A.4 whitelist ops) walks
`getLogs` backwards in `eventScanBlockRange`-sized chunks — every chunk, including the
deepest one, spans at most `eventScanBlockRange` blocks, so providers with a hard range
limit equal to the configured range never reject a chunk.

- **Lookback exhausted** — when the scan exhausts `eventScanMaxLookbackBlocks` without
  observing the contract's deployment, role grants observed inside the scanned window are
  still evaluated one-sidedly: any non-accepted puller / consumer holder observed in-window
  fails the §A.1 / §A.4 checks (422). Partial data can only reject, never approve. The
  residual disposition is governed by `onLookbackExhausted`: `"skip"` (default) emits the
  role checks as skipped, `"fail"` fails closed (422).
- **Scan budget** — `eventScanDeadlineMs` (optional) bounds a single scan's wall clock;
  when exceeded the request fails `503 upstream_unavailable` instead of holding the
  handler indefinitely.
- **422 vs 503** — deterministic `owner()` / `isRequest()` failures (e.g. an EOA or
  unrelated contract supplied as `requestContract`) are classified as a cached `noFactory`
  result that fails the "deployed by an accepted factory" check (422). Likewise a
  `whitelistBook` whose nonce reads deterministically revert or return no data (e.g. an
  EOA) fails a 422 "whitelist book exposes per-validator nonce state" check.
  `503 upstream_unavailable` is reserved for genuine transport-level RPC failures.
- **§A.4 request guards** — before any RPC: a `requestContracts` batch larger than
  `maxRequestContracts` (default `DEFAULT_MAX_REQUEST_CONTRACTS = 50`, exported from
  `@3flabs/guardian-defaults/checks`) fails a 422 check for both whitelist and unwhitelist
  operations — the builder throws at construction for a non-positive or fractional cap —
  and, when `acceptedWhitelistBooks` is configured, an off-policy `whitelistBook` (the
  EIP-712 `verifyingContract`) fails a 422 "whitelist book is on the accepted-books list"
  check.
- **Swap tolerance** — `buildIntentSwapChecks` throws a `TypeError` at construction when
  `swapPriceToleranceBps` is not a non-negative integer. Whenever the bps is > 0 the
  tolerance is floored at 1 wei, so small legs (`expectedDebt × bps < 10,000`) retain the
  documented ~1 wei mulDiv rounding slack; `0` still means strict equality.

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
  eventScanBlockRange:        bigint;  // chunk size for getLogs (every chunk ≤ this)
  eventScanMaxLookbackBlocks: bigint;  // give-up horizon
  eventScanDeadlineMs?:       number;  // wall-clock budget per scan; exceeded ⇒ 503
  onLookbackExhausted?: "skip" | "fail"; // role checks when the horizon is exhausted (default "skip")
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
  swapPriceToleranceBps: number;       // non-negative integer; 1 absorbs the ~1 wei mulDiv rounding
};

type RequestWhitelistingPolicy = IntentRequestBindingPolicy & {
  maxNonceAboveFloor: bigint;          // per-validator nonce window in the whitelist book
  acceptedWhitelistBooks?: ReadonlyMap<number, ReadonlySet<string>>; // gate on the EIP-712 verifyingContract
  maxRequestContracts?: number;        // batch cap; default DEFAULT_MAX_REQUEST_CONTRACTS (50)
};
```

### Helpers

- `failed(description, reason)` / `passed(description)` / `skipped(description)` — `CheckEntry`
  builders. Re-exported from `@3flabs/guardian` so hosts writing their own runners get
  the same shape.
- `checkDeadline`, `checkMembership`, `checkNonceWindow`, `checkSwapPriceTolerance`,
  `rollUp` — primitives the bundled runners are built from. Useful when assembling
  custom check arrays. `checkSwapPriceTolerance` never throws: an invalid `toleranceBps`
  yields a failed check entry (fail closed) instead of an exception.

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

The four §A.1–§A.4 check runners and the four `makeSign*` orchestrators are
integration-tested against a real on-chain deployment. Each vitest worker spins up its
own anvil (via [prool](https://github.com/wevm/prool)), deploys the Guardian-relevant
slice of the 3F protocol (Facility, RequestFactory + a real Request, PositionManagerFactory
+ a real PositionManager, RequestWhitelist proxy, `OwnableMockFund`, two MockERC20s,
multicall3 at the canonical address), and runs the runners + orchestrators against the
live state.

- `tests/integration/intent-request-binding.integration.test.ts` — §A.1 happy path,
  rogue contract (Facility passed where a Request is expected), bad puller list.
- `tests/integration/intent-fund-binding.integration.test.ts` — §A.2 happy path plus
  rotated-owner case (`OwnableMockFund.setOwner(…)` mutates the on-chain owner mid-test).
- `tests/integration/intent-swap.integration.test.ts` — §A.3 with one PM leg + one debt
  leg priced at the empty-PM share price, neither-leg-PM, bad PM owner.
- `tests/integration/request-whitelisting.integration.test.ts` — §A.4 whitelist op at
  `nonce == floor == 0`, unwhitelist op (skips per-contract §A.1), nonce-window violation.
- `tests/integration/e2e-sign-runners.integration.test.ts` — full end-to-end flow per §7
  endpoint: real check runner → real `makeSign*` orchestrator → broadcast on-chain via
  `Facility.setRequest` / `setFund` / `swap` / `RequestWhitelist.{whitelist,unwhitelist}BySig`.
  Failure paths cover `NotGuardian`, `DeadlineExpired` / `SwapExpired`, `QuorumNotMet`,
  `DuplicateSignature`, and `NonceConsumed`.

Prerequisite: `anvil` on `PATH`. From the repo root:

```bash
bun run test:integration
```

The shared anvil pool, deployment script, and foundry artifacts live in the private
`@3flabs/guardian-test-fixtures` workspace package and are never published.

## License

MIT.
