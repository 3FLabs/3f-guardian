---
"@3flabs/guardian": minor
"@3flabs/guardian-defaults": minor
---

Initial monorepo release.

`@3flabs/guardian` is the existing HTTP shell, repackaged from `3f-guardian`
under the `@3flabs` scope. New: optional `Logger` field on
`GuardianAbstractions`, plumbed onto `SigningContext` (`ctx.logger`) with
per-request `{ requestId, tokenId, chainId }` bindings.

`@3flabs/guardian-defaults` is a new companion package providing:
  * `pinoLogger()` — pino + pino-pretty backed `Logger` ready to slot into
    `GuardianAbstractions.logger`.
  * `inMemoryRateLimiter()` — single-process fixed-window rate limiter that
    plugs straight into `accountRateLimit`. Pluggable `RateLimitStore` for
    Redis / Durable Object backends.
  * Appendix-A check-runner builders for `intent-request-binding`,
    `intent-fund-binding`, `intent-swap`, and `request-whitelisting`. Each
    accepts a small adapter port for protocol-specific contract reads, so
    the library stays ABI-agnostic.
