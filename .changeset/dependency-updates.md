---
"@3flabs/guardian": minor
"@3flabs/guardian-defaults": patch
"@3flabs/guardian-coordinator": patch
---

Update runtime dependencies. `better-result` moves to 3.x: the exported error classes (`UnauthenticatedError`, `ValidationFailedError`, …) still extend its `TaggedError`, so hosts that call `isTaggedError` / `matchError` on Guardian errors with their own copy of `better-result` should be on 3.x too. Also picks up viem 2.56, zod 4.6, elysia 1.4.30, `@noble/hashes` 2.4, `@aws-sdk/client-kms` 3.1130, and `@google-cloud/kms` 6.1 (Node ≥ 22 only; the coordinator runs on Bun).
