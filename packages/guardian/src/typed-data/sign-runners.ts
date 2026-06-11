import { Result } from "better-result";
import type { Address } from "viem";

import type {
  SignIntentFundBinding,
  SignIntentRequestBinding,
  SignIntentSwap,
  SignRequestWhitelisting,
  SigningContext,
} from "../abstractions.js";
import type { CheckEntry } from "../schemas/checks.js";
import type {
  StateConflictError,
  UpstreamUnavailableError,
  ValidationFailedError,
} from "../errors/tagged.js";
import { fetchEip712DomainNameVersion, type Eip712DomainCache } from "../lib/eip712-domain.js";
import type { IntentFundBindingBody } from "../schemas/intent-fund-binding.js";
import type { IntentRequestBindingBody } from "../schemas/intent-request-binding.js";
import type { IntentSwapBody } from "../schemas/intent-swap.js";
import type { RequestWhitelistingBody } from "../schemas/request-whitelisting.js";
import type { SigningSuccess } from "../schemas/responses.js";

import { buildIntentFundBindingTypedData } from "./intent-fund-binding.js";
import { buildIntentRequestBindingTypedData } from "./intent-request-binding.js";
import { buildIntentSwapTypedData } from "./intent-swap.js";
import {
  buildUnwhitelistRequestTypedData,
  buildWhitelistRequestTypedData,
} from "./request-whitelisting.js";

/**
 * Structural type of the per-endpoint check runner consumed by the
 * sign-runner factories below.
 *
 * Defined locally so this package does not pull `@3flabs/guardian-defaults`
 * into its dependency graph: any callable matching this shape — including
 * `CheckRunner<TBody, WithStateConflict>` from defaults — works.
 *
 * Errors:
 *  - `ValidationFailedError` (422) — at least one check failed.
 *  - `UpstreamUnavailableError` (503) — RPC unreachable mid-check.
 *  - `StateConflictError` (409) — only emitted by §A.2.
 */
type ChecksFn<TBody, TError> = (
  ctx: SigningContext,
  body: TBody,
) => Promise<Result<readonly CheckEntry[], TError>>;

/**
 * Optional shared deps for the four sign-runner factories.
 *
 *  - `cache` — backs the ERC-5267 `eip712Domain()` reads with an
 *    `AsyncCache`-shaped store. The defaults package's `inMemoryCache`
 *    constructed with a `{ name, version }` schema is the obvious
 *    choice; any structurally-compatible store works (Redis, KV).
 *  - `cacheTtlMs` — per-write TTL for the domain cache. Domains are
 *    immutable for a given (chain, contract) absent a contract upgrade,
 *    so a 24-hour default is reasonable. Pass `undefined` to defer to
 *    the cache's own default.
 */
export type Eip712DomainCacheDeps = {
  readonly cache?: Eip712DomainCache;
  readonly cacheTtlMs?: number;
};

const SIGNED_AT_EPOCH = "1970-01-01T00:00:00.000Z" as const;

function nowIso(now: Date): string {
  // `signedAt` is informational only (§6.4); fall back to epoch on a
  // pathological clock rather than throwing — the response shape stays
  // valid and the caller MUST NOT rely on `signedAt` for replay.
  const ms = now.getTime();
  if (!Number.isFinite(ms)) return SIGNED_AT_EPOCH;
  return now.toISOString();
}

/**
 * Resolves the EIP-712 `name`/`version` for `verifyingContract` and
 * builds a full {@link Eip712Domain} keyed to the request's chain.
 */
async function resolveDomain(args: {
  ctx: SigningContext;
  verifyingContract: Address;
  cacheDeps: Eip712DomainCacheDeps;
}) {
  const { ctx, verifyingContract, cacheDeps } = args;
  return fetchEip712DomainNameVersion({
    client: ctx.client,
    chainId: ctx.chainId,
    verifyingContract,
    cache: cacheDeps.cache,
    ttlMs: cacheDeps.cacheTtlMs,
    logger: ctx.logger,
  });
}

// ─── §A.1 / §7.3 ───────────────────────────────────────────────────────────

/**
 * Wires a §A.1 check runner into a {@link SignIntentRequestBinding}
 * abstraction. The returned function:
 *
 *   1. Runs `checks(ctx, body)`. Bail on `Err`.
 *   2. Reads `eip712Domain()` on `body.facility` (cached if `deps.cache`
 *      is supplied).
 *   3. Builds the `SetRequestParams` typed data and computes
 *      `payloadHash`.
 *   4. Calls `ctx.signTypedData`; signer errors propagate verbatim
 *      ({@link InternalError} or {@link UpstreamUnavailableError}).
 *   5. Assembles the §6.4 SigningSuccess. `guardian` is echoed from
 *      `deps.guardianSigner`, which MUST equal the address that
 *      `signTypedData` actually signs from (§7.2 invariant).
 */
export function makeSignIntentRequestBinding(
  deps: {
    checks: ChecksFn<IntentRequestBindingBody, ValidationFailedError | UpstreamUnavailableError>;
    guardianSigner: Address;
  } & Eip712DomainCacheDeps,
): SignIntentRequestBinding {
  const { checks, guardianSigner, cache, cacheTtlMs } = deps;
  return async (ctx, body) => {
    const checkResult = await checks(ctx, body);
    if (checkResult.isErr()) return Result.err(checkResult.error);

    const domainResult = await resolveDomain({
      ctx,
      verifyingContract: body.facility,
      cacheDeps: { cache, cacheTtlMs },
    });
    if (domainResult.isErr()) return Result.err(domainResult.error);

    const { typedData, payloadHash } = buildIntentRequestBindingTypedData({
      domain: {
        ...domainResult.value,
        chainId: body.chainId,
        verifyingContract: body.facility,
      },
      body,
    });

    const sigResult = await ctx.signTypedData(typedData);
    if (sigResult.isErr()) return Result.err(sigResult.error);

    const success: SigningSuccess = {
      guardian: guardianSigner,
      signature: sigResult.value,
      payloadHash,
      signedAt: nowIso(ctx.now),
      checks: [...checkResult.value],
    };
    return Result.ok(success);
  };
}

// ─── §A.2 / §7.4 ───────────────────────────────────────────────────────────

/**
 * Wires a §A.2 check runner into a {@link SignIntentFundBinding}
 * abstraction. The §A.2 runner is the only one whose error union
 * includes `StateConflictError` — when the fund-state check fails it
 * surfaces as 409 instead of 422.
 */
export function makeSignIntentFundBinding(
  deps: {
    checks: ChecksFn<
      IntentFundBindingBody,
      ValidationFailedError | UpstreamUnavailableError | StateConflictError
    >;
    guardianSigner: Address;
  } & Eip712DomainCacheDeps,
): SignIntentFundBinding {
  const { checks, guardianSigner, cache, cacheTtlMs } = deps;
  return async (ctx, body) => {
    const checkResult = await checks(ctx, body);
    if (checkResult.isErr()) {
      // The check runner's StateConflict / Validation / Upstream types
      // are all members of `SigningError | StateConflictError`, so a
      // direct propagation type-checks.
      return Result.err(checkResult.error);
    }

    const domainResult = await resolveDomain({
      ctx,
      verifyingContract: body.facility,
      cacheDeps: { cache, cacheTtlMs },
    });
    if (domainResult.isErr()) return Result.err(domainResult.error);

    const { typedData, payloadHash } = buildIntentFundBindingTypedData({
      domain: {
        ...domainResult.value,
        chainId: body.chainId,
        verifyingContract: body.facility,
      },
      body,
    });

    const sigResult = await ctx.signTypedData(typedData);
    if (sigResult.isErr()) return Result.err(sigResult.error);

    const success: SigningSuccess = {
      guardian: guardianSigner,
      signature: sigResult.value,
      payloadHash,
      signedAt: nowIso(ctx.now),
      checks: [...checkResult.value],
    };
    return Result.ok(success);
  };
}

// ─── §A.3 / §7.5 ───────────────────────────────────────────────────────────

/**
 * Wires a §A.3 check runner into a {@link SignIntentSwap} abstraction.
 *
 * The legs are canonicalised at typed-data build time so `[A, B]` and
 * `[B, A]` produce the same signature and `payloadHash`.
 */
export function makeSignIntentSwap(
  deps: {
    checks: ChecksFn<IntentSwapBody, ValidationFailedError | UpstreamUnavailableError>;
    guardianSigner: Address;
  } & Eip712DomainCacheDeps,
): SignIntentSwap {
  const { checks, guardianSigner, cache, cacheTtlMs } = deps;
  return async (ctx, body) => {
    const checkResult = await checks(ctx, body);
    if (checkResult.isErr()) return Result.err(checkResult.error);

    const domainResult = await resolveDomain({
      ctx,
      verifyingContract: body.facility,
      cacheDeps: { cache, cacheTtlMs },
    });
    if (domainResult.isErr()) return Result.err(domainResult.error);

    const { typedData, payloadHash } = buildIntentSwapTypedData({
      domain: {
        ...domainResult.value,
        chainId: body.chainId,
        verifyingContract: body.facility,
      },
      body,
    });

    const sigResult = await ctx.signTypedData(typedData);
    if (sigResult.isErr()) return Result.err(sigResult.error);

    const success: SigningSuccess = {
      guardian: guardianSigner,
      signature: sigResult.value,
      payloadHash,
      signedAt: nowIso(ctx.now),
      checks: [...checkResult.value],
    };
    return Result.ok(success);
  };
}

// ─── §A.4 / §7.6 ───────────────────────────────────────────────────────────

/**
 * Wires a §A.4 check runner into a {@link SignRequestWhitelisting}
 * abstraction. The response carries the §7.6.1 extensions
 * (`address`, `nonce`) — `address` echoes the validator (Guardian
 * signer) bound into the typed-data payload, and `nonce` is the
 * verbatim request nonce.
 *
 * The on-chain validator address bound into the typed-data MUST equal
 * the Guardian's signer (`guardianSigner`) — that's the address whose
 * nonce floor / bitmap §A.4 reads when validating, and the address
 * `_verifyBatchQuorum` recovers from `ecrecover`.
 *
 * The response's `guardian` and `address` fields therefore both equal
 * `guardianSigner` in v1; they remain distinct on the wire because
 * §7.6.1 carries `address` as an explicit on-chain payload parameter.
 */
export function makeSignRequestWhitelisting(
  deps: {
    checks: ChecksFn<RequestWhitelistingBody, ValidationFailedError | UpstreamUnavailableError>;
    guardianSigner: Address;
  } & Eip712DomainCacheDeps,
): SignRequestWhitelisting {
  const { checks, guardianSigner, cache, cacheTtlMs } = deps;
  return async (ctx, body) => {
    const checkResult = await checks(ctx, body);
    if (checkResult.isErr()) return Result.err(checkResult.error);

    const domainResult = await resolveDomain({
      ctx,
      verifyingContract: body.whitelistBook,
      cacheDeps: { cache, cacheTtlMs },
    });
    if (domainResult.isErr()) return Result.err(domainResult.error);

    // Branch on `operation` so each call to `signTypedData` carries a
    // concrete (non-union) `TypedDataDefinition` — viem's generic infers
    // the type list from the parameters and would otherwise reject a
    // union of two distinct-key type maps. We build, sign, and return
    // inside each branch so the typed-data narrowing reaches the
    // signer call without identity-cast escape hatches.
    const sharedDomain = {
      ...domainResult.value,
      chainId: body.chainId,
      verifyingContract: body.whitelistBook,
    } as const;
    const { operation, ...rest } = body;
    const buildArgs = { domain: sharedDomain, body: rest, validator: guardianSigner };

    if (operation === "whitelist") {
      const { typedData, payloadHash } = buildWhitelistRequestTypedData(buildArgs);
      const sigResult = await ctx.signTypedData(typedData);
      if (sigResult.isErr()) return Result.err(sigResult.error);
      return Result.ok({
        guardian: guardianSigner,
        signature: sigResult.value,
        payloadHash,
        signedAt: nowIso(ctx.now),
        checks: [...checkResult.value],
        address: guardianSigner,
        nonce: body.nonce,
      });
    }

    const { typedData, payloadHash } = buildUnwhitelistRequestTypedData(buildArgs);
    const sigResult = await ctx.signTypedData(typedData);
    if (sigResult.isErr()) return Result.err(sigResult.error);
    return Result.ok({
      guardian: guardianSigner,
      signature: sigResult.value,
      payloadHash,
      signedAt: nowIso(ctx.now),
      checks: [...checkResult.value],
      address: guardianSigner,
      nonce: body.nonce,
    });
  };
}
