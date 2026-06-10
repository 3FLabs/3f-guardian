import type { Result } from "better-result";
import type { Hex, PublicClient, TypedData, TypedDataDefinition } from "viem";

import type {
  GuardianError,
  InternalError,
  SigningError,
  StateConflictError,
  UnauthenticatedError,
  UnsupportedChainError,
  UpstreamUnavailableError,
} from "./errors/tagged.js";

import type { GuardianTimeouts } from "./lib/deadline.js";
import type { Logger } from "./lib/logger.js";
import type { IntentRequestBindingBody } from "./schemas/intent-request-binding.js";
import type { IntentFundBindingBody } from "./schemas/intent-fund-binding.js";
import type { IntentSwapBody } from "./schemas/intent-swap.js";
import type {
  RequestWhitelistingBody,
  RequestWhitelistingResponse,
} from "./schemas/request-whitelisting.js";
import type { SigningSuccess } from "./schemas/responses.js";
import type { VersionResponse } from "./schemas/version.js";

// ─── Call options ──────────────────────────────────────────────────────────

/**
 * Options the shell forwards to every host-supplied async abstraction
 * call. `signal` aborts when the per-call deadline (see
 * {@link GuardianTimeouts}) expires; implementations SHOULD forward it
 * to their I/O so a timed-out call stops consuming resources. Ignoring
 * it is safe — the shell also races the call against the deadline and
 * responds `503 upstream_unavailable` regardless.
 */
export type AbstractionCallOptions = {
  readonly signal: AbortSignal;
};

// ─── Authentication ────────────────────────────────────────────────────────

/**
 * Endpoint scopes a token can carry. A token MAY be scoped to a strict
 * subset of endpoints (§5.2). The build-server function checks whether the
 * authenticated token's scopes include the route's required scope.
 */
export const ENDPOINT_SCOPES = [
  "facility:intent-request-bindings",
  "facility:intent-fund-bindings",
  "facility:intent-swaps",
  "whitelist-book:request-whitelistings",
] as const;

export type EndpointScope = (typeof ENDPOINT_SCOPES)[number];

/**
 * Resolved token information. The plugin uses this to:
 *  - compare `scopes` against the route's required scope (§5.2)
 *  - look up `hmacSecret` for §5.4 verification when `requiresHmac` is true
 *  - tag log entries with `tokenId` (§5.3)
 *
 * `hmacSecret` MUST be present whenever `requiresHmac` is true. The shape
 * is validated structurally by the auth plugin; nothing else inspects it.
 */
export type TokenInfo = {
  readonly tokenId: string;
  readonly scopes: ReadonlySet<EndpointScope>;
  readonly requiresHmac: boolean;
  readonly hmacSecret?: string;
};

// ─── Signing primitive ─────────────────────────────────────────────────────

/**
 * Errors that may arise from the host's EIP-712 signer. Both arms are
 * already members of `SigningError`, so a sign* implementation can
 * propagate the failure verbatim with `.mapError`.
 *
 *  - `UpstreamUnavailableError` — KMS / HSM / remote signer reachable
 *    but unable to serve (502 / 503).
 *  - `InternalError` — local signer in a broken state (500). Use this
 *    arm sparingly: a stuck local key is an operator-grade incident.
 */
export type SignTypedDataError = UpstreamUnavailableError | InternalError;

/**
 * EIP-712 typed-data signer.
 *
 * Mirrors viem's `LocalAccount.signTypedData` shape — the signer takes
 * the fully typed `TypedDataDefinition` (domain + types + primaryType +
 * message) — but returns a `Result` instead of throwing, since the
 * host's implementation may be backed by a KMS / HSM that can fail
 * transiently.
 *
 * It does NOT take a private key as a parameter: the host's
 * implementation is closed over the key (or a KMS / HSM handle) at
 * construction time.
 *
 * The host MUST derive `payloadHash` and the response's `guardian` field
 * from the same signer; in practice they are co-located in the
 * implementation module that owns the key.
 *
 * Type only — implementations are supplied by the caller of
 * `buildGuardianServer`.
 */
export type SignTypedData = <
  const typedData extends TypedData | Record<string, unknown>,
  primaryType extends keyof typedData | "EIP712Domain" = keyof typedData,
>(
  parameters: TypedDataDefinition<typedData, primaryType>,
) => Promise<Result<Hex, SignTypedDataError>>;

// ─── Request context derived per call ──────────────────────────────────────

/**
 * Per-request context handed to every signing abstraction.
 *
 * - `client` is the viem PublicClient for the request's `chainId`. Resolution
 *   happens inside the plugin; the abstraction sees only a ready-to-use
 *   client and does not need to handle UnsupportedChain.
 * - `requestId` is the canonicalised X-Request-Id for the call (§3.7),
 *   forwarded so abstractions can correlate Guardian-side logs with
 *   the wire-level identifier.
 * - `tokenId` lets the abstraction enrich its own audit logs with the
 *   token that authenticated the call, without re-deriving it.
 * - `now` is captured once at request entry so all checks see the same
 *   wall-clock value (the deadline-rejection rule in §7.7 is sensitive to
 *   this).
 * - `signTypedData` is the host-owned EIP-712 signer (see {@link SignTypedData}).
 *   Sign* implementations call it after policy checks pass; they MUST NOT
 *   construct a viem account from a raw key inside the validate-and-sign
 *   function.
 * - `logger` is a `Logger` already child-bound to `{ requestId, tokenId,
 *   chainId }`. Abstraction implementations SHOULD use it for any
 *   per-request log emission so records correlate with the shell's own
 *   logs without duplicate context plumbing.
 * - `signal` (when present) aborts once the `signMs` deadline (see
 *   {@link GuardianTimeouts}) expires. Implementations SHOULD forward it
 *   to on-chain reads / KMS calls so a timed-out request stops consuming
 *   resources; the shell responds 503 on expiry either way.
 */
export type SigningContext = {
  readonly chainId: number;
  readonly client: PublicClient;
  readonly requestId: string;
  readonly tokenId: string;
  readonly now: Date;
  readonly signTypedData: SignTypedData;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
};

// ─── Generic shape of every validate-and-sign abstraction ─────────────────

/**
 * Generic shape of a validate-and-sign abstraction.
 *
 * The contract:
 *  - `body` has already been parsed by zod and is structurally valid.
 *  - The implementation performs every Appendix-A check that applies to
 *    its endpoint, evaluates any on-chain reads via `ctx.client`, and
 *    returns either a §6.4 SigningSuccess (which the route serialises
 *    verbatim) or a tagged error from `TError`.
 *  - The function MUST be deterministic with respect to the signed
 *    payload (§8): identical body + identical on-chain state ⇒ identical
 *    `signature` and `payloadHash`.
 *
 * Type only — implementations are supplied by the caller of
 * `buildGuardianServer`.
 */
export type ValidateAndSign<TBody, TSuccess, TError> = (
  ctx: SigningContext,
  body: TBody,
) => Promise<Result<TSuccess, TError>>;

// ─── Per-endpoint specialisations ──────────────────────────────────────────

/**
 * §7.3 / Appendix A.1. Never returns 409 (state_conflict).
 */
export type SignIntentRequestBinding = ValidateAndSign<
  IntentRequestBindingBody,
  SigningSuccess,
  SigningError
>;

/**
 * §7.4 / Appendix A.2. The fund-state check is the only 409-class check
 * in v1, hence the explicit `StateConflictError` arm.
 */
export type SignIntentFundBinding = ValidateAndSign<
  IntentFundBindingBody,
  SigningSuccess,
  SigningError | StateConflictError
>;

/**
 * §7.5 / Appendix A.3. Never returns 409.
 *
 * Per §7.5 the legs array is unordered: implementations MUST normalise
 * legs before signing so `[A, B]` and `[B, A]` produce byte-identical
 * `signature` and `payloadHash`.
 */
export type SignIntentSwap = ValidateAndSign<IntentSwapBody, SigningSuccess, SigningError>;

/**
 * §7.6 / Appendix A.4. Never returns 409.
 *
 * The response carries the §7.6.1 extensions (`address`, `nonce`).
 */
export type SignRequestWhitelisting = ValidateAndSign<
  RequestWhitelistingBody,
  RequestWhitelistingResponse,
  SigningError
>;

// ─── Configuration & supporting abstractions ───────────────────────────────

/**
 * Static metadata exposed at GET /version (§7.2) and on every response via
 * `X-Guardian-Version` (§6.3). The shape mirrors the §7.2 response, minus
 * `apiVersion` which is fixed at "v1" for this build.
 */
export type GuardianMetadata = Omit<VersionResponse, "apiVersion">;

/**
 * Liveness predicate for §7.1. Implementations SHOULD return false if the
 * Guardian has lost access to its signing key or to all configured RPCs;
 * the route returns 503 in that case.
 *
 * The call is bounded by the `livenessMs` deadline (see
 * {@link GuardianTimeouts}); `options.signal` aborts on expiry.
 */
export type LivenessProbe = (
  options?: AbstractionCallOptions,
) => Promise<Result<void, GuardianError>>;

/** §6.3 `X-RateLimit-*` header values to emit on a successful response. */
export type RateLimitWindow = {
  readonly limit: number;
  readonly remaining: number;
  readonly resetUnixSeconds: number;
};

/**
 * The complete contract a caller must fulfil to construct a Guardian
 * server. None of these are implemented in this package; everything is a
 * type so the package stays generic over how chains, secrets, signing
 * keys and policy data are managed in the host environment.
 */
export type GuardianAbstractions = {
  /** Build/runtime metadata; static for the lifetime of the process. */
  readonly metadata: GuardianMetadata;

  /**
   * Optional structured logger. When omitted the shell uses a noop logger
   * that silently drops every record. Hosts SHOULD supply a real logger
   * (e.g., `pinoLogger()` from `@3flabs/guardian-defaults`) so the shell
   * can surface auth failures, rate-limit hits, and signing outcomes.
   *
   * The shell child-binds the logger with `{ requestId, tokenId,
   * chainId }` per request and forwards it on `SigningContext`.
   */
  readonly logger?: Logger;

  /** §7.1 readiness signal. */
  readonly liveness: LivenessProbe;

  /**
   * Resolve the viem `PublicClient` for an EIP-155 chain id. Returning
   * `Err(UnsupportedChainError)` causes the route to respond with
   * `400 unsupported_chain` per §6.6 — the same code as a malformed
   * `chainId` field — without revealing routing internals.
   */
  readonly getChainClient: (chainId: number) => Result<PublicClient, UnsupportedChainError>;

  /**
   * Map a bearer token (the value after `Bearer `) to TokenInfo, or
   * `Err(UnauthenticatedError)` for unknown / revoked / malformed tokens.
   *
   * The §5.4 timestamp & HMAC checks are NOT this function's
   * responsibility — they live in the auth plugin and use the
   * `hmacSecret` returned here when `requiresHmac` is true.
   *
   * §5.3 permits up to two distinct concurrently-valid tokens per caller
   * during rotation; that is invisible to this interface — both tokens
   * resolve to a TokenInfo with the same `tokenId` or different ids per
   * operator policy.
   *
   * The call is bounded by the `authenticateMs` deadline (see
   * {@link GuardianTimeouts}); `options.signal` aborts on expiry.
   */
  readonly authenticate: (
    token: string,
    options?: AbstractionCallOptions,
  ) => Promise<Result<TokenInfo, UnauthenticatedError>>;

  /**
   * EIP-712 signer. The host owns the private key (or KMS / HSM handle)
   * and exposes only this typed signing primitive — neither the server
   * shell nor the validate-and-sign abstractions ever see the key.
   *
   * The corresponding signer address MUST equal `metadata.guardianSigner`
   * (§7.2 / §6.4 invariant: the response's `guardian` field equals the
   * value reported by GET /version).
   */
  readonly signTypedData: SignTypedData;

  /**
   * Optional rate-limit accounting hook. If absent, no `X-RateLimit-*`
   * headers are emitted and the Guardian never returns 429 of its own
   * accord (callers may still rate-limit at a reverse proxy).
   *
   * Returning `Err(RateLimitedError)` yields 429 with `Retry-After` per
   * §6.3 / §6.6.
   *
   * The call is bounded by the `rateLimitMs` deadline (see
   * {@link GuardianTimeouts}); `options.signal` aborts on expiry.
   */
  readonly accountRateLimit?: (
    tokenInfo: TokenInfo,
    options?: AbstractionCallOptions,
  ) => Promise<Result<RateLimitWindow, GuardianError>>;

  /**
   * Optional upstream-unavailable probe, consulted at the top of every
   * signing request (before chain-client resolution and the sign* call).
   * Returning `Err(UpstreamUnavailableError)` short-circuits the request
   * with the error's own 502/503 status, letting a host that has already
   * detected its upstream is down fail fast. When absent the server
   * relies on per-endpoint signing functions to surface upstream
   * failures via `Err(UpstreamUnavailableError)` from their on-chain
   * reads.
   */
  readonly probeUpstream?: () => Result<void, UpstreamUnavailableError>;

  /**
   * Optional per-call deadlines for the async abstractions above. See
   * {@link GuardianTimeouts} for fields and defaults. On expiry the shell
   * responds `503 upstream_unavailable` and logs at error level with the
   * abstraction name.
   */
  readonly timeouts?: GuardianTimeouts;

  /**
   * Optional cap (bytes) on request bodies the shell buffers for §5.4
   * HMAC verification and JSON parsing. Default 1 MiB. Bodies that
   * declare or stream past the cap are rejected with
   * `413` (`bad_request` envelope) before authentication — every
   * legitimate v1 body is a small JSON document. Hosts deploying via
   * `Bun.serve` SHOULD additionally set `maxRequestBodySize` as a
   * transport-level backstop.
   */
  readonly maxBodyBytes?: number;

  // ── Validate-and-sign abstractions, declared, NOT defined ───────────────

  readonly signIntentRequestBinding: SignIntentRequestBinding;
  readonly signIntentFundBinding: SignIntentFundBinding;
  readonly signIntentSwap: SignIntentSwap;
  readonly signRequestWhitelisting: SignRequestWhitelisting;
};
