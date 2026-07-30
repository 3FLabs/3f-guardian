---
"@3flabs/guardian-defaults": patch
"@3flabs/guardian-coordinator": patch
---

Add an opt-in `trustedRequestContracts` policy set (`GUARDIAN_TRUSTED_REQUEST_CONTRACTS`) that skips the §A.1 factory, owner, and role checks for pre-vetted request contracts, and make the coordinator's validate-and-sign budget configurable with `GUARDIAN_SIGN_TIMEOUT_MS`.
