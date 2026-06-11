import { type Address, type PublicClient } from "viem";

import { requestAbi } from "../abi/request.js";
import { requestFactoryAbi } from "../abi/request-factory.js";

const rolesUpdatedEvent = requestAbi.find((x) => x.type === "event" && x.name === "RolesUpdated")!;
const requestCreatedEvent = requestFactoryAbi.find(
  (x) => x.type === "event" && x.name === "RequestCreated",
)!;

/**
 * Outcome of a role-events scan against a single (factory, request)
 * pair.
 *
 *  - `resolved` — we walked back far enough to observe the
 *    `RequestCreated` event for this request (or hit `fromBlock = 0`).
 *    `holders` is the replayed final state: every address with at least
 *    one role bit set (zero-roles entries are pruned).
 *
 *  - `tooOld` — we exhausted `maxLookbackBlocks` without seeing the
 *    deployment event. The role-holder map cannot be trusted as
 *    COMPLETE (we may have missed the initial `_grantRoles` from
 *    `initialize()`), so the caller MUST NOT use it to *pass* the role
 *    checks. `partialHolders` carries the replay of whatever
 *    `RolesUpdated` events fell inside the scanned window. It is sound
 *    one-sidedly: solady emits the full post-update bitfield, and the
 *    window's upper bound is `latestBlock`, so any holder observed in
 *    `partialHolders` definitively holds those roles right now. Callers
 *    may therefore use it to FAIL (a rogue grant was observed) but never
 *    to approve.
 *
 * Both outcomes are an Ok-result; transport / RPC failures are thrown
 * by the underlying viem call and surface to the runner as
 * `UpstreamUnavailableError`.
 */
export type RoleScanOutcome =
  | {
      readonly kind: "resolved";
      readonly holders: ReadonlyMap<Address, bigint>;
      readonly deploymentBlock: bigint;
    }
  | { readonly kind: "tooOld"; readonly partialHolders: ReadonlyMap<Address, bigint> };

type ChunkLog = {
  eventName: "RolesUpdated" | "RequestCreated";
  blockNumber: bigint;
  logIndex: number;
  args: { user?: Address; roles?: bigint; request?: Address };
};

/**
 * Walks the chain backwards in chunks of `blockRange` blocks, gathering
 * `RolesUpdated` events on `requestContract` and `RequestCreated`
 * events on `factory`. Stops as soon as the deployment event for this
 * `requestContract` is observed, or when `maxLookbackBlocks` worth of
 * history has been scanned (whichever comes first).
 *
 * Each chunk is a single `eth_getLogs` call with `address` restricted
 * to `[factory, requestContract]` and `topics[0]` filtered server-side
 * to the two event signatures via viem's typed `events` API. The
 * factory's `RequestCreated` event does not index `request`, so the
 * deployment match is decided client-side after viem decodes the args.
 *
 * Replays role state by setting `state[user] = roles` for every
 * `RolesUpdated` log, in increasing (block, logIndex) order — solady
 * emits the post-update full bitfield, not a delta, so the latest log
 * per user is authoritative.
 *
 * `deadlineMs` (optional) is a wall-clock budget for the whole scan:
 * once exceeded between chunks the scan throws, which the runner maps
 * to `UpstreamUnavailableError` (503). It bounds how long a single deep
 * scan can occupy a request handler. `now` is clock injection for
 * tests; defaults to `Date.now`.
 *
 * `signal` (optional) aborts the scan at the next chunk boundary —
 * callers wire the request's `SigningContext.signal` here so a request
 * whose `signMs` deadline already expired (the shell answered 503)
 * stops issuing `getLogs` instead of walking the chain in the
 * background. Like `deadlineMs`, abort surfaces as a thrown error the
 * runner maps to `UpstreamUnavailableError`.
 */
export async function scanRoleHolders(args: {
  readonly client: PublicClient;
  readonly factory: Address;
  readonly requestContract: Address;
  readonly latestBlock: bigint;
  readonly blockRange: bigint;
  readonly maxLookbackBlocks: bigint;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<RoleScanOutcome> {
  const { client, factory, requestContract, latestBlock, blockRange, maxLookbackBlocks } = args;
  const now = args.now ?? Date.now;

  if (blockRange <= 0n) throw new Error("blockRange must be positive");
  if (maxLookbackBlocks <= 0n) throw new Error("maxLookbackBlocks must be positive");
  if (args.deadlineMs !== undefined && (!Number.isFinite(args.deadlineMs) || args.deadlineMs < 0)) {
    throw new Error(`deadlineMs must be a non-negative finite number, got ${args.deadlineMs}`);
  }

  const earliestAllowed = latestBlock > maxLookbackBlocks ? latestBlock - maxLookbackBlocks : 0n;

  const requestContractLower = requestContract.toLowerCase();

  const allLogs: ChunkLog[] = [];

  const startedAt = now();
  let toBlock = latestBlock;
  let foundDeploymentBlock: bigint | undefined;
  let firstChunk = true;

  // Walk backwards. Each iteration scans [fromBlock, toBlock] inclusive.
  // Every chunk spans at most `blockRange` blocks — including the final
  // one, so providers with a hard getLogs range cap equal to the
  // configured range never see an over-sized request.
  while (toBlock >= earliestAllowed && foundDeploymentBlock === undefined) {
    if (args.signal?.aborted) {
      throw new Error(
        `role-events scan aborted by the request signal before reaching ` +
          `block ${earliestAllowed} (stopped above ${toBlock})`,
      );
    }
    if (!firstChunk && args.deadlineMs !== undefined && now() - startedAt > args.deadlineMs) {
      throw new Error(
        `role-events scan exceeded its ${args.deadlineMs}ms budget before reaching ` +
          `block ${earliestAllowed} (stopped above ${toBlock})`,
      );
    }
    firstChunk = false;
    const chunkStart = toBlock - blockRange + 1n;
    const fromBlock = chunkStart > earliestAllowed ? chunkStart : earliestAllowed;

    // oxlint-disable-next-line no-await-in-loop
    const logs = await client.getLogs({
      address: [factory, requestContract],
      events: [rolesUpdatedEvent, requestCreatedEvent],
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
      if (log.eventName === "RequestCreated") {
        const created = log.args.request;
        if (created && created.toLowerCase() === requestContractLower) {
          foundDeploymentBlock = log.blockNumber;
        }
      }
      allLogs.push({
        eventName: log.eventName as "RolesUpdated" | "RequestCreated",
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        args: log.args as { user?: Address; roles?: bigint; request?: Address },
      });
    }

    if (fromBlock === 0n || fromBlock === earliestAllowed) break;
    toBlock = fromBlock - 1n;
  }

  if (foundDeploymentBlock === undefined && earliestAllowed > 0n) {
    // We ran out of lookback budget without observing the deployment
    // event. The contract pre-existed the scan window — the caller MUST
    // NOT treat the role-holder map as complete (the initial role
    // grants may live in an earlier block we never read). We still
    // replay what we DID see: an in-window grant is definitively
    // current, so partial data can soundly fail a check.
    return { kind: "tooOld", partialHolders: replayRoleState(allLogs) };
  }

  return {
    kind: "resolved",
    holders: replayRoleState(allLogs),
    // If we never observed a RequestCreated event but earliestAllowed
    // is 0n, treat the genesis block as the deployment lower bound.
    deploymentBlock: foundDeploymentBlock ?? 0n,
  };
}

/**
 * Replays `RolesUpdated` logs into a final per-user bitfield map, in
 * ascending (block, logIndex) order — the latest log per user is
 * authoritative because solady emits the full post-update bitfield.
 * Zero-roles entries are pruned: they no longer hold any role and
 * should not appear in membership comparisons.
 *
 * RolesUpdated entries from BEFORE the deployment block are impossible
 * (the contract didn't exist), so every replayed event is
 * post-deployment by construction.
 */
function replayRoleState(logs: readonly ChunkLog[]): Map<Address, bigint> {
  const sorted = [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  const state = new Map<Address, bigint>();
  for (const log of sorted) {
    if (log.eventName !== "RolesUpdated") continue;
    const { user, roles } = log.args;
    if (user === undefined || roles === undefined) continue;
    state.set(user.toLowerCase() as Address, roles);
  }

  for (const [user, roles] of state) {
    if (roles === 0n) state.delete(user);
  }
  return state;
}

/**
 * Given a replayed role-holder map and the role-bit mask, return the
 * subset of holders whose roles include the mask. Returned addresses
 * are lower-cased — comparisons against accepted-address sets MUST
 * lower-case both sides.
 */
export function holdersOf(
  holders: ReadonlyMap<Address, bigint>,
  roleMask: bigint,
): readonly Address[] {
  const out: Address[] = [];
  for (const [user, roles] of holders) {
    if ((roles & roleMask) !== 0n) out.push(user);
  }
  return out;
}
