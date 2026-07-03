# @3flabs/guardian-coordinator

## 0.2.1

### Patch Changes

- 4d92363: Add native AWS and GCP KMS signer providers and harden remote signer validation.
- 66a5d1b: Add coordinator support for `request_whitelisting` signing requests.

## 0.2.0

### Minor Changes

- 9b4543c: Add a lite guardian coordinator package for polling grunt-api signing requests, signing them through a local guardian signer, and submitting the resulting signature.

### Patch Changes

- Updated dependencies [9b4543c]
  - @3flabs/guardian@0.5.0
  - @3flabs/guardian-defaults@0.3.1
