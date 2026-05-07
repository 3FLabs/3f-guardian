---
"@3flabs/guardian": patch
"@3flabs/guardian-defaults": patch
---

Documentation: rewrite the package READMEs so the `@3flabs/guardian` quick-start, the
`GuardianAbstractions` reference, and the `@3flabs/guardian-defaults` Checks / Cache /
ABIs sections all match the actual exported surface. The previous defaults README
documented adapter-port types (`SwapPriceOracle`, `RequestContractReader`,
`FundContractReader`, `WhitelistBookReader`) and an `acceptedSwapPair` helper that
were never exported; replaced with the real `IntentSwapPolicy` /
`IntentRequestBindingPolicy` / `IntentFundBindingPolicy` / `RequestWhitelistingPolicy`
shapes and the optional `AsyncCache<A1OnChainData>` integration. No code changes.
