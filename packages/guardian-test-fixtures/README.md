# @3flabs/guardian-test-fixtures

**Internal, never published.** `private: true` — the publish pipeline both refuses to publish it and strips it from the public packages' manifests (it appears only as a workspace devDependency). It provides the on-chain fixtures the integration tests in `@3flabs/guardian` and `@3flabs/guardian-defaults` consume: each consumer's `vitest.integration.config.ts` registers `./src/global-setup.ts` as vitest `globalSetup` (which boots the anvil pool and publishes the deployed addresses via `provide()`), and individual tests call `createIntegrationFixture()` to get clients + the deployed `AddressBook`.

## What it does

- Boots a [prool](https://github.com/wevm/prool)-managed anvil pool, bound to `127.0.0.1` only. Each vitest worker gets its own anvil instance, multiplexed by the worker id (`process.env.VITEST_POOL_ID`) under the path `http://127.0.0.1:<port>/<workerId>`. `startAnvilPool` accepts optional `port` and `limit` options (`limit` defaults to 64 and caps how many anvil instances the pool will spawn); a fixed-port `EADDRINUSE` surfaces as a catchable promise rejection.
- Deploys the Guardian-relevant slice of the 3F protocol (Facility, IntentDescriptor, TransferGuard, PositionManagerFactory + a real PositionManager, RequestFactory + a real Request, RequestWhitelist via fresh ERC-1967 proxy, an `OwnableMockFund` standing in for §A.2's fund). Mirrors `grunt/test/facility/FacilityBase.t.sol` minus the Morpho borrow market.
- Hands tests a typed `AddressBook` plus pre-built viem `publicClient` / `walletClient` / `testClient`.

## Foundry artifacts

Bundled under `artifacts/` as stamped JSONs `{ name, abi, bytecode, deployedBytecode, sourceRepo, sourcePath, sourceCommitHash }`. The extraction script reads them from sibling `out/` trees and writes them here. `sourceCommitHash` stamps gain a `-dirty` suffix (mirroring `git describe --dirty`) when the source repo has uncommitted changes, and the script warns when a source path is not a git repo.

Regenerate when the sibling repos change:

```bash
# from repo root
bun run fixtures:extract
```

Validate (runs in CI on every PR):

```bash
bun run fixtures:check
```

`fixtures:check` always validates the bundled artifacts' integrity (file exists, parses, carries abi/bytecode/deployedBytecode/sourceCommitHash, and `INDEX.json` matches the stamps byte-for-byte) and only performs the sibling-drift comparison for repos whose forge output is actually present — it prints a `[fixtures] NOTICE: skipped sibling-drift verification` line for each absent repo and exits 0 on a fresh clone or CI runner without sibling checkouts.

`OwnableMockFund` and the vendored `Multicall3` are the only contracts whose source lives in this repo (`contracts/`); `fixtures:extract` always runs `forge build` on that directory (foundry's incremental build is near-instant when nothing changed), so editing a local `.sol` cannot silently re-stamp stale bytecode — `forge` must be on `PATH`. For these `local` artifacts the recorded `sourceCommitHash` is the monorepo's own HEAD and is provenance metadata only: `fixtures:check` compares their abi/bytecode/deployedBytecode but does not gate on the hash.

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
