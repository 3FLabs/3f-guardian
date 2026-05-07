---
"@3flabs/guardian": patch
---

Add an on-chain integration suite for the four `makeSign*` orchestrators.
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
