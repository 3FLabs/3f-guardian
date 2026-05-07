# @3flabs/guardian

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
