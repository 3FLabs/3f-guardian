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

- `COORDINATOR_BASE_URL` (`https://`, or `http://localhost` for local dev)
- `COORDINATOR_API_KEY`
- `GUARDIAN_SIGNER_KEY` when `GUARDIAN_SIGNER_PROVIDER` is unset or `private_key`
- `GUARDIAN_SIGNER_ADDRESS` and `GUARDIAN_REMOTE_SIGNER_URL` when
  `GUARDIAN_SIGNER_PROVIDER=remote_http`. The remote signer URL must use
  `https://`, except localhost URLs may use `http://` for local development.
- `GUARDIAN_SIGNER_ADDRESS` and `GUARDIAN_AWS_KMS_KEY_ID` when
  `GUARDIAN_SIGNER_PROVIDER=aws_kms`
- `GUARDIAN_SIGNER_ADDRESS` and `GUARDIAN_GCP_KMS_KEY_VERSION` when
  `GUARDIAN_SIGNER_PROVIDER=gcp_kms`
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
- `CHAIN_IDS` comma-separated signing-request filter
- `FACILITIES` comma-separated signing-request filter
- `GUARDIAN_SIGNER_PROVIDER` default `private_key`; supported values are `private_key`,
  `remote_http`, `aws_kms`, and `gcp_kms`
- `GUARDIAN_REMOTE_SIGNER_BEARER_TOKEN` bearer token for `remote_http`
- `GUARDIAN_REMOTE_SIGNER_TIMEOUT_MS` default `6000`; request timeout for
  `remote_http`
- `AWS_REGION` or `AWS_DEFAULT_REGION` for `aws_kms` when the default AWS SDK chain
  cannot infer a region
- `GUARDIAN_MAX_DEADLINE_SECONDS_AHEAD` default `600`
- `GUARDIAN_EVENT_SCAN_BLOCK_RANGE` default `10000`
- `GUARDIAN_EVENT_SCAN_MAX_LOOKBACK_BLOCKS` default `1000000`
- `GUARDIAN_SWAP_PRICE_TOLERANCE_BPS` default `1`

For `remote_http`, the coordinator sends:

```json
{ "typedData": { "domain": {}, "types": {}, "primaryType": "...", "message": {} } }
```

The remote signer must return either `{ "signature": "0x..." }` or the signature
as a JSON string. The returned signature must recover to
`GUARDIAN_SIGNER_ADDRESS`; otherwise signing fails before submission.

For `aws_kms`, the KMS key must be an asymmetric `ECC_SECG_P256K1` key with
`SIGN_VERIFY` usage. The coordinator signs the EIP-712 digest with AWS KMS
`ECDSA_SHA_256` / `MessageType=DIGEST`.

For `gcp_kms`, the key version must use `EC_SIGN_SECP256K1_SHA256`.

For both KMS providers, the returned signature must recover to
`GUARDIAN_SIGNER_ADDRESS`; otherwise signing fails before submission.

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
