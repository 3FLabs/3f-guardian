/**
 * EIP-712 typed-data builders + sign-runner orchestrators.
 *
 * Each of the four signing surfaces ships:
 *
 *  - A `build*TypedData` function — pure, takes `{ domain, body }` (and
 *    `validator` for §A.4) and returns `{ typedData, payloadHash }`.
 *    Useful for test fixtures and bespoke signers that don't want the
 *    full orchestrator.
 *  - A `makeSign*` factory — wires a check runner + the typed-data
 *    builder + `ctx.signTypedData` + the §6.4 response shape into a
 *    ready-to-use `SignIntent…` / `SignRequestWhitelisting` callable
 *    that drops directly into `GuardianAbstractions`.
 *
 * Domain values (`name`, `version`) are read from each verifying
 * contract via ERC-5267 `eip712Domain()` and cached if the host
 * supplies an `Eip712DomainCache` (the defaults package's
 * `inMemoryCache`, constructed with a `{ name, version }` schema, is
 * structurally compatible).
 */

export type { Eip712Domain, GuardianTypedData } from "./types.js";

export {
  buildIntentRequestBindingTypedData,
  setRequestParamsTypes,
} from "./intent-request-binding.js";
export { buildIntentFundBindingTypedData, setFundParamsTypes } from "./intent-fund-binding.js";
export { buildIntentSwapTypedData, canonicaliseSwapLegs, swapParamsTypes } from "./intent-swap.js";
export {
  buildRequestWhitelistingTypedData,
  buildUnwhitelistRequestTypedData,
  buildWhitelistRequestTypedData,
  unwhitelistRequestTypes,
  whitelistRequestTypes,
  type UnwhitelistRequestTypedData,
  type WhitelistRequestTypedData,
} from "./request-whitelisting.js";

export {
  makeSignIntentFundBinding,
  makeSignIntentRequestBinding,
  makeSignIntentSwap,
  makeSignRequestWhitelisting,
  type Eip712DomainCacheDeps,
} from "./sign-runners.js";
