# @3flabs/guardian-test-fixtures

## 0.0.1

### Patch Changes

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
