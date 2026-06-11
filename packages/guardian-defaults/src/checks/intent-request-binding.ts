import { Result } from "better-result";
import { isAddress, type Address } from "viem";
import { z } from "zod";

import {
  type CheckEntry,
  type IntentRequestBindingBody,
  type SigningContext,
  UpstreamUnavailableError,
} from "@3flabs/guardian";

import type { StandardSchemaV1 } from "../cache/standard-schema.js";
import type { AsyncCache } from "../cache/types.js";
import { requestAbi, ROLE_CONSUMER, ROLE_PULLER } from "../abi/request.js";
import { requestFactoryAbi } from "../abi/request-factory.js";
import {
  checkDeadline,
  checkMembership,
  failed,
  isDeterministicContractCallFailure,
  isMulticallChunkFailure,
  passed,
  rollUp,
  skipped,
} from "./helpers.js";
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
 *    `latestBlock - this`, the scan outcome is "too old": we cannot
 *    prove the holder set is complete. Partial in-window data is still
 *    used one-sidedly — any rogue grant OBSERVED inside the window
 *    fails the puller / consumer checks — and the residual disposition
 *    is governed by `onLookbackExhausted`.
 *
 *  - `eventScanDeadlineMs` — optional wall-clock budget for a single
 *    role-events scan. When exceeded the scan aborts and surfaces as
 *    `UpstreamUnavailableError` (503), so a deep scan cannot hold a
 *    request handler indefinitely. Omitted = no time budget (the scan
 *    is still bounded by `eventScanMaxLookbackBlocks`).
 *
 *  - `onLookbackExhausted` — what to do with the puller / consumer
 *    checks when the scan exhausts the lookback window WITHOUT
 *    observing a rogue in-window grant. `"skip"` (default) emits them
 *    as `skipped:true`, preserving availability for mature contracts;
 *    `"fail"` fails closed (422) — security-sensitive operators that
 *    would rather reject than sign without role-holder verification
 *    should opt into this.
 */
export type IntentRequestBindingPolicy = {
  readonly maxDeadlineSecondsAhead: number;
  readonly acceptedRequestFactories: ReadonlyMap<number, ReadonlySet<string>>;
  readonly acceptedOwners: ReadonlyMap<number, ReadonlySet<string>>;
  readonly acceptedPullers: ReadonlyMap<number, ReadonlySet<string>>;
  readonly acceptedConsumers: ReadonlyMap<number, ReadonlySet<string>>;
  readonly eventScanBlockRange: bigint;
  readonly eventScanMaxLookbackBlocks: bigint;
  readonly eventScanDeadlineMs?: number;
  readonly onLookbackExhausted?: "skip" | "fail";
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
 *    deployment. `partialHolders` is the replay of the `RolesUpdated`
 *    events that fell INSIDE the scanned window: it may only push the
 *    role checks toward failure (an observed non-accepted holder),
 *    never toward a pass. The field is optional so stale cross-process
 *    cache entries written by older package versions still
 *    deserialise; absence is treated as an empty map. Without an
 *    observed rogue holder the role checks follow the policy's
 *    `onLookbackExhausted` disposition on every replay until the cache
 *    expires.
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
  | {
      readonly kind: "tooOld";
      readonly factory: Address;
      readonly owner: Address;
      readonly partialHolders?: ReadonlyMap<Address, bigint>;
    }
  | {
      readonly kind: "resolved";
      readonly factory: Address;
      readonly owner: Address;
      readonly holders: ReadonlyMap<Address, bigint>;
    };

const zCachedAddress = z.custom<Address>(
  (v) => typeof v === "string" && isAddress(v, { strict: false }),
  "expected an EVM address",
);
const zCachedHolders = z.map(zCachedAddress, z.bigint());

/**
 * Schema for {@link A1OnChainData} — pass it to an `AsyncCache`
 * constructor (e.g. `inMemoryCache(zA1OnChainData, { … })`) so every
 * cache hit is re-validated on read: an entry written by an older
 * package version, truncated by a transport adapter, or hand-edited in
 * a shared store parses as a MISS and triggers a fresh on-chain fetch
 * instead of feeding the §A.1 evaluation corrupt data.
 *
 * The schema validates the in-memory domain shape (`Map` keys/values,
 * `bigint` bitfields). Cross-process adapters that JSON-serialise must
 * revive `Map` ↔ entries and `bigint` ↔ `string` in their `rawGet` /
 * `set` BEFORE the schema sees the value, per the `AsyncCache`
 * contract.
 */
export const zA1OnChainData = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("noFactory") }),
  z.object({
    kind: z.literal("tooOld"),
    factory: zCachedAddress,
    owner: zCachedAddress,
    partialHolders: zCachedHolders.optional(),
  }),
  z.object({
    kind: z.literal("resolved"),
    factory: zCachedAddress,
    owner: zCachedAddress,
    holders: zCachedHolders,
  }),
]) satisfies StandardSchemaV1<unknown, A1OnChainData>;

/**
 * Dependencies for the §A.1 runner. Sharable with §A.4
 * (`buildRequestWhitelistingChecks`) which delegates per-contract
 * checks to {@link runA1}.
 *
 *  - `cache` — optional {@link AsyncCache} keyed by
 *    `${chainId}:${requestContract.toLowerCase()}`, constructed with
 *    {@link zA1OnChainData} (e.g. `inMemoryCache(zA1OnChainData)`). If
 *    supplied, hit skips the entire on-chain fetch (multicall +
 *    getBlockNumber + log scan). On miss the runner fetches and writes
 *    the result back.
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
 * Stage 1 — single multicall (`allowFailure: true`):
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
 *   - "Too old" outcome → role checks fail (422) if a rogue grant was
 *     observed inside the scanned window, otherwise follow the
 *     policy's `onLookbackExhausted` disposition (default: skipped).
 *
 * Stage 1 uses `allowFailure: true` so each slot is classified on its
 * own. A transport-level RPC failure (the aggregate3 call itself)
 * surfaces as `UpstreamUnavailableError` (503), per §6.6. A
 * DETERMINISTIC failure of the client-attributable `owner()` slot —
 * reverting or returning no data because the client-supplied
 * `requestContract` is an EOA or some unrelated contract — is instead
 * classified as `noFactory` (an EOA is by definition not "deployed by
 * an accepted factory"), which is cached and rolls up to a 422 check
 * failure. A deterministic failure of an OPERATOR-configured factory's
 * `isRequest()` slot is a configuration error, not a client error: the
 * slot is treated as a non-match and logged at error level, and if no
 * healthy factory matches either the request fails 503 (never cached)
 * so the misconfiguration stays an operator-visible alarm instead of a
 * chain-wide stream of client-blamed 422s.
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
  //
  // `allowFailure: true` so each slot is classified independently: a
  // deterministic failure of the client-supplied contract's `owner()`
  // is the client's fault (noFactory, 422), but a deterministic failure
  // of an OPERATOR-configured factory's `isRequest()` must never be —
  // otherwise one misconfigured factory entry (EOA / wrong contract)
  // would silently convert every request on the chain into a cached
  // client-blamed 422.
  type Stage1Slot<T> = { status: "success"; result: T } | { status: "failure"; error: Error };
  let stage1Results: readonly [Stage1Slot<Address>, ...Stage1Slot<boolean>[]];
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
      allowFailure: true,
    })) as unknown as readonly [Stage1Slot<Address>, ...Stage1Slot<boolean>[]];
  } catch (e) {
    // Synchronous setup failure (multicall3 address not configured for
    // the chain, results-length mismatch). Transport failures do NOT
    // land here under `allowFailure: true` — they surface as per-slot
    // failures with `functionName: "aggregate3"`, handled in the slot
    // branches below. Keep the 503 path; never cached.
    ctx.logger.error(
      { err: e instanceof Error ? e.message : e, requestContract },
      "A.1: stage 1 multicall failed",
    );
    return Result.err(
      new UpstreamUnavailableError({
        message: "request-contract read failed upstream",
        status: 503,
      }),
    );
  }

  const ownerSlot = stage1Results[0];
  if (ownerSlot.status === "failure") {
    // A deterministic failure of `owner()` (revert / empty return data)
    // means the client-supplied contract is an EOA or some unrelated
    // contract: it cannot have been deployed by an accepted factory.
    // Classify as `noFactory` (cached, 422) instead of polluting
    // upstream-health signals with a 503. Anything unclassifiable keeps
    // the 503 path and is never cached.
    if (isDeterministicContractCallFailure(ownerSlot.error, ["owner"])) {
      ctx.logger.warn(
        { err: ownerSlot.error.message, requestContract },
        "A.1: owner() reverted or returned no data; treating as noFactory",
      );
      return Result.ok({ kind: "noFactory" });
    }
    ctx.logger.error(
      { err: ownerSlot.error.message, requestContract },
      isMulticallChunkFailure(ownerSlot.error)
        ? "A.1: stage 1 multicall failed upstream (transport)"
        : "A.1: owner() read failed",
    );
    return Result.err(
      new UpstreamUnavailableError({
        message: "request-contract read failed upstream",
        status: 503,
      }),
    );
  }
  const owner = ownerSlot.result;

  const factoryHits: Address[] = [];
  const failedFactories: Address[] = [];
  for (const [i, factory] of factoriesArr.entries()) {
    const slot = stage1Results[i + 1]!;
    if (slot.status === "failure") {
      // The factory address comes from OPERATOR configuration, not from
      // the client. A deterministic failure here (EOA / non-factory
      // contract) is a deploy-time config error: log it loudly and
      // treat the slot as a non-match so a healthy factory in the same
      // set can still recognise the contract. A chunk-level failure
      // (the aggregate3 call itself) is upstream health, not operator
      // config — log it without the configuration hint.
      ctx.logger.error(
        { err: slot.error.message, factory, requestContract },
        isMulticallChunkFailure(slot.error)
          ? "A.1: factory isRequest() read failed upstream (transport)"
          : "A.1: accepted factory did not answer isRequest(); " +
              "check the acceptedRequestFactories configuration",
      );
      failedFactories.push(factory);
      continue;
    }
    if (slot.result === true) factoryHits.push(factory);
  }

  if (factoryHits.length === 0) {
    if (failedFactories.length > 0) {
      // Without a definitive answer from every configured factory we
      // cannot distinguish "no factory deployed this contract" (client
      // error, cacheable) from "the factory that DID deploy it is the
      // one we failed to read". Fail 503 so the misconfiguration stays
      // an operator-visible alarm and the wrong `noFactory` answer is
      // never amortised by the cache.
      return Result.err(
        new UpstreamUnavailableError({
          message: "accepted-factory read failed upstream",
          status: 503,
        }),
      );
    }
    return Result.ok({ kind: "noFactory" });
  }

  // Pick the (sole) factory that returned true. If multiple did
  // (configuration error), pick the first deterministically.
  const factory = factoryHits[0]!;

  // ── Stage 2: role-events scan ────────────────────────────────────
  let latestBlock: bigint;
  try {
    // `cacheTime: 0` forces an uncached eth_blockNumber. viem caches
    // getBlockNumber results for `cacheTime` (default: the client's
    // pollingInterval, 4s), and a stale cached block number must never
    // bound a security scan: grants mined inside the cached window
    // would be invisible to the replay (fail-open for rogue grants),
    // and a freshly-deployed contract's events would be missed
    // entirely (spurious 422s).
    latestBlock = await ctx.client.getBlockNumber({ cacheTime: 0 });
  } catch (e) {
    ctx.logger.error({ err: e instanceof Error ? e.message : e }, "A.1: getBlockNumber failed");
    return Result.err(
      new UpstreamUnavailableError({
        message: "getBlockNumber failed upstream",
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
      deadlineMs: policy.eventScanDeadlineMs,
      // Abort at the next chunk boundary once the shell's signMs
      // deadline has expired — the caller already got a 503, so the
      // scan must not keep walking the chain in the background (each
      // client retry would stack another full concurrent scan).
      signal: ctx.signal,
    });
  } catch (e) {
    ctx.logger.error(
      { err: e instanceof Error ? e.message : e, requestContract, factory },
      "A.1: role-events scan failed",
    );
    return Result.err(
      new UpstreamUnavailableError({
        message: "role-events scan failed upstream",
        status: 503,
      }),
    );
  }

  if (scanOutcome.kind === "tooOld") {
    return Result.ok({
      kind: "tooOld",
      factory,
      owner,
      partialHolders: scanOutcome.partialHolders,
    });
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
    // The scan window did not reach deployment, so the holder map is
    // incomplete — partial data may only strengthen the checks toward
    // REJECTION (an in-window grant is definitively current), never
    // toward approval. `partialHolders` is optional for compatibility
    // with cache entries written before it existed.
    const partial = data.partialHolders ?? new Map<Address, bigint>();
    const disposition = policy.onLookbackExhausted ?? "skip";
    pullerCheck = checkPartialHolders({
      description: "puller role on request contract is held only by accepted parties",
      holders: holdersOf(partial, ROLE_PULLER),
      accepted: policy.acceptedPullers.get(chainId) ?? new Set<string>(),
      disposition,
    });
    consumerCheck = checkPartialHolders({
      description: "consumer role on request contract is held only by accepted parties",
      holders: holdersOf(partial, ROLE_CONSUMER),
      accepted: policy.acceptedConsumers.get(chainId) ?? new Set<string>(),
      disposition,
    });
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

/**
 * One-sided variant of {@link checkSubset} for the "too old" outcome,
 * where `holders` is only the PARTIAL state observed inside the scan
 * window. An empty set means "no evidence", not "no holder" (grants may
 * predate the window), so it does NOT fail on emptiness and it never
 * passes — it fails iff a non-accepted holder was observed, and
 * otherwise follows the policy's `onLookbackExhausted` disposition.
 */
function checkPartialHolders(args: {
  description: string;
  holders: readonly Address[];
  accepted: ReadonlySet<string>;
  disposition: "skip" | "fail";
}): CheckEntry {
  const { description, holders, accepted, disposition } = args;
  const acceptedLower = new Set([...accepted].map((s) => s.toLowerCase()));

  const rogue = holders.filter((h) => !acceptedLower.has(h.toLowerCase()));
  if (rogue.length > 0) {
    return failed(
      description,
      `rogue role-holder(s) observed within the lookback window: ${rogue.join(", ")}`,
    );
  }
  if (disposition === "fail") {
    return failed(
      description,
      "role-events scan exhausted eventScanMaxLookbackBlocks without observing deployment; " +
        "policy onLookbackExhausted=fail rejects unverifiable role-holder sets",
    );
  }
  return skipped(description);
}

function rollupA1(
  checks: readonly CheckEntry[],
): Result<readonly CheckEntry[], CheckRunnerError<false>> {
  const r = rollUp(checks, "Appendix A.1 checks failed");
  return r.ok ? Result.ok(r.checks) : Result.err(r.error);
}
