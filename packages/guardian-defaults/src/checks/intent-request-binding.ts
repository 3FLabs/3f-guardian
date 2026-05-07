import { Result } from "better-result";
import { type Address } from "viem";

import {
  type CheckEntry,
  type IntentRequestBindingBody,
  type SigningContext,
  UpstreamUnavailableError,
} from "@3flabs/guardian";

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
 */
export function buildIntentRequestBindingChecks(deps: {
  policy: IntentRequestBindingPolicy;
}): CheckRunner<IntentRequestBindingBody, false> {
  const { policy } = deps;
  return async (
    ctx: SigningContext,
    body: IntentRequestBindingBody,
  ): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> => {
    return runA1(ctx, body, policy);
  };
}

/**
 * Internal worker shared with the §A.4 whitelist-book runner so its
 * `operation = "whitelist"` branch can apply A.1 to each request
 * contract without re-implementing the on-chain reads.
 */
export async function runA1(
  ctx: SigningContext,
  body: { chainId: number; requestContract: Address; deadline: number },
  policy: IntentRequestBindingPolicy,
): Promise<Result<readonly CheckEntry[], CheckRunnerError<false>>> {
  const { chainId, requestContract, deadline } = body;
  const acceptedFactories = policy.acceptedRequestFactories.get(chainId) ?? new Set<string>();
  const factoriesArr = [...acceptedFactories].map((f) => f as Address);

  const nowUnix = Math.floor(ctx.now.getTime() / 1000);
  const deadlineCheck = checkDeadline({
    nowUnixSeconds: nowUnix,
    deadline,
    maxSecondsAhead: policy.maxDeadlineSecondsAhead,
  });

  // ── Stage 1: independent multicall ───────────────────────────────
  // request.owner() + factory.isRequest(...) for each accepted factory.
  // The contracts array has heterogeneous shapes (one owner read, then
  // a dynamic-length array of factory reads), which defeats viem's
  // const-tuple inference. We type-erase the contracts param and cast
  // the results — runtime decoding is unaffected.
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
  // The remaining results align with `factoriesArr` index-for-index.
  const factoryHits = factoriesArr
    .map((factory, i) => ({ factory, isRequest: stage1Results[i + 1] === true }))
    .filter((h) => h.isRequest);
  const factoryCheck =
    factoryHits.length > 0
      ? passed("request contract was deployed by an accepted factory")
      : failed(
          "request contract was deployed by an accepted factory",
          `no accepted factory recognises ${requestContract} as one of its deployments`,
        );

  // If no factory recognises this request: skip every other on-chain
  // entry. Owner / role checks are meaningless against an unknown
  // contract.
  if (!factoryCheck.passed) {
    const all: CheckEntry[] = [
      factoryCheck,
      skipped("owner of request contract is on the accepted-owners list"),
      skipped("puller role on request contract is held only by accepted parties"),
      skipped("consumer role on request contract is held only by accepted parties"),
      deadlineCheck,
    ];
    return rollupA1(all);
  }

  // Pick the (sole) factory that returned true. If multiple did
  // (configuration error), pick the first deterministically.
  const factory = factoryHits[0]!.factory;

  const ownerCheck = checkMembership({
    description: "owner of request contract is on the accepted-owners list",
    value: owner,
    accepted: policy.acceptedOwners.get(chainId) ?? new Set<string>(),
    addressLike: true,
  });

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

  let pullerCheck: CheckEntry;
  let consumerCheck: CheckEntry;
  if (scanOutcome.kind === "tooOld") {
    pullerCheck = skipped("puller role on request contract is held only by accepted parties");
    consumerCheck = skipped("consumer role on request contract is held only by accepted parties");
  } else {
    pullerCheck = checkSubset({
      description: "puller role on request contract is held only by accepted parties",
      holders: holdersOf(scanOutcome.holders, ROLE_PULLER),
      accepted: policy.acceptedPullers.get(chainId) ?? new Set<string>(),
    });
    consumerCheck = checkSubset({
      description: "consumer role on request contract is held only by accepted parties",
      holders: holdersOf(scanOutcome.holders, ROLE_CONSUMER),
      accepted: policy.acceptedConsumers.get(chainId) ?? new Set<string>(),
    });
  }

  return rollupA1([factoryCheck, ownerCheck, pullerCheck, consumerCheck, deadlineCheck]);
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
