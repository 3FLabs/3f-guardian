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
 *    deployment event. The role-holder map cannot be trusted (we may
 *    have missed the initial `_grantRoles` from `initialize()`), so the
 *    caller MUST emit the puller/consumer entries as `skipped:true`.
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
  | { readonly kind: "tooOld" };

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
 */
export async function scanRoleHolders(args: {
  readonly client: PublicClient;
  readonly factory: Address;
  readonly requestContract: Address;
  readonly latestBlock: bigint;
  readonly blockRange: bigint;
  readonly maxLookbackBlocks: bigint;
}): Promise<RoleScanOutcome> {
  const { client, factory, requestContract, latestBlock, blockRange, maxLookbackBlocks } = args;

  if (blockRange <= 0n) throw new Error("blockRange must be positive");
  if (maxLookbackBlocks <= 0n) throw new Error("maxLookbackBlocks must be positive");

  const earliestAllowed = latestBlock > maxLookbackBlocks ? latestBlock - maxLookbackBlocks : 0n;

  const requestContractLower = requestContract.toLowerCase();

  type ChunkLog = {
    eventName: "RolesUpdated" | "RequestCreated";
    blockNumber: bigint;
    logIndex: number;
    args: { user?: Address; roles?: bigint; request?: Address };
  };
  const allLogs: ChunkLog[] = [];

  let toBlock = latestBlock;
  let foundDeploymentBlock: bigint | undefined;

  // Walk backwards. Each iteration scans [fromBlock, toBlock] inclusive.
  while (toBlock >= earliestAllowed && foundDeploymentBlock === undefined) {
    const fromBlock =
      toBlock > earliestAllowed + blockRange ? toBlock - blockRange + 1n : earliestAllowed;

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
    // event. The contract pre-existed the scan window — caller MUST
    // skip the role checks because the initial role grants may live in
    // an earlier block we never read.
    return { kind: "tooOld" };
  }

  // Replay in ascending (block, logIndex) order. Note: we accept that
  // RolesUpdated entries from BEFORE foundDeploymentBlock are
  // impossible (the contract didn't exist), so all remaining
  // RolesUpdated events are post-deployment.
  allLogs.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  const state = new Map<Address, bigint>();
  for (const log of allLogs) {
    if (log.eventName !== "RolesUpdated") continue;
    const { user, roles } = log.args;
    if (user === undefined || roles === undefined) continue;
    state.set(user.toLowerCase() as Address, roles);
  }

  // Prune entries with zero roles — they no longer hold any role and
  // should not appear in membership comparisons.
  for (const [user, roles] of state) {
    if (roles === 0n) state.delete(user);
  }

  return {
    kind: "resolved",
    holders: state,
    // If we never observed a RequestCreated event but earliestAllowed
    // is 0n, treat the genesis block as the deployment lower bound.
    deploymentBlock: foundDeploymentBlock ?? 0n,
  };
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
