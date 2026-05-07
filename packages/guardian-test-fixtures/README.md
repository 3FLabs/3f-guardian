# @3flabs/guardian-test-fixtures

**Internal, never published.** `private: true`. Provides the on-chain fixtures the integration tests in `@3flabs/guardian` and `@3flabs/guardian-defaults` consume.

## What it does

- Boots a [prool](https://github.com/wevm/prool)-managed anvil pool. Each vitest worker gets its own anvil instance, multiplexed by the worker id (`process.env.VITEST_POOL_ID`) under the path `http://127.0.0.1:<port>/<workerId>`.
- Deploys the Guardian-relevant slice of the 3F protocol (Facility, IntentDescriptor, TransferGuard, PositionManagerFactory + a real PositionManager, RequestFactory + a real Request, RequestWhitelist via fresh ERC-1967 proxy, an `OwnableMockFund` standing in for §A.2's fund). Mirrors `grunt/test/facility/FacilityBase.t.sol` minus the Morpho borrow market.
- Hands tests a typed `AddressBook` plus pre-built viem `publicClient` / `walletClient` / `testClient`.

## Foundry artifacts

Bundled under `artifacts/` as stamped JSONs `{ name, abi, bytecode, deployedBytecode, sourceRepo, sourcePath, sourceCommitHash }`. The extraction script reads them from sibling `out/` trees and writes them here.

Regenerate when the sibling repos change:

```bash
# from repo root
bun run scripts/extract-contract-fixtures.ts
```

CI fail-fast on drift:

```bash
bun run scripts/extract-contract-fixtures.ts --check
```

`OwnableMockFund` is the only contract whose source lives in this repo (`contracts/OwnableMockFund.sol`); the extraction script invokes `forge build` for it automatically when no compiled artifact is present.

## Why MockFund isn't reused

The grunt `MockFund` (`test/mock/facility/MockFund.sol`) doesn't expose `Ownable.owner()`, which the §A.2 `intent-fund-binding` check reads. Spinning up a real `ParetoFund` would require a `WrappedAsset` proxy + `MockIdleCDOEpochVariant` + `MockIdleCreditVault` — too much yak-shaving for a domain-binding test. `OwnableMockFund` is the smallest contract that covers the surface the Guardian reads.

## Licensing

`grunt` is BUSL-1.1; `3f-request-whitelist` is MIT. The bytecode bundled in `artifacts/` is derived from those repos. This package is `private: true` and never published, so no redistribution occurs through npm. If you remove the `private` flag in the future, audit the artifacts' source licenses first.

## API

```ts
import {
  startAnvilPool,
  createClients,
  deployGuardianStack,
  createIntegrationFixture,
  testAccounts,
} from "@3flabs/guardian-test-fixtures";
```

The `globalSetup` lives at `./src/global-setup.ts`; reference it from each consumer package's `vitest.integration.config.ts`.
