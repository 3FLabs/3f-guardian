---
"@3flabs/guardian-defaults": patch
"@3flabs/guardian-coordinator": patch
---

Allow a per-chain absolute role-history start so mature request contracts can retain complete factory provenance and role replay beyond the rolling lookback. The coordinator accepts `GUARDIAN_EVENT_SCAN_FROM_BLOCK=chainId=block`; unconfigured chains retain their existing behavior, and missing history remains fail closed by default.
