---
"@3flabs/guardian-coordinator": minor
---

Fail closed on the §A.1 lookback: `GUARDIAN_ON_LOOKBACK_EXHAUSTED` (`fail` or `skip`) now defaults to `fail` when unset, so a request contract deployed before the role-events lookback window is rejected instead of signed with its role checks skipped. **Upgrading changes any deployment that leaves the variable unset** (Ethereum mainnet included): set `GUARDIAN_ON_LOOKBACK_EXHAUSTED` explicitly (`skip` keeps the old behaviour) before rolling the new image. Unknown values still stop startup. A signing request whose validate-and-sign hits `GUARDIAN_SIGN_TIMEOUT_MS` is retried once on the next poll; after a second timeout the process gives up on it so it cannot hold up the requests behind it. Also documents the per-chain settings for running one coordinator process per chain.
