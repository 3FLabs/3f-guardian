---
"@3flabs/guardian": minor
"@3flabs/guardian-defaults": patch
---

Add EIP-712 typed-data builders and sign-runner orchestrators for the four
v1 signing surfaces.

`@3flabs/guardian` now exports:

- `build{IntentRequestBinding,IntentFundBinding,IntentSwap,Whitelist,Unwhitelist}TypedData` — pure builders that take `{ domain, body }` (and `validator` for §A.4) and return `{ typedData, payloadHash }`. Typehashes mirror the on-chain verifiers in grunt and the request-whitelist repo (cross-checked in `tests/typed-data/typehashes.test.ts`). `canonicaliseSwapLegs` sorts swap legs by intent id (asset as tie-break) so `[A, B]` and `[B, A]` produce identical signatures.
- `makeSign{IntentRequestBinding,IntentFundBinding,IntentSwap,RequestWhitelisting}` — orchestrators that compose a host check runner with `eip712Domain()` resolution (ERC-5267) + `ctx.signTypedData` + the §6.4 SigningSuccess assembly. Returned values drop directly into `GuardianAbstractions`.
- `fetchEip712DomainNameVersion` — RPC fetch for `name`/`version` with an optional `Eip712DomainCache` (structurally compatible with `AsyncCache<{ name; version }>` from `@3flabs/guardian-defaults/cache`), so the per-contract domain read is amortised across signing calls.

`@3flabs/guardian-defaults` `checkNonceWindow` is corrected to match the
on-chain `QuorumSigLib.assertSigValid` semantics: `nonce < floor` is
rejected, but `nonce == floor` is accepted (previously off-chain enforced
strict `>`, which would reject one nonce that the contract accepts).
