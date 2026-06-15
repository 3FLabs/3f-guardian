# @3flabs/guardian-coordinator

Lite coordinator for polling grunt-api signing requests, signing them in-process,
and submitting the signatures back to grunt-api.

From this repo:

```sh
bun run --cwd packages/guardian-coordinator start
```

From an installed package:

```sh
guardian-coordinator
```

Required env:

- `COORDINATOR_BASE_URL`
- `COORDINATOR_API_KEY`
- `GUARDIAN_SIGNER_KEY`
- `GUARDIAN_CHAIN_RPC_URLS` as `chainId=url,chainId=url`
- `GUARDIAN_REQUEST_FACTORIES` as `chainId=addr,addr;chainId=addr`
- `GUARDIAN_REQUEST_OWNERS`
- `GUARDIAN_REQUEST_PULLERS`
- `GUARDIAN_REQUEST_CONSUMERS`
- `GUARDIAN_ACCEPTED_FUNDS`
- `GUARDIAN_FUND_OWNERS`
- `GUARDIAN_PM_FACTORIES`
- `GUARDIAN_PM_OWNERS`

Optional env:

- `POLL_INTERVAL_MS` default `5000`
- `PAGE_SIZE` default `100`
- `CHAIN_IDS` comma-separated coordinator filter
- `FACILITIES` comma-separated coordinator filter
- `GUARDIAN_MAX_DEADLINE_SECONDS_AHEAD` default `600`
- `GUARDIAN_EVENT_SCAN_BLOCK_RANGE` default `10000`
- `GUARDIAN_EVENT_SCAN_MAX_LOOKBACK_BLOCKS` default `1000000`
- `GUARDIAN_SWAP_PRICE_TOLERANCE_BPS` default `1`

Programmatic use is still available:

```ts
import {
  loadCoordinatorConfig,
  runGuardianCoordinator,
} from "@3flabs/guardian-coordinator";
import { buildGuardianFromEnv } from "@3flabs/guardian-coordinator/cli";

await runGuardianCoordinator({
  ...loadCoordinatorConfig(process.env),
  guardian: buildGuardianFromEnv(process.env),
});
```
