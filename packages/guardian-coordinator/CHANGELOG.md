# @3flabs/guardian-coordinator

## 0.3.0

### Minor Changes

- dabc2dd: Add an opt-in retargetter path to the §A.1 checks. When the request contract's `owner()` is on the new `acceptedRetargetters` policy set (`GUARDIAN_ACCEPTED_RETARGETTERS`), the factory, owner and puller / consumer role checks are skipped in favour of the retargetter's live `operation()`: the contract must be the retargetter's attached operation request and the operation's repayment deadline must be at least `minRetargetterRepaymentBufferSeconds` ahead (`GUARDIAN_MIN_RETARGETTER_REPAYMENT_BUFFER_SECONDS`, default 80 days — the contract's `MIN_DEADLINE_BUFFER`). §A.4 whitelist ops inherit it per request contract. Every other request contract keeps the classic path. Ships `retargetterAbi` and a `MockRetargetter` test fixture.

### Patch Changes

- 43db013: Release under the Changesets v3 pipeline. No runtime changes — this bump exercises the new split release workflow (`select-mode` → `version` / `pack` → `publish`) end to end.
- 51a06da: Emit a per-poll heartbeat line and `guardian.startup` / `guardian.fatal` lifecycle lines from the coordinator, bound grunt-api calls with a configurable request timeout (`REQUEST_TIMEOUT_MS`), and pin every guaranteed log line in `log-contract.json` so regex-based monitoring can rely on it.
- dabc2dd: Update runtime dependencies. `better-result` moves to 3.x: the exported error classes (`UnauthenticatedError`, `ValidationFailedError`, …) still extend its `TaggedError`, so hosts that call `isTaggedError` / `matchError` on Guardian errors with their own copy of `better-result` should be on 3.x too. Also picks up viem 2.56, zod 4.6, elysia 1.4.30, `@noble/hashes` 2.4, `@aws-sdk/client-kms` 3.1130, and `@google-cloud/kms` 6.1 (Node ≥ 22 only; the coordinator runs on Bun).
- Updated dependencies [43db013]
- Updated dependencies [dabc2dd]
- Updated dependencies [dabc2dd]
  - @3flabs/guardian@0.6.0
  - @3flabs/guardian-defaults@0.4.0

## 0.2.1

### Patch Changes

- 4d92363: Add native AWS and GCP KMS signer providers and harden remote signer validation.
- 66a5d1b: Add coordinator support for `request_whitelisting` signing requests.
- bc56220: Validate Morpho flash-loan request provenance and executor roles through their dedicated policy.
- fdf3bee: Add an opt-in `trustedRequestContracts` policy set (`GUARDIAN_TRUSTED_REQUEST_CONTRACTS`) that skips the §A.1 factory, owner, and role checks for pre-vetted request contracts, and make the coordinator's validate-and-sign budget configurable with `GUARDIAN_SIGN_TIMEOUT_MS`.
- Updated dependencies [bc56220]
- Updated dependencies [fdf3bee]
  - @3flabs/guardian-defaults@0.3.2

## 0.2.0

### Minor Changes

- 9b4543c: Add a lite guardian coordinator package for polling grunt-api signing requests, signing them through a local guardian signer, and submitting the resulting signature.

### Patch Changes

- Updated dependencies [9b4543c]
  - @3flabs/guardian@0.5.0
  - @3flabs/guardian-defaults@0.3.1
