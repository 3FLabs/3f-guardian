import { Result } from "better-result";

import { type IntentRequestBindingBody, UpstreamUnavailableError } from "@3flabs/guardian";
import type { CheckEntry, SigningContext } from "@3flabs/guardian";

import { checkDeadline, checkMembership, rollUp } from "./helpers.js";
import type { CheckRunner } from "./types.js";

/**
 * Per-chain accepted-set policy (§11). Sets are case-insensitive over
 * EVM addresses; pass them as `Set<string>` and the check helpers
 * lowercase before comparing.
 */
export type IntentRequestBindingPolicy = {
  readonly maxDeadlineSecondsAhead: number;
  /** §11 ACCEPTED_REQUEST_ORIGINS, keyed by chainId. */
  readonly acceptedRequestOrigins: ReadonlyMap<number, ReadonlySet<string>>;
  /** §11 ACCEPTED_REQUEST_OWNERS, keyed by chainId. */
  readonly acceptedOwners: ReadonlyMap<number, ReadonlySet<string>>;
  /** §11 ACCEPTED_PULLER_HOLDERS, keyed by chainId. */
  readonly acceptedPullers: ReadonlyMap<number, ReadonlySet<string>>;
  /** §11 ACCEPTED_CONSUMER_HOLDERS, keyed by chainId. */
  readonly acceptedConsumers: ReadonlyMap<number, ReadonlySet<string>>;
};

/**
 * Adapter port for protocol-specific reads on the request contract.
 *
 * The shapes of `owner()`, the puller role, and the consumer role vary
 * per implementation (some are immutable storage slots, some are
 * AccessControl roles, some are external delegate calls). Hosts
 * implement this port against their own ABI; the defaults package
 * stays ABI-agnostic.
 *
 * Each method MUST throw a value that the runner can catch and convert
 * to `UpstreamUnavailableError` — typically by letting the underlying
 * viem call propagate naturally.
 */
export type RequestContractReader = {
  readonly readOwner: (ctx: SigningContext, requestContract: string) => Promise<string>;
  readonly readPuller: (ctx: SigningContext, requestContract: string) => Promise<string>;
  readonly readConsumer: (ctx: SigningContext, requestContract: string) => Promise<string>;
};

/**
 * Builds the §A.1 check runner for `POST /v1/facility/intent-request-bindings`.
 *
 * Order of evaluation (mirrors Appendix A.1):
 *   1. request contract on accepted-origins (no RPC)
 *   2. owner of request contract on accepted-owners (1 RPC)
 *   3. puller role restricted to accepted parties (1 RPC)
 *   4. consumer role restricted to accepted parties (1 RPC)
 *   5. deadline ≤ MAX_DEADLINE_SECONDS_AHEAD (no RPC)
 *
 * RPC-bearing checks short-circuit by failing fast: if the origin check
 * fails the contract is not on policy and we skip the on-chain reads
 * entirely (no point loading contract state for a contract we don't
 * trust). Failed entries are still emitted as `passed:false` for the
 * §6.4.1 checks array — the rollUp helper aggregates them into one
 * `ValidationFailedError`.
 */
export function buildIntentRequestBindingChecks(deps: {
  policy: IntentRequestBindingPolicy;
  reader: RequestContractReader;
}): CheckRunner<IntentRequestBindingBody, false> {
  const { policy, reader } = deps;
  return async (ctx, body) => runA1(ctx, body, policy, reader);
}

/**
 * Internal worker shared with the §A.4 whitelist-book runner so its
 * `operation = "whitelist"` branch can apply A.1 to each request
 * contract without re-implementing the on-chain reads.
 */
export async function runA1(
  ctx: SigningContext,
  body: { chainId: number; requestContract: string; deadline: number },
  policy: IntentRequestBindingPolicy,
  reader: RequestContractReader,
): Promise<Result<readonly CheckEntry[], import("./types.js").CheckRunnerError<false>>> {
  const checks: CheckEntry[] = [];
  const { chainId, requestContract, deadline } = body;

  // 1. Origin set membership (no RPC needed).
  const acceptedOrigins = policy.acceptedRequestOrigins.get(chainId) ?? new Set<string>();
  const originCheck = checkMembership({
    description: "request contract is on the accepted-origins policy",
    value: requestContract,
    accepted: acceptedOrigins,
    addressLike: true,
  });
  checks.push(originCheck);

  // If the origin check failed, the on-chain reads against an
  // untrusted contract have no policy meaning. Emit the deadline check
  // (also no RPC) and return.
  if (!originCheck.passed) {
    checks.push(
      checkDeadline({
        nowUnixSeconds: Math.floor(ctx.now.getTime() / 1000),
        deadline,
        maxSecondsAhead: policy.maxDeadlineSecondsAhead,
      }),
    );
    return rollupA1(checks);
  }

  // 2-4. Role reads. Run in parallel — they're independent.
  let owner: string;
  let puller: string;
  let consumer: string;
  try {
    [owner, puller, consumer] = await Promise.all([
      reader.readOwner(ctx, requestContract),
      reader.readPuller(ctx, requestContract),
      reader.readConsumer(ctx, requestContract),
    ]);
  } catch (e) {
    ctx.logger.error(
      { err: e instanceof Error ? e.message : e, requestContract },
      "A.1: on-chain read failed",
    );
    return Result.err(
      new UpstreamUnavailableError({
        message: `request-contract read failed: ${e instanceof Error ? e.message : "unknown"}`,
        status: 503,
      }),
    );
  }

  checks.push(
    checkMembership({
      description: "owner of request contract is on the accepted-owners list",
      value: owner,
      accepted: policy.acceptedOwners.get(chainId) ?? new Set<string>(),
      addressLike: true,
    }),
    checkMembership({
      description: "puller role on request contract is restricted to accepted parties",
      value: puller,
      accepted: policy.acceptedPullers.get(chainId) ?? new Set<string>(),
      addressLike: true,
    }),
    checkMembership({
      description: "consumer role on request contract is restricted to accepted parties",
      value: consumer,
      accepted: policy.acceptedConsumers.get(chainId) ?? new Set<string>(),
      addressLike: true,
    }),
    checkDeadline({
      nowUnixSeconds: Math.floor(ctx.now.getTime() / 1000),
      deadline,
      maxSecondsAhead: policy.maxDeadlineSecondsAhead,
    }),
  );

  return rollupA1(checks);
}

function rollupA1(
  checks: readonly CheckEntry[],
): Result<readonly CheckEntry[], import("./types.js").CheckRunnerError<false>> {
  const r = rollUp(checks, "Appendix A.1 checks failed");
  return r.ok ? Result.ok(r.checks) : Result.err(r.error);
}
