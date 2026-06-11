---
"@3flabs/guardian": minor
"@3flabs/guardian-defaults": minor
---

Repo-wide hardening pass: resilience, correctness, and spec-conformance fixes across the HTTP shell and the default check runners.

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
