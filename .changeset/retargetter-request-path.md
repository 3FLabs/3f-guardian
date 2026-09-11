---
"@3flabs/guardian-defaults": minor
"@3flabs/guardian-coordinator": minor
"@3flabs/guardian-test-fixtures": minor
---

Add an opt-in retargetter path to the §A.1 checks. When the request contract's `owner()` is on the new `acceptedRetargetters` policy set (`GUARDIAN_ACCEPTED_RETARGETTERS`), the factory, owner and puller / consumer role checks are skipped in favour of the retargetter's live `operation()`: the contract must be the retargetter's attached operation request and the operation's repayment deadline must be at least `minRetargetterRepaymentBufferSeconds` ahead (`GUARDIAN_MIN_RETARGETTER_REPAYMENT_BUFFER_SECONDS`, default 80 days — the contract's `MIN_DEADLINE_BUFFER`). §A.4 whitelist ops inherit it per request contract. Every other request contract keeps the classic path. Ships `retargetterAbi` and a `MockRetargetter` test fixture.
