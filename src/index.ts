/**
 * Public entry point. Re-exports the build-server function and the
 * abstractions contract so callers can:
 *
 *   import { buildGuardianServer, type GuardianAbstractions } from "bun-guardian";
 *
 *   const abs: GuardianAbstractions = makeMyAbstractions();
 *   buildGuardianServer(abs).listen(3000);
 *
 * No abstraction is implemented here. This package is the HTTP shell.
 */
export { buildGuardianServer, type GuardianServer } from "./server.ts";
export type {
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
} from "./abstractions.ts";
export { ENDPOINT_SCOPES } from "./abstractions.ts";

// Tagged error classes — implementers construct these inside their
// abstraction implementations to drive HTTP status mapping.
export {
  BadRequestError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  StateConflictError,
  UnauthenticatedError,
  UnsupportedChainError,
  UnsupportedMediaTypeError,
  UpstreamUnavailableError,
  ValidationFailedError,
  type GuardianError,
  type SigningError,
} from "./errors/tagged.ts";

// Schema types & values — exposed so implementers can reuse them when
// validating their own dependencies (e.g., the response shape of an
// off-chain DB) and so test code can build typed fixtures.
export {
  zSigningSuccess,
  zErrorEnvelope,
  type SigningSuccess,
  type ErrorEnvelope,
  type ErrorCode,
} from "./schemas/responses.ts";
export { type CheckEntry, zCheckEntry, zChecks } from "./schemas/checks.ts";
export {
  type IntentRequestBindingBody,
  zIntentRequestBindingBody,
} from "./schemas/intent-request-binding.ts";
export {
  type IntentFundBindingBody,
  zIntentFundBindingBody,
} from "./schemas/intent-fund-binding.ts";
export {
  type IntentSwapBody,
  type SwapLeg,
  zIntentSwapBody,
  zSwapLeg,
} from "./schemas/intent-swap.ts";
export {
  type RequestWhitelistingBody,
  type RequestWhitelistingResponse,
  type WhitelistOperation,
  zRequestWhitelistingBody,
  zRequestWhitelistingResponse,
  zWhitelistOperation,
} from "./schemas/request-whitelisting.ts";
export { type HealthResponse, zHealthResponse } from "./schemas/health.ts";
export { type VersionResponse, zVersionResponse } from "./schemas/version.ts";

// Helpers for implementers building check arrays.
export { failed, passed, skipped } from "./lib/checks.ts";

// Convenience SignTypedData implementations. KMS- / HSM-backed signers
// belong to the host; this is the dev/test private-key envelope.
export { privateKeyToSignTypedData } from "./signers/private-key.ts";
