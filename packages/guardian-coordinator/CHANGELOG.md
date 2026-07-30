# @3flabs/guardian-coordinator

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
