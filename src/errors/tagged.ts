import { TaggedError, isTaggedError } from "better-result";
import type { CheckEntry } from "../schemas/checks.ts";

/**
 * Tags this module emits. Used by the global error handler to decide
 * whether a thrown value is one of ours.
 */
const GUARDIAN_TAGS = new Set<string>([
  "Unauthenticated",
  "Forbidden",
  "BadRequest",
  "UnsupportedMediaType",
  "UnsupportedChain",
  "NotFound",
  "StateConflict",
  "ValidationFailed",
  "RateLimited",
  "InternalError",
  "UpstreamUnavailable",
]);

/** Type guard for any GuardianError tag. */
export function isGuardianErrorTag(value: unknown): value is GuardianError {
  return (
    isTaggedError(value) &&
    typeof (value as { _tag?: unknown })._tag === "string" &&
    GUARDIAN_TAGS.has((value as { _tag: string })._tag)
  );
}

/**
 * Authentication failed. Maps to 401 unauthenticated.
 *
 * The §5.4.3 rule applies: missing header / stale timestamp / signature
 * mismatch / unknown bearer / revoked token all funnel here. The specific
 * cause is conveyed only by `message` and is informative.
 */
export class UnauthenticatedError extends TaggedError("Unauthenticated")<{
  message: string;
}>() {}

/** Token lacks scope. Maps to 403 forbidden. */
export class ForbiddenError extends TaggedError("Forbidden")<{
  message: string;
}>() {}

/** Malformed body or headers, or sentinel values rejected up-front. */
export class BadRequestError extends TaggedError("BadRequest")<{
  message: string;
  details?: Record<string, unknown>;
}>() {}

/** §6.1 — Content-Type other than application/json on a body-bearing request. */
export class UnsupportedMediaTypeError extends TaggedError("UnsupportedMediaType")<{
  message: string;
}>() {}

/** chainId not in supportedChains. Maps to 400 unsupported_chain. */
export class UnsupportedChainError extends TaggedError("UnsupportedChain")<{
  message: string;
  chainId: number;
}>() {}

/** Unknown route or unresolvable on-chain reference. Maps to 404. */
export class NotFoundError extends TaggedError("NotFound")<{
  message: string;
  details?: Record<string, unknown>;
}>() {}

/**
 * On-chain state incompatible in a transient way. Maps to 409.
 * Per §6.6.1 the set of checks that can yield 409 is fixed per endpoint
 * and listed in Appendix A.
 */
export class StateConflictError extends TaggedError("StateConflict")<{
  message: string;
  checks: CheckEntry[];
}>() {}

/** Policy check failed. Maps to 422 validation_failed. */
export class ValidationFailedError extends TaggedError("ValidationFailed")<{
  message: string;
  checks: CheckEntry[];
}>() {}

/** Maps to 429 rate_limited. */
export class RateLimitedError extends TaggedError("RateLimited")<{
  message: string;
  retryAfterSeconds: number;
}>() {}

/** Unexpected Guardian-side failure. Maps to 500. */
export class InternalError extends TaggedError("InternalError")<{
  message: string;
}>() {}

/** RPC or other dependency unavailable. Maps to 502 / 503. */
export class UpstreamUnavailableError extends TaggedError("UpstreamUnavailable")<{
  message: string;
  status: 502 | 503;
}>() {}

/**
 * Discriminated union of every error a route can produce.
 *
 * Exposed as a type so route handlers can be typed against one error space
 * and the envelope mapper can be exhaustive.
 */
export type GuardianError =
  | UnauthenticatedError
  | ForbiddenError
  | BadRequestError
  | UnsupportedMediaTypeError
  | UnsupportedChainError
  | NotFoundError
  | StateConflictError
  | ValidationFailedError
  | RateLimitedError
  | InternalError
  | UpstreamUnavailableError;

/**
 * Errors that may be returned by signing endpoints' validate-and-sign
 * abstractions. Auth/transport errors are emitted by the auth plugin
 * before sign* is reached; sign* itself only deals with policy and chain
 * outcomes.
 */
export type SigningError =
  | ValidationFailedError
  | StateConflictError
  | NotFoundError
  | UnsupportedChainError
  | UpstreamUnavailableError
  | InternalError;
