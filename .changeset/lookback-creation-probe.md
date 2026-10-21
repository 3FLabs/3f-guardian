---
"@3flabs/guardian-defaults": patch
---

Under `onLookbackExhausted: "fail"`, §A.1 (and §A.4 per request contract) reads `eth_getCode` for the request contract at the block just before the lookback window. Code there means the contract predates the window, so it is rejected straight away instead of after a full role-events scan. The read needs an archive RPC; if it fails, the scan runs as before. `"skip"` is unchanged.
