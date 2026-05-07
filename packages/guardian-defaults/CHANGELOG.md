# @3flabs/guardian-defaults

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
- Updated dependencies [3e22a1b]
- Updated dependencies [f25af49]
  - @3flabs/guardian@0.2.1

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
- Updated dependencies [f89a6b4]
- Updated dependencies [f89a6b4]
  - @3flabs/guardian@0.2.0
