import { Result } from "better-result";
import { type Address } from "viem";

import {
  type CheckEntry,
  type IntentRequestBindingBody,
  type SigningContext,
  UpstreamUnavailableError,
} from "@3flabs/guardian";

import type { AsyncCache } from "../cache/types.js";
import { requestAbi, ROLE_CONSUMER, ROLE_PULLER } from "../abi/request.js";
import { requestFactoryAbi } from "../abi/request-factory.js";
import { checkDeadline, checkMembership, failed, passed, rollUp, skipped } from "./helpers.js";
import { holdersOf, scanRoleHolders } from "./role-events.js";
import type { CheckRunner, CheckRunnerError } from "./types.js";

/**
 * Per-chain accepted-set policy for §A.1. All sets are case-insensitive
 * over EVM addresses.
 *
 *  - `acceptedRequestFactories` — replaces the old "accepted-origins"
 *    set. A request contract is considered legitimate iff at least one
 *    accepted factory's `isRequest(addr)` returns `true`.
 *
 *  - `acceptedOwners` — `Ownable.owner()` on the request contract MUST
 *    be on this set.
 *
 *  - `acceptedPullers` / `acceptedConsumers` — every address holding
 *    `_ROLE_PULLER` (resp. `_ROLE_CONSUMER`) on the request contract,
 *    derived from a `RolesUpdated` event replay, MUST be on these
 *    sets. Catches rogue grants because the replay sees ALL granted
 *    addresses, not just an oracle-supplied singleton.
 *
 *  - `eventScanBlockRange` — chunk size for `getLogs`. Larger = fewer
 *    RPC round-trips, but more risk of provider range limits. 10_000
 *    is a sane default for most providers (Alchemy / Infura allow this).
 *
 *  - `eventScanMaxLookbackBlocks` — how far back the scan walks before
 *    giving up. If the contract was deployed earlier than
 *    `latestBlock - this`, the puller / consumer entries are emitted
 *    as `skipped:true` (we cannot prove the holder set is complete).
 */
export type IntentRequestBindingPolicy = {
  readonly maxDeadlineSecondsAhead: number;
  readonly acceptedRequestFactories: ReadonlyMap<number, ReadonlySet<string>>;
  readonly acceptedOwners: ReadonlyMap<number, ReadonlySet<string>>;
  readonly acceptedPullers: ReadonlyMap<number, ReadonlySet<string>>;
  readonly acceptedConsumers: ReadonlyMap<number, ReadonlySet<string>>;
  readonly eventScanBlockRange: bigint;
  readonly eventScanMaxLookbackBlocks: bigint;
};

/**
 * Cached representation of the §A.1 on-chain reads. Stored verbatim by
 * any `AsyncCache<A1OnChainData>` and replayed against the *current*
 * policy on cache hit, so policy changes (e.g. adding an accepted
 * owner) take effect without a manual flush.
 *
 *  - `noFactory` — none of the policy's accepted factories at the time
 *    of fetch recognised this request contract. We still cache this
 *    result with the (typically shorter) TTL so a misconfigured caller
 *    cannot DoS the eth_getLogs path. If the policy later adds a new
 *    factory the entry will go stale within `cacheTtlMs`.
 *
 *  - `tooOld` — a factory recognised the contract but the role-events
 *    scan exhausted `eventScanMaxLookbackBlocks` without seeing
 *    deployment. The role checks remain `skipped:true` on every replay
 *    until the cache expires.
 *
 *  - `resolved` — full data: matched factory, owner snapshot, and the
 *    fully-replayed role-holder bitfield map. Membership decisions are
 *    made by `evaluateA1` against the live policy, so this entry can
 *    safely outlive a policy change.
 *
 * `holders` is a plain `Map<Address, bigint>` for parity with
 * `scanRoleHolders`. Cross-process cache adapters (Redis, KV) MUST
 * serialise it themselves — the cache interface is value-opaque.
 */
export type A1OnChainData =
  | { readonly kind: "noFactory" }
  | { readonly kind: "tooOld"; readonly factory: Address; readonly owner: Address }
  | {
      readonly kind: "resolved";
      readonly factory: Address;
      readonly owner: Address;
      readonly holders: ReadonlyMap<Address, bigint>;
    };

/**
 * Dependencies for the §A.1 runner. Sharable with §A.4
 * (`buildRequestWhitelistingChecks`) which delegates per-contract
 * checks to {@link runA1}.
 *
 *  - `cache` — optional {@link AsyncCache} keyed by
 *    `${chainId}:${requestContract.toLowerCase()}`. If supplied, hit
 *    skips the entire on-chain fetch (multicall + getBlockNumber + log
 *    scan). On miss the runner fetches and writes the result back.
 *
 *  - `cacheTtlMs` — per-write TTL passed to `cache.set`. If omitted the
 *    cache implementation's default applies. Pick this in tension with
 *    your role-grant frequency: shorter = fresher role-holder snapshot,
 *    longer = more amortisation (especially for §A.4 batches that hit
 *    the same contracts repeatedly).
 */
export type A1Deps = {
  readonly policy: IntentRequestBindingPolicy;
  readonly cache?: AsyncCache<A1OnChainData>;
  readonly cacheTtlMs?: number;
};

/**
 * Builds the §A.1 check runner for `POST /v1/facility/intent-request-bindings`.
 *
 * Order of evaluation (matches §6.4.1 emission):
 *
 *   1. request contract was deployed by an accepted factory          (422)
 *   2. owner of request contract is on the accepted-owners list      (422)
 *   3. puller role on request contract is held only by accepted parties  (422)
 *   4. consumer role on request contract is held only by accepted parties (422)
 *   5. deadline within MAX_DEADLINE_SECONDS_AHEAD of now              (422)
 *
 * Stage 1 — single multicall (`allowFailure: false`):
 *   - `request.owner()`
 *   - `factory.isRequest(requestContract)` for each accepted factory
 *
 * If no factory returns `true`, every on-chain entry is emitted as
 * `skipped:true` and the request fails on check #1 alone.
 *
 * Stage 2 — role-events scan against the matched factory:
 *   - Walks backwards in `eventScanBlockRange` chunks until the
 *     factory's `RequestCreated` event for `requestContract` is found
 *     OR `eventScanMaxLookbackBlocks` is exhausted.
 *   - Each chunk is one `getLogs` filtered server-side to
 *     `[factory, requestContract]` × `[RolesUpdated, RequestCreated]`.
 *   - "Too old" outcome → role checks emitted as `skipped:true`.
 *
 * `allowFailure: false` means any RPC / revert surfaces as
 * `UpstreamUnavailableError` (503), per §6.6.
 *
 * Optional cache: when `deps.cache` is supplied the on-chain reads are
 * bypassed on hit; see {@link A1Deps} for behaviour and {@link A1OnChainData}
 * for what is stored.
 */
export function buildIntentRequestBindingChecks(
  deps: A1Deps,
): CheckRunner<IntentRequestBindingBody, false> {
  return async (
    ctx: SigningContext,
    body: IntentRequestBindingBody,
  ): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> => {
    return runA1(ctx, body, deps);
  };
}

/**
 * Internal worker shared with the §A.4 whitelist-book runner so its
 * `operation = "whitelist"` branch can apply A.1 to each request
 * contract without re-implementing the on-chain reads.
 *
 * Cache flow:
 *   1. If `deps.cache` is supplied, attempt a `get`. On hit, jump
 *      straight to {@link evaluateA1} with the cached data.
 *   2. On miss (or `cache.get` throwing), fall through to
 *      {@link fetchA1OnChain} which performs the multicall + log scan.
 *   3. After a successful fetch, best-effort `cache.set` (errors are
 *      logged but do not propagate — a flaky cache must not block an
 *      otherwise valid request).
 */
export async function runA1(
  ctx: SigningContext,
  body: { chainId: number; requestContract: Address; deadline: number },
  deps: A1Deps,
): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> {
  const { policy, cache, cacheTtlMs } = deps;
  const { chainId, requestContract, deadline } = body;

  const nowUnix = Math.floor(ctx.now.getTime() / 1000);
  const deadlineCheck = checkDeadline({
    nowUnixSeconds: nowUnix,
    deadline,
    maxSecondsAhead: policy.maxDeadlineSecondsAhead,
  });

  const cacheKey = `${chainId}:${requestContract.toLowerCase()}`;

  let onChain: A1OnChainData | undefined;
  if (cache !== undefined) {
    try {
      onChain = await cache.get(cacheKey);
    } catch (e) {
      ctx.logger.warn(
        { err: e instanceof Error ? e.message : e, requestContract },
        "A.1: cache.get failed; treating as miss",
      );
    }
  }

  if (onChain === undefined) {
    const fetched = await fetchA1OnChain(ctx, chainId, requestContract, policy);
    if (fetched.isErr()) return Result.err(fetched.error);
    onChain = fetched.value;

    if (cache !== undefined) {
      try {
        await cache.set(cacheKey, onChain, cacheTtlMs !== undefined ? { ttlMs: cacheTtlMs } : {});
      } catch (e) {
        ctx.logger.warn(
          { err: e instanceof Error ? e.message : e, requestContract },
          "A.1: cache.set failed; continuing without cache write",
        );
      }
    }
  }

  return rollupA1(evaluateA1(onChain, chainId, policy, deadlineCheck));
}

/**
 * Performs the on-chain reads needed for §A.1. Returns the raw data
 * (factory match, owner, role-holder map) that `evaluateA1` consumes
 * — split out so the cache can replay results without re-issuing any
 * RPCs.
 */
async function fetchA1OnChain(
  ctx: SigningContext,
  chainId: number,
  requestContract: Address,
  policy: IntentRequestBindingPolicy,
): Promise<Result<A1OnChainData, UpstreamUnavailableError>> {
  const acceptedFactories = policy.acceptedRequestFactories.get(chainId) ?? new Set<string>();
  const factoriesArr = [...acceptedFactories].map((f) => f as Address);

  // ── Stage 1: independent multicall ───────────────────────────────
  // request.owner() + factory.isRequest(...) for each accepted factory.
  // Heterogeneous shape (one owner read, then a dynamic-length array of
  // factory reads) defeats viem's const-tuple inference. We type-erase
  // the contracts param and cast the results — runtime decoding is
  // unaffected.
  let stage1Results: readonly [Address, ...boolean[]];
  try {
    stage1Results = (await ctx.client.multicall({
      contracts: [
        { address: requestContract, abi: requestAbi, functionName: "owner" },
        ...factoriesArr.map((factory) => ({
          address: factory,
          abi: requestFactoryAbi,
          functionName: "isRequest" as const,
          args: [requestContract] as const,
        })),
      ] as never,
      allowFailure: false,
    })) as unknown as readonly [Address, ...boolean[]];
  } catch (e) {
    ctx.logger.error(
      { err: e instanceof Error ? e.message : e, requestContract },
      "A.1: stage 1 multicall failed",
    );
    return Result.err(
      new UpstreamUnavailableError({
        message: `request-contract read failed: ${e instanceof Error ? e.message : "unknown"}`,
        status: 503,
      }),
    );
  }

  const owner = stage1Results[0];
  const factoryHits = factoriesArr
    .map((factory, i) => ({ factory, isRequest: stage1Results[i + 1] === true }))
    .filter((h) => h.isRequest);

  if (factoryHits.length === 0) {
    return Result.ok({ kind: "noFactory" });
  }

  // Pick the (sole) factory that returned true. If multiple did
  // (configuration error), pick the first deterministically.
  const factory = factoryHits[0]!.factory;

  // ── Stage 2: role-events scan ────────────────────────────────────
  let latestBlock: bigint;
  try {
    latestBlock = await ctx.client.getBlockNumber();
  } catch (e) {
    ctx.logger.error({ err: e instanceof Error ? e.message : e }, "A.1: getBlockNumber failed");
    return Result.err(
      new UpstreamUnavailableError({
        message: `getBlockNumber failed: ${e instanceof Error ? e.message : "unknown"}`,
        status: 503,
      }),
    );
  }

  let scanOutcome;
  try {
    scanOutcome = await scanRoleHolders({
      client: ctx.client,
      factory,
      requestContract,
      latestBlock,
      blockRange: policy.eventScanBlockRange,
      maxLookbackBlocks: policy.eventScanMaxLookbackBlocks,
    });
  } catch (e) {
    ctx.logger.error(
      { err: e instanceof Error ? e.message : e, requestContract, factory },
      "A.1: role-events scan failed",
    );
    return Result.err(
      new UpstreamUnavailableError({
        message: `role-events scan failed: ${e instanceof Error ? e.message : "unknown"}`,
        status: 503,
      }),
    );
  }

  if (scanOutcome.kind === "tooOld") {
    return Result.ok({ kind: "tooOld", factory, owner });
  }
  return Result.ok({ kind: "resolved", factory, owner, holders: scanOutcome.holders });
}

/**
 * Materialises the §A.1 check entries from cached/freshly-fetched
 * on-chain data and the live policy. Pure: same input → same output,
 * so it can replay an old `A1OnChainData` against an updated policy
 * without re-touching the chain.
 */
function evaluateA1(
  data: A1OnChainData,
  chainId: number,
  policy: IntentRequestBindingPolicy,
  deadlineCheck: CheckEntry,
): readonly CheckEntry[] {
  if (data.kind === "noFactory") {
    return [
      failed(
        "request contract was deployed by an accepted factory",
        "no accepted factory recognises this contract as one of its deployments",
      ),
      skipped("owner of request contract is on the accepted-owners list"),
      skipped("puller role on request contract is held only by accepted parties"),
      skipped("consumer role on request contract is held only by accepted parties"),
      deadlineCheck,
    ];
  }

  // The cached factory must still be in the live accepted set.
  // Treating a removed-from-policy factory as a factory-mismatch keeps
  // the failure reason discoverable across policy mutations without a
  // forced flush.
  const accepted = policy.acceptedRequestFactories.get(chainId) ?? new Set<string>();
  const acceptedLower = new Set([...accepted].map((s) => s.toLowerCase()));
  if (!acceptedLower.has(data.factory.toLowerCase())) {
    return [
      failed(
        "request contract was deployed by an accepted factory",
        `previously-matched factory ${data.factory} is no longer in the accepted-factories list`,
      ),
      skipped("owner of request contract is on the accepted-owners list"),
      skipped("puller role on request contract is held only by accepted parties"),
      skipped("consumer role on request contract is held only by accepted parties"),
      deadlineCheck,
    ];
  }

  const factoryCheck = passed("request contract was deployed by an accepted factory");
  const ownerCheck = checkMembership({
    description: "owner of request contract is on the accepted-owners list",
    value: data.owner,
    accepted: policy.acceptedOwners.get(chainId) ?? new Set<string>(),
    addressLike: true,
  });

  let pullerCheck: CheckEntry;
  let consumerCheck: CheckEntry;
  if (data.kind === "tooOld") {
    pullerCheck = skipped("puller role on request contract is held only by accepted parties");
    consumerCheck = skipped("consumer role on request contract is held only by accepted parties");
  } else {
    pullerCheck = checkSubset({
      description: "puller role on request contract is held only by accepted parties",
      holders: holdersOf(data.holders, ROLE_PULLER),
      accepted: policy.acceptedPullers.get(chainId) ?? new Set<string>(),
    });
    consumerCheck = checkSubset({
      description: "consumer role on request contract is held only by accepted parties",
      holders: holdersOf(data.holders, ROLE_CONSUMER),
      accepted: policy.acceptedConsumers.get(chainId) ?? new Set<string>(),
    });
  }

  return [factoryCheck, ownerCheck, pullerCheck, consumerCheck, deadlineCheck];
}

/**
 * §A.1 / §A.4 helper: every member of `holders` MUST be a member of
 * `accepted` (case-insensitive). An empty `holders` set fails — the
 * request contract has no live role-holder, which the §A.1 spec treats
 * as misconfigured (the role exists for a reason, so SOMEBODY accepted
 * should hold it).
 */
function checkSubset(args: {
  description: string;
  holders: readonly Address[];
  accepted: ReadonlySet<string>;
}): CheckEntry {
  const { description, holders, accepted } = args;
  const acceptedLower = new Set([...accepted].map((s) => s.toLowerCase()));

  if (holders.length === 0) {
    return failed(description, "no live role-holder found in role-events scan");
  }
  const rogue = holders.filter((h) => !acceptedLower.has(h.toLowerCase()));
  if (rogue.length > 0) {
    return failed(description, `rogue role-holder(s): ${rogue.join(", ")}`);
  }
  return passed(description);
}

function rollupA1(
  checks: readonly CheckEntry[],
): Result<readonly CheckEntry[], CheckRunnerError<false>> {
  const r = rollUp(checks, "Appendix A.1 checks failed");
  return r.ok ? Result.ok(r.checks) : Result.err(r.error);
}
