/**
 * Public entry point. Re-exports the build-server function and the
 * abstractions contract so callers can:
 *
 *   import { buildGuardianServer, type GuardianAbstractions } from "@3flabs/guardian";
 *
 *   const abs: GuardianAbstractions = makeMyAbstractions();
 *   buildGuardianServer(abs).listen(3000);
 *
 * No abstraction is implemented here. This package is the HTTP shell.
 * Default Logger / rate-limiter / Appendix-A check builders live in the
 * companion `@3flabs/guardian-defaults` package.
 */
export { buildGuardianServer, type GuardianServer } from "./server.js";
export type {
  AbstractionCallOptions,
  EndpointScope,
  GuardianAbstractions,
  GuardianMetadata,
  LivenessProbe,
  RateLimitWindow,
  SignTypedData,
  SignTypedDataError,
  SigningContext,
  SignIntentFundBinding,
  SignIntentRequestBinding,
  SignIntentSwap,
  SignRequestWhitelisting,
  TokenInfo,
  ValidateAndSign,
} from "./abstractions.js";
export { ENDPOINT_SCOPES } from "./abstractions.js";

// Per-call deadlines for host abstractions and the shell's body-size cap.
export { DEFAULT_GUARDIAN_TIMEOUTS, type GuardianTimeouts } from "./lib/deadline.js";
export { DEFAULT_MAX_BODY_BYTES } from "./plugins/raw-body.js";

// Tagged error classes — implementers construct these inside their
// abstraction implementations to drive HTTP status mapping.
export {
  BadRequestError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  StateConflictError,
  UnauthenticatedError,
  UnsupportedChainError,
  UnsupportedMediaTypeError,
  UpstreamUnavailableError,
  ValidationFailedError,
  type GuardianError,
  type SigningError,
} from "./errors/tagged.js";

// Schema types & values — exposed so implementers can reuse them when
// validating their own dependencies (e.g., the response shape of an
// off-chain DB) and so test code can build typed fixtures.
export {
  zSigningSuccess,
  zErrorEnvelope,
  type SigningSuccess,
  type ErrorEnvelope,
  type ErrorCode,
} from "./schemas/responses.js";
export { type CheckEntry, zCheckEntry, zChecks } from "./schemas/checks.js";
export {
  type IntentRequestBindingBody,
  zIntentRequestBindingBody,
} from "./schemas/intent-request-binding.js";
export {
  type IntentFundBindingBody,
  zIntentFundBindingBody,
} from "./schemas/intent-fund-binding.js";
export {
  type IntentSwapBody,
  type SwapLeg,
  zIntentSwapBody,
  zSwapLeg,
} from "./schemas/intent-swap.js";
export {
  type RequestWhitelistingBody,
  type RequestWhitelistingResponse,
  type WhitelistOperation,
  zRequestWhitelistingBody,
  zRequestWhitelistingResponse,
  zWhitelistOperation,
} from "./schemas/request-whitelisting.js";
export { type HealthResponse, zHealthResponse } from "./schemas/health.js";
export { type VersionResponse, zVersionResponse } from "./schemas/version.js";

// Helpers for implementers building check arrays.
export { failed, passed, skipped } from "./lib/checks.js";
export { runSigning, type SigningAbstractions } from "./lib/signing.js";

// Logger contract + noop fallback. Implementers can pass a real pino
// instance directly (it is structurally assignable to `Logger`), or use
// `pinoLogger()` from `@3flabs/guardian-defaults`.
export { type Logger, type LogFn, noopLogger } from "./lib/logger.js";

// Convenience SignTypedData implementations. KMS- / HSM-backed signers
// belong to the host; this is the dev/test private-key envelope.
export { privateKeyToSignTypedData } from "./signers/private-key.js";

// EIP-712 typed-data builders + sign-runner orchestrators. The four
// `build*TypedData` helpers produce `{ typedData, payloadHash }` for the
// four signing surfaces against typehashes mirroring the on-chain
// verifiers; the four `makeSign*` factories wire those builders to a
// host-supplied check runner and `ctx.signTypedData`, returning a
// drop-in `SignIntent…` / `SignRequestWhitelisting` callable.
export {
  buildIntentFundBindingTypedData,
  buildIntentRequestBindingTypedData,
  buildIntentSwapTypedData,
  buildRequestWhitelistingTypedData,
  buildUnwhitelistRequestTypedData,
  buildWhitelistRequestTypedData,
  canonicaliseSwapLegs,
  makeSignIntentFundBinding,
  makeSignIntentRequestBinding,
  makeSignIntentSwap,
  makeSignRequestWhitelisting,
  setFundParamsTypes,
  setRequestParamsTypes,
  swapParamsTypes,
  unwhitelistRequestTypes,
  whitelistRequestTypes,
  type Eip712Domain,
  type Eip712DomainCacheDeps,
  type GuardianTypedData,
  type UnwhitelistRequestTypedData,
  type WhitelistRequestTypedData,
} from "./typed-data/index.js";

// ERC-5267 domain fetcher with optional caching. Useful when a host
// composes a custom `signIntent…` and wants to share the domain cache
// with the four bundled `makeSign*` runners.
export {
  eip712DomainCacheKey,
  fetchEip712DomainNameVersion,
  type Eip712DomainCache,
  type Eip712DomainNameVersion,
} from "./lib/eip712-domain.js";
