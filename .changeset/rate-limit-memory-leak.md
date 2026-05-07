---
"@3flabs/guardian-defaults": patch
---

Fix unbounded growth in `inMemoryRateLimitStore`. The previous
implementation's docstring promised lazy eviction of expired windows
but the code never deleted anything, so each unique `tokenId` leaked
a Map entry forever. The store now drops entries lazily on `read`
when their window has closed and opportunistically sweeps expired
entries every ~256 writes; the limiter shares its injected `now`
clock with the default store so test/host time controls both
read-eviction and write-sweep consistently.
