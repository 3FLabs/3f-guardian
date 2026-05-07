# @3flabs/guardian-defaults

## 0.2.2

### Patch Changes

- 6e108e2: Fix `checkNonceWindow` to match `QuorumSigLib.assertSigValid` semantics
  on-chain: `nonce < floor` is rejected, but `nonce == floor` is now
  accepted (previously the off-chain check enforced strict `>`, which
  would reject one nonce the contract accepts).
- 6e108e2: Add an on-chain integration suite for the four Appendix-A check runners
  (§A.1–§A.4). Each vitest worker boots an isolated
  [prool](https://github.com/wevm/prool)-managed anvil and deploys the
  Guardian-relevant slice of the 3F protocol from the new private
  `@3flabs/guardian-test-fixtures` workspace package: Facility behind a
  minimal proxy, RequestFactory + a real factory-minted Request,
  PositionManagerFactory + a real PositionManager, RequestWhitelist behind
  a fresh ERC-1967 proxy, TransferGuard, IntentDescriptor, two MockERC20s,
  an `OwnableMockFund`, plus Multicall3 at the canonical address. Roles
  are wired and each builder's runner is exercised against the deployed
  contracts:

  - `intent-request-binding.integration.test.ts` — happy path, rogue
    contract (Facility passed where a Request is expected), bad puller list.
  - `intent-fund-binding.integration.test.ts` — happy path, rotated-owner
    via `OwnableMockFund.setOwner(…)` mid-test.
  - `intent-swap.integration.test.ts` — one PM leg + one debt leg priced
    at the empty-PM share price, neither-leg-PM, bad PM owner.
  - `request-whitelisting.integration.test.ts` — whitelist op at
    `nonce == floor == 0`, unwhitelist op (skips per-contract §A.1),
    nonce-window violation.

  Plus an end-to-end suite (`e2e-sign-runners.integration.test.ts`) that
  composes each defaults check runner with the corresponding `makeSign*`
  orchestrator from `@3flabs/guardian` and broadcasts the resulting
  signature on-chain (`Facility.setRequest` / `setFund` / `swap`,
  `RequestWhitelist.{whitelist,unwhitelist}BySig`). Failure paths cover
  `NotGuardian`, `DeadlineExpired` / `SwapExpired`, `QuorumNotMet`,
  `DuplicateSignature`, and `NonceConsumed`.

  Run via `bun run test:integration`. Requires `anvil` on `PATH`. The
  fixtures package is `"private": true` and not published.

  No public API changes.

- 6e108e2: Fix unbounded growth in `inMemoryRateLimitStore`. The previous
  implementation's docstring promised lazy eviction of expired windows
  but the code never deleted anything, so each unique `tokenId` leaked
  a Map entry forever. The store now drops entries lazily on `read`
  when their window has closed and opportunistically sweeps expired
  entries every ~256 writes; the limiter shares its injected `now`
  clock with the default store so test/host time controls both
  read-eviction and write-sweep consistently.
- Updated dependencies [6e108e2]
- Updated dependencies [6e108e2]
  - @3flabs/guardian@0.3.0

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
