---
"@3flabs/guardian-defaults": minor
"@3flabs/guardian-coordinator": patch
---

Require a Morpho flash-loan request to hold a zero balance of its `asset()` when it is bound. Request contracts matched by an accepted flash-loan request factory now carry a "flash-loan request holds no balance of its asset" §A.1 check, backed by a live `asset()` + `balanceOf` read that runs on every call (cache hit or not) and is never cached; a failed read is `503`. §A.4 whitelist ops inherit it per request contract.
