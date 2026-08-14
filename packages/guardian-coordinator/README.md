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
- `REQUEST_TIMEOUT_MS` default `10000`; per-request timeout for grunt-api calls. A hung
  request aborts and surfaces as a failed poll instead of freezing the loop.
- `CHAIN_IDS` comma-separated signing-request filter
- `FACILITIES` comma-separated signing-request filter (facility, or whitelist book for
  `request_whitelisting`)
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
- `GUARDIAN_MAX_NONCE_ABOVE_FLOOR` default `100`, for request-whitelisting nonce windows
- `GUARDIAN_FLASH_LOAN_REQUEST_FACTORIES` optional `chainId=addr,addr;chainId=addr`
- `GUARDIAN_FLASH_LOAN_REQUEST_EXECUTORS` optional `chainId=addr,addr;chainId=addr`
- `GUARDIAN_ACCEPTED_WHITELIST_BOOKS` optional `chainId=addr,addr;chainId=addr`
- `GUARDIAN_TRUSTED_REQUEST_CONTRACTS` optional `chainId=addr,addr;chainId=addr`.
  Request contracts on this list skip factory-provenance, owner, and puller / consumer /
  executor role verification for both `set_request` and `request_whitelisting`, with no
  on-chain read at all — only the deadline check still applies. Unset (the default)
  validates every request contract. The Guardian will sign for a listed contract
  whatever its owner and role holders turn out to be, including grants made after it was
  listed, so keep it to contracts whose configuration is under the same control as the
  Guardian's own key material. Every bypass is logged at warn level.
- `GUARDIAN_SIGN_TIMEOUT_MS` default `6000`; budget for one whole validate-and-sign
  call, including the on-chain reads. Raise it when role-events scans over a wide
  `GUARDIAN_EVENT_SCAN_MAX_LOOKBACK_BLOCKS` — or `request_whitelisting` batches, which
  scan per request contract — need longer than the default.
- `GUARDIAN_SWAP_PRICE_TOLERANCE_BPS` default `1`

## Lifecycle and heartbeat lines

The CLI emits three JSON lines of its own, shaped alike:

```json
{"level":"info","event":"guardian.startup","build":"1.2.3","chains":[1]}
{"level":"info","event":"guardian.heartbeat","ok":true,"fetched":0,"signed":0,"skipped":0,"failed":0,"durationMs":12}
{"level":"fatal","event":"guardian.fatal","err":"COORDINATOR_BASE_URL is required"}
```

- `guardian.startup` — stdout, once, after config and signer construction succeed.
  It means the config parsed and the signer was constructed — not that the signer or
  RPCs were exercised. The first heartbeat is the first proof of live work.
- `guardian.heartbeat` — stdout, one per poll cycle, including cycles whose poll
  failed (`ok: false`); its absence means the loop is dead or wedged. The gap between
  heartbeats is poll duration + `POLL_INTERVAL_MS`, not just the interval: a busy
  cycle (many requests × `GUARDIAN_SIGN_TIMEOUT_MS`, plus event scans) legitimately
  stretches it. Size any absence alert to the worst-case cycle duration, not to the
  poll interval, or a burst of signing work will page you for nothing.
- `guardian.fatal` — stderr, right before the process exits with code 1, whether the
  failure happened at boot (bad config) or later. Carries a `stack` field, appended
  after `err`, when the thrown value has one.

The serialized shapes are a monitoring contract pinned by tests in
`tests/coordinator.test.ts`; changing them breaks downstream alerting.

`log-contract.json` at the package root is the machine-readable version of this
contract: one regex per guaranteed line (the three lines above plus the
`submitted guardian signature for` / `guardian coordinator poll failed:` /
`failed guardian signing request` / `skipping malformed guardian signing request:`
prefixes). Monitoring should build its rules from that file.
`tests/log-contract.test.ts` verifies it in both directions — every pattern is
emitted by a real code path, and every emitted line matches a pattern — so
adding, removing, or rewording a log line without updating the contract fails CI.

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
