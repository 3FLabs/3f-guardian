---
"@3flabs/guardian": patch
"@3flabs/guardian-defaults": patch
---

Add on-chain integration suites for both packages. Each vitest worker boots an
isolated [prool](https://github.com/wevm/prool)-managed anvil (path-routed at
`/<workerId>`), deploys the Guardian-relevant slice of the 3F protocol (Facility
behind a minimal proxy, RequestFactory + a real factory-minted Request,
PositionManagerFactory + a real PositionManager, RequestWhitelist behind a fresh
ERC-1967 proxy, TransferGuard, IntentDescriptor, two MockERC20s, an
`OwnableMockFund`, plus Multicall3 at the canonical address), wires the relevant
roles, and exercises both:

- the four `@3flabs/guardian-defaults` Appendix-A check runners (§A.1–§A.4)
  against the deployed contracts; and
- the four `@3flabs/guardian` `makeSign*` orchestrators — including an on-chain
  `Facility.setRequest(…)` submission from a facilitator-roled account that
  asserts the signature is accepted by the contract.

Run via `bun run test:integration` from the repo root. Requires `anvil` on
`PATH`. The shared deployment + per-worker pool live in a new private
(`"private": true`) `@3flabs/guardian-test-fixtures` workspace package and are
not published.

No public API changes.
