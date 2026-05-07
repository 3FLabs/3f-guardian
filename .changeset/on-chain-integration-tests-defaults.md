---
"@3flabs/guardian-defaults": patch
---

Add an on-chain integration suite for the four Appendix-A check runners
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
