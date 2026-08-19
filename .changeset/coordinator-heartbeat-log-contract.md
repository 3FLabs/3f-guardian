---
"@3flabs/guardian-coordinator": patch
---

Emit a per-poll heartbeat line and `guardian.startup` / `guardian.fatal` lifecycle lines from the coordinator, bound grunt-api calls with a configurable request timeout (`REQUEST_TIMEOUT_MS`), and pin every guaranteed log line in `log-contract.json` so regex-based monitoring can rely on it.
