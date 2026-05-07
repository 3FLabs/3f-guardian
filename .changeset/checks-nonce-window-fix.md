---
"@3flabs/guardian-defaults": patch
---

Fix `checkNonceWindow` to match `QuorumSigLib.assertSigValid` semantics
on-chain: `nonce < floor` is rejected, but `nonce == floor` is now
accepted (previously the off-chain check enforced strict `>`, which
would reject one nonce the contract accepts).
