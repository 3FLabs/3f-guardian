# @3flabs/guardian

## 0.5.0

### Minor Changes

- 9b4543c: Export the shared runSigning helper for in-process coordinator integrations.

## 0.4.0

### Minor Changes

- 43e918b: Second review-response hardening pass.

  `@3flabs/guardian`:

  - **HMAC verification now runs BEFORE the §5.2 scope check.** For HMAC-flagged tokens the body signature completes authentication, so a stolen bearer token without the secret sees a uniform 401 instead of reading scope membership from the 401-vs-403 split.
  - 401 responses carry `WWW-Authenticate: Bearer realm="guardian"` (RFC 9110 §11.6.1).
  - Content-type gates compare the exact media type instead of a prefix: `application/jsonx` is now 415, `application/json; charset=utf-8` still accepted.
  - `GuardianTimeouts` overrides above `2^31 − 1` ms are rejected at construction — `setTimeout` would wrap them to ~1 ms and turn every request into an instant 503.
  - `runSigning` accepts an optional `requestSignal` (joined into `SigningContext.signal` via `AbortSignal.any`) and the built-in routes pass the HTTP request's own signal, so a disconnected client's on-chain/KMS work stops at the next cancellation point.
  - The deadline timer aborts/rejects before logging, so a throwing host logger can neither skip the timeout nor crash the process from a timer callback.
  - `privateKeyToSignTypedData` no longer surfaces viem error text in the 500 envelope; the original error is preserved as `cause`.

  `@3flabs/guardian-defaults`:

  - **§A.2 now enforces `positionManager`:** the field was previously required, documented as a check input, and read by nothing. The runner now checks it against the intent's `isPositionManager`-flagged deposit/target asset (no extra RPC — the data was already in the `getIntent` read).
  - **§A.1 scans every factory that claims the contract:** with multiple accepted factories answering `isRequest=true` (factory migration, registry proxies), the role-events scan now accepts the `RequestCreated` deployment marker from any of them instead of silently degrading to `tooOld` against `factoryHits[0]`; multi-hits are logged at error level and the cache entry is attributed to the factory that actually emitted the event.
  - `AsyncCache.get` purges (best-effort `delete`) an entry that fails schema validation and notifies a new overridable `onValidationFailure` hook; `inMemoryCache` exposes it as an option — cache poisoning and version skew are no longer silent.
  - `checkSwapPriceTolerance` now applies the same 1-wei tolerance floor as the §A.3 runner via the shared (and newly exported) `bpsToleranceWithWeiFloor`, so hosts composing custom checks don't get spurious 422s on small legs.
  - §A.4 emits exactly one request-wide deadline entry on the failure path too (previously the per-contract §A.1 deadline entry was duplicated there); `DEADLINE_CHECK_DESCRIPTION` is exported for hosts that post-process check arrays.

  Tooling: `fixtures:check` hard-fails any provenance stamp that is not a full 40-hex commit hash (previously only `-dirty`; `no-git` passed forever), CI builds the locally-vendored fixture contracts so the byte-comparison path does real work on runners, and workflows carry `timeout-minutes`.

- 43e918b: Repo-wide hardening pass: resilience, correctness, and spec-conformance fixes across the HTTP shell and the default check runners.

  **@3flabs/guardian**

  - Unknown routes / method mismatches now return `404 not_found` (was `500 internal_error`); malformed JSON bodies return `400 bad_request` (was 500); unexpected errors return a fixed `"Unexpected Guardian-side failure"` message instead of leaking the thrown error text.
  - **Breaking for clients:** the §6.2 `X-Client-Name` / `X-Client-Version` headers are now required on every protected `/v1/*` route (400 when missing/malformed) and rendered in the OpenAPI document.
  - New optional `GuardianAbstractions.timeouts` (defaults exported as `DEFAULT_GUARDIAN_TIMEOUTS`) bounds every host abstraction call; `authenticate` / `accountRateLimit` / `liveness` / `SigningContext` now receive an `AbortSignal`.
  - New optional `GuardianAbstractions.maxBodyBytes` (default 1 MiB, `DEFAULT_MAX_BODY_BYTES`) caps request bodies with a 413 before authentication.
  - `probeUpstream`, when supplied, is now actually consulted before signing work.
  - JSON content types match case-insensitively; non-JSON bodies on host-composed routes are no longer hijacked by the guardian parser.
  - A `verifyingContract` with no code / no ERC-5267 support now yields `404 not_found` instead of `503`; `UpstreamUnavailableError` gained `retryAfterSeconds` → `Retry-After`.
  - Decimal uint256 string fields reject >78-digit and non-numeric input as field-level 400s instead of risking event-loop stalls (`zUintString` hardening).
  - `buildIntentSwapTypedData` / whitelisting builders now enforce `verifyingContract === body.facility|whitelistBook`.

  **@3flabs/guardian-defaults**

  - **Fail-closed fixes:** role-holder checks no longer pass when the event scan ends `tooOld` after observing a rogue grant; new `onLookbackExhausted: "skip" | "fail"` policy knob.
  - Deterministic client-input failures (EOA / wrong contract supplied) across A.1/A.2/A.4 now fail checks with 422 instead of returning `503 upstream_unavailable`; upstream error text is no longer embedded in client-facing 503 messages.
  - Rate limiter is burst-safe: new atomic `RateLimitStore.consume` (`RateLimitDecision`); whole-second `Retry-After` values.
  - `inMemoryCache` is bounded by default (`DEFAULT_MAX_ENTRIES` = 4096) and rejects invalid `ttlMs`; `pinoLogger` validates `LOG_LEVEL` (invalid values fall back to `info`), and the default redact list (`DEFAULT_REDACT_PATHS`) covers `privateKey` and nested secrets.
  - New `RequestWhitelistingPolicy.maxRequestContracts` (default 50) and `acceptedWhitelistBooks`; `eventScanDeadlineMs` budget for role-event scans; `getLogs` chunking respects the configured range cap on the final chunk; swap tolerance floors at 1 wei when `swapPriceToleranceBps > 0` and rejects non-integer bps at construction.

### Patch Changes

- 43e918b: **Breaking (`@3flabs/guardian-defaults`):** `AsyncCache<V>` is now an abstract class with schema-validated reads instead of a 3-method interface.

  - The constructor takes a schema — any [Standard Schema](https://standardschema.dev) (zod ≥ 3.24 / v4, valibot ≥ 1.0, arktype ≥ 2.0, …) — and the value type `V` is inferred from the schema's output.
  - `get` is implemented by the base class: it performs a raw lookup via the new protected abstract `rawGet(key): Promise<unknown>` and runs every hit through the schema (`safeParse`-style, non-throwing). A stored value that fails to parse is reported as a **miss**, so a poisoned, truncated, or old-package-version entry can never reach a consumer as a typed hit. `set` / `delete` remain abstract.
  - `inMemoryCache(options?)` is now `inMemoryCache(schema, options?)`.
  - New export `zA1OnChainData` (from `./checks` and the root) — the zod schema for `A1OnChainData`, ready to pass to a cache constructor: `inMemoryCache(zA1OnChainData, { … })`.
  - New type export `StandardSchemaV1` (from `./cache` and the root) for implementers typing their own adapters.

  Migration: replace `inMemoryCache<T>(options)` with `inMemoryCache(schema, options)`, and convert hand-rolled `AsyncCache` object literals into subclasses providing `rawGet`/`set`/`delete`.

  `@3flabs/guardian`: documentation-only sync (the `Eip712DomainCache` structural interface is unchanged and remains satisfied by `AsyncCache` instances).

## 0.3.1

### Patch Changes

- e55c8b1: Fix the OpenAPI document so request bodies, 200 responses, and bearer
  authentication actually render.

  Before this change `@elysiajs/openapi` saw zod schemas attached via
  `body` / `response` and silently emitted nothing for them — request
  bodies appeared as empty `content: {}` and 200 responses as `{}` —
  because the plugin requires an explicit `mapJsonSchema` mapper for any
  non-typebox vendor and because its body-content loop only renders
  `application/json` content for parsers whose `fn` is a string (a plain
  function-typed `onParse` hook, like the one our raw-body capture
  plugin registers globally, makes the loop emit empty content).

  Concretely:

  - Pass `mapJsonSchema: { zod: z.toJSONSchema }` with `io: "input"` and
    `unrepresentable: "any"`. `io: "input"` documents the wire format
    (`zAddress`'s `regex(...).transform(...)` becomes `{ type: "string",
pattern: "^0x[0-9a-fA-F]{40}$" }` instead of collapsing to `{}`);
    `unrepresentable: "any"` keeps unrepresentable shapes from throwing
    and replaces them with `{}` instead of erasing the whole schema
    (without it, the entire `/version` response renders as `{}`).
  - Add `parse: "json"` to each `POST` route. Documentation-only — the
    global raw-body plugin still parses the body — but it gives the
    openapi plugin's body loop a string-typed parser entry to match,
    which is the only way it will emit `requestBody.content[
"application/json"]`.
  - Declare a `bearerAuth` security scheme (`type: "http", scheme:
"bearer"`) at the document level and require it globally; `/health`
    and `/version` opt out per-route with `security: []`. Tools like
    Scalar / Swagger UI can now render a working "Authorize" widget that
    injects `Authorization: Bearer <token>` on `/v1/*` requests.
  - Replace the per-status `zErrorEnvelope` repetitions with a
    `pickErrorResponses` helper backed by an `errorResponses` map whose
    entries each carry a status-specific `description` ("`forbidden` —
    The authenticated token lacks the endpoint scope required for this
    route." instead of the generic "Error envelope (§6.5)." inherited
    from the base schema). The 503 response on `/health` now describes
    itself as `upstream_unavailable` rather than going undocumented.

  The `@3flabs/guardian-defaults` bump is a sync release with the
  `@3flabs/guardian` patch — there are no source changes in defaults.

## 0.3.0

### Minor Changes

- 6e108e2: Add EIP-712 typed-data builders and sign-runner orchestrators for the
  four v1 signing surfaces. New exports:

  - `build{IntentRequestBinding,IntentFundBinding,IntentSwap,Whitelist,Unwhitelist}TypedData` — pure builders that take `{ domain, body }` (and `validator` for §A.4) and return `{ typedData, payloadHash }`. Typehashes mirror the on-chain verifiers in grunt and the request-whitelist repo (cross-checked in `tests/typed-data/typehashes.test.ts`). `canonicaliseSwapLegs` sorts swap legs by intent id (asset as tie-break) so `[A, B]` and `[B, A]` produce identical signatures.
  - `makeSign{IntentRequestBinding,IntentFundBinding,IntentSwap,RequestWhitelisting}` — orchestrators that compose a host check runner with `eip712Domain()` resolution (ERC-5267) + `ctx.signTypedData` + the §6.4 SigningSuccess assembly. Returned values drop directly into `GuardianAbstractions`.
  - `fetchEip712DomainNameVersion` — RPC fetch for `name`/`version` with an optional `Eip712DomainCache` (structurally compatible with `AsyncCache<{ name; version }>` from `@3flabs/guardian-defaults/cache`), so the per-contract domain read is amortised across signing calls.

### Patch Changes

- 6e108e2: Add an on-chain integration suite for the four `makeSign*` orchestrators.
  Each vitest worker boots an isolated [prool](https://github.com/wevm/prool)-managed
  anvil (path-routed at `/<workerId>`), deploys the Guardian-relevant slice
  of the 3F protocol from the new private `@3flabs/guardian-test-fixtures`
  workspace package, and exercises every orchestrator against the live
  contracts. The `makeSignIntentRequestBinding` case additionally submits
  the produced signature on-chain via `Facility.setRequest(…)` from a
  facilitator-roled account and asserts the receipt is `success` —
  proving the off-chain digest is accepted by the verifying contract.

  A separate suite covers `fetchEip712DomainNameVersion`: it reads
  `{ name: "3F", version: "1" }` from the deployed Facility,
  `{ name: "3fRequestWhitelist", version: "1" }` from the RequestWhitelist
  proxy, and verifies cache amortisation across signing calls.

  Run via `bun run test:integration` from the repo root. Requires
  `anvil` on `PATH`. The fixtures package is `"private": true` and not
  published.

  No public API changes.

## 0.2.1

### Patch Changes

- 3e22a1b: Documentation: rewrite the package READMEs so the `@3flabs/guardian` quick-start, the
  `GuardianAbstractions` reference, and the `@3flabs/guardian-defaults` Checks / Cache /
  ABIs sections all match the actual exported surface. The previous defaults README
  documented adapter-port types (`SwapPriceOracle`, `RequestContractReader`,
  `FundContractReader`, `WhitelistBookReader`) and an `acceptedSwapPair` helper that
  were never exported; replaced with the real `IntentSwapPolicy` /
  `IntentRequestBindingPolicy` / `IntentFundBindingPolicy` / `RequestWhitelistingPolicy`
  shapes and the optional `AsyncCache<A1OnChainData>` integration. No code changes.
- f25af49: Fix workspeace version dependency rewrite

## 0.2.0

### Minor Changes

- f89a6b4: Initial monorepo release.

  `@3flabs/guardian` is the existing HTTP shell, repackaged from `3f-guardian`
  under the `@3flabs` scope. New: optional `Logger` field on
  `GuardianAbstractions`, plumbed onto `SigningContext` (`ctx.logger`) with
  per-request `{ requestId, tokenId, chainId }` bindings.

  `@3flabs/guardian-defaults` is a new companion package providing:

  - `pinoLogger()` — pino + pino-pretty backed `Logger` ready to slot into
    `GuardianAbstractions.logger`.
  - `inMemoryRateLimiter()` — single-process fixed-window rate limiter that
    plugs straight into `accountRateLimit`. Pluggable `RateLimitStore` for
    Redis / Durable Object backends.
  - Appendix-A check-runner builders for `intent-request-binding`,
    `intent-fund-binding`, `intent-swap`, and `request-whitelisting`. Each
    accepts a small adapter port for protocol-specific contract reads, so
    the library stays ABI-agnostic.

### Patch Changes

- f89a6b4: Add basic checks for all signatures
