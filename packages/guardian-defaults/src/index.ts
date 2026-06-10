/**
 * Default building blocks for `@3flabs/guardian` hosts.
 *
 *  - `pinoLogger`               — pino + pino-pretty backed structured logger.
 *  - `inMemoryRateLimiter`      — single-process fixed-window rate limiter
 *                                 ready to plug into `accountRateLimit`.
 *  - `build*Checks`             — Appendix A check-runner builders that
 *                                 evaluate the policy + on-chain checks
 *                                 listed in the v1 specification.
 *
 * Each subsystem is also reachable via a dedicated subpath export so
 * tree-shaking remains effective (`./logger`, `./rate-limit`, `./checks`).
 */

export { DEFAULT_REDACT_PATHS, pinoLogger, type PinoLoggerOptions } from "./logger/pino.js";

export { inMemoryRateLimiter, type RateLimiterOptions } from "./rate-limit/in-memory.js";
export {
  inMemoryRateLimitStore,
  type RateLimitDecision,
  type RateLimitState,
  type RateLimitStore,
} from "./rate-limit/store.js";

export { type AsyncCache } from "./cache/types.js";
export {
  DEFAULT_MAX_ENTRIES,
  inMemoryCache,
  type InMemoryCacheOptions,
} from "./cache/in-memory.js";

export {
  buildIntentFundBindingChecks,
  buildIntentRequestBindingChecks,
  buildIntentSwapChecks,
  buildRequestWhitelistingChecks,
  DEFAULT_MAX_REQUEST_CONTRACTS,
  checkDeadline,
  checkMembership,
  checkNonceWindow,
  checkSwapPriceTolerance,
  failed,
  passed,
  rollUp,
  skipped,
  type A1Deps,
  type A1OnChainData,
  type CheckRunner,
  type CheckRunnerError,
  type IntentFundBindingPolicy,
  type IntentRequestBindingPolicy,
  type IntentSwapPolicy,
  type RequestWhitelistingPolicy,
} from "./checks/index.js";

export {
  facilityAbi,
  fundAbi,
  positionManagerAbi,
  positionManagerFactoryAbi,
  requestAbi,
  requestFactoryAbi,
  whitelistBookAbi,
  ORDER_STATE,
  ORDER_STATE_NAME,
  DEPOSITOR_ROLE,
  ROLE_PULLER,
  ROLE_CONSUMER,
  VIRTUAL_ASSETS,
  type OrderState,
} from "./abi/index.js";
