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

export { pinoLogger, type PinoLoggerOptions } from "./logger/pino.js";

export { inMemoryRateLimiter, type RateLimiterOptions } from "./rate-limit/in-memory.js";
export {
  inMemoryRateLimitStore,
  type RateLimitState,
  type RateLimitStore,
} from "./rate-limit/store.js";

export {
  acceptedSwapPair,
  buildIntentFundBindingChecks,
  buildIntentRequestBindingChecks,
  buildIntentSwapChecks,
  buildRequestWhitelistingChecks,
  checkDeadline,
  checkMembership,
  checkNonceWindow,
  checkSwapPriceTolerance,
  failed,
  passed,
  rollUp,
  skipped,
  type CheckRunner,
  type CheckRunnerError,
  type IntentFundBindingPolicy,
  type IntentRequestBindingPolicy,
  type IntentSwapPolicy,
  type RequestContractReader,
  type RequestWhitelistingPolicy,
  type SwapPriceOracle,
  type WhitelistBookReader,
} from "./checks/index.js";

export {
  facilityAbi,
  fundAbi,
  ORDER_STATE,
  ORDER_STATE_NAME,
  DEPOSITOR_ROLE,
  type OrderState,
} from "./abi/index.js";
