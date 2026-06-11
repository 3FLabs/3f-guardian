import { Result } from "better-result";
import { ContractFunctionExecutionError, type Address, zeroAddress } from "viem";

import {
  type CheckEntry,
  type IntentFundBindingBody,
  type SigningContext,
  StateConflictError,
  UpstreamUnavailableError,
} from "@3flabs/guardian";

import { facilityAbi, fundAbi } from "../abi/index.js";
import {
  checkDeadline,
  checkMembership,
  failed,
  isDeterministicContractCallFailure,
  passed,
  rollUp,
  sanitizeErr,
  skipped,
} from "./helpers.js";
import type { CheckRunner, CheckRunnerError } from "./types.js";

/**
 * Per-chain accepted-funds + accepted-owners policy for §A.2.
 *
 *  - `acceptedFunds`  — the §11 ACCEPTED_FUNDS list, indexed by chainId.
 *  - `acceptedOwners` — the set of EOAs / multisigs allowed to own a fund
 *    contract on that chain. Applied uniformly: every accepted fund's
 *    `Ownable.owner()` must be on this set.
 *
 * Both sets are case-insensitive — entries are compared after lower-
 * casing both sides (see `checkMembership`'s `addressLike: true`).
 */
export type IntentFundBindingPolicy = {
  readonly maxDeadlineSecondsAhead: number;
  readonly acceptedFunds: ReadonlyMap<number, ReadonlySet<string>>;
  readonly acceptedOwners: ReadonlyMap<number, ReadonlySet<string>>;
};

/**
 * Builds the §A.2 fund-binding check runner.
 *
 * Performs the policy + on-chain checks the v1 spec calls out, in this
 * order (matches §6.4.1 emission):
 *
 *   1. deadline within MAX_DEADLINE_SECONDS_AHEAD of now           (422)
 *   2. fund contract is on the accepted-funds list                 (422)
 *   3. fund contract owner is on the accepted-owners list          (422)
 *   4. intent has no currently bound fund                          (409)
 *   5. fund holds DEPOSITOR_ROLE for the facility (skipped)        (—)
 *
 * Stage 1 multicall reads `fund.owner()` and `facility.getIntent(id)` in
 * a single round-trip — viem decodes each call to its ABI return type
 * via the `as const` contracts tuple. With `allowFailure: false` a
 * transport-level RPC failure throws and surfaces as
 * `UpstreamUnavailableError` (503), per §6.6. A DETERMINISTIC failure of
 * either read — `owner()` / `getIntent()` reverting or returning no data
 * because the client-supplied `fundContract` or `facility` is an EOA or
 * some unrelated contract — is instead a property of the request: it
 * fails the 422-class owner check (the read cannot prove an accepted
 * owner) and rolls up to `ValidationFailedError`.
 *
 * Per §6.6.1 the runner reports 422 if any 422-class check fails, even
 * when the 409 check (intent-has-no-current-fund) also fails. The 409
 * path is reached only when every 422-class entry passes.
 *
 * Two checks the spec discusses are intentionally omitted:
 *
 *  - Cross-intent collision ("fund is not bound to a different intent"):
 *    no efficient on-chain enumeration exists; the on-chain `setFund`
 *    call will revert anyway. Surfacing it pre-flight would only risk
 *    making the Guardian's view inconsistent with the chain.
 *
 *  - Proposed-fund internal-state cleanliness: `IFund` exposes only
 *    per-order `state(Order)`, not a free/busy getter, so we cannot
 *    cheaply ascertain that the proposed fund is idle without adding a
 *    new view to grunt. The on-chain `create()` path inside `setFund`
 *    will reject a busy fund — same fail-on-chain semantics as above.
 */
export function buildIntentFundBindingChecks(deps: {
  policy: IntentFundBindingPolicy;
}): CheckRunner<IntentFundBindingBody, true> {
  const { policy } = deps;

  return async (
    ctx: SigningContext,
    body: IntentFundBindingBody,
  ): Promise<Result<readonly CheckEntry[], CheckRunnerError<true>>> => {
    const { chainId, facility, intent, fundContract, deadline } = body;
    const intentId = BigInt(intent.id);

    const acceptedFunds = policy.acceptedFunds.get(chainId) ?? new Set<string>();
    const acceptedOwners = policy.acceptedOwners.get(chainId) ?? new Set<string>();

    const nowUnix = Math.floor(ctx.now.getTime() / 1000);
    const deadlineCheck = checkDeadline({
      nowUnixSeconds: nowUnix,
      deadline,
      maxSecondsAhead: policy.maxDeadlineSecondsAhead,
    });
    const fundOnList = checkMembership({
      description: "fund contract is on the accepted-funds list",
      value: fundContract,
      accepted: acceptedFunds,
      addressLike: true,
    });

    // Off-chain short-circuit: if the fund isn't on policy, on-chain
    // reads are meaningless. Emit `skipped:true` for every on-chain
    // entry so the response still describes Appendix A.2 in full.
    if (!fundOnList.passed) {
      const all: CheckEntry[] = [
        deadlineCheck,
        fundOnList,
        skipped("fund contract owner is on the accepted-owners list"),
        skipped("intent has no currently bound fund"),
        skipped("fund holds DEPOSITOR_ROLE for the facility"),
      ];
      const r = rollUp(all, "Appendix A.2 checks failed");
      return r.ok ? Result.ok(r.checks) : Result.err(r.error);
    }

    // ── Single multicall: independent reads ──────────────────────────
    // `as const` lets viem infer the per-call decoded type. With
    // `allowFailure: false`, results are the decoded values directly,
    // and any single revert / RPC failure throws — caught below.
    let stage1Results;
    try {
      stage1Results = await ctx.client.multicall({
        contracts: [
          { address: fundContract, abi: fundAbi, functionName: "owner" },
          { address: facility, abi: facilityAbi, functionName: "getIntent", args: [intentId] },
        ] as const,
        allowFailure: false,
      });
    } catch (e) {
      // A deterministic per-slot failure (revert / empty return data on
      // `owner()` or `getIntent()`) means a client-supplied address —
      // `fundContract` or `facility` — is an EOA or some unrelated
      // contract: a property of the request, not of the upstream's
      // health. Fail the 422-class owner check instead of reporting a
      // 503. Transport-level failures (RPC down, timeout, the aggregate3
      // call itself) keep the 503 path.
      if (isDeterministicContractCallFailure(e, ["owner", "getIntent"])) {
        ctx.logger.warn(
          { err: sanitizeErr(e), fundContract, facility, intentId: intent.id },
          "A.2: stage 1 read reverted or returned no data; treating as check failure",
        );
        const ownerReadFailed =
          e instanceof ContractFunctionExecutionError && e.functionName === "owner";
        const all: CheckEntry[] = [
          deadlineCheck,
          fundOnList,
          failed(
            "fund contract owner is on the accepted-owners list",
            ownerReadFailed
              ? `fund contract ${fundContract} did not answer owner() ` +
                  "(EOA or non-Ownable contract); owner could not be read deterministically"
              : `facility ${facility} did not answer getIntent(${intent.id}) ` +
                  "(EOA or non-facility contract); fund owner could not be read deterministically",
          ),
          skipped("intent has no currently bound fund"),
          skipped("fund holds DEPOSITOR_ROLE for the facility"),
        ];
        const r = rollUp(all, "Appendix A.2 checks failed");
        return r.ok ? Result.ok(r.checks) : Result.err(r.error);
      }
      ctx.logger.error(
        { err: sanitizeErr(e), fundContract, facility, intentId: intent.id },
        "A.2: stage 1 multicall failed",
      );
      return Result.err(
        new UpstreamUnavailableError({
          message: "fund-binding read failed upstream",
          status: 503,
        }),
      );
    }

    const [fundOwner, intentTuple] = stage1Results;
    const currentFund = intentTuple[1] as Address;

    const ownerCheck = checkMembership({
      description: "fund contract owner is on the accepted-owners list",
      value: fundOwner,
      accepted: acceptedOwners,
      addressLike: true,
    });

    // 409-class: the intent must have no currently bound fund. The
    // on-chain `setFund` will revert if a current fund exists, so this
    // check just makes the Guardian view consistent with the chain.
    const noCurrentFundCheck =
      currentFund === zeroAddress
        ? passed("intent has no currently bound fund")
        : failed(
            "intent has no currently bound fund",
            `intent ${intent.id} is currently bound to ${currentFund}; ` +
              `unbind (setFund(0,...)) before rebinding to a new fund`,
          );

    // Depositor-role check: not yet enforced. Emitted as `skipped:true`
    // (which counts as passed per §6.4.1) so the response advertises
    // §A.2 in full and operators can see it on the wire when they wire
    // it up later.
    const depositorRoleCheck = skipped("fund holds DEPOSITOR_ROLE for the facility");

    const all: readonly CheckEntry[] = [
      deadlineCheck,
      fundOnList,
      ownerCheck,
      noCurrentFundCheck,
      depositorRoleCheck,
    ];

    // §6.6.1: 422 wins over 409 when both fail.
    const class422 = [deadlineCheck, fundOnList, ownerCheck, depositorRoleCheck];
    if (class422.some((c) => !c.passed)) {
      const r = rollUp(all, "Appendix A.2 checks failed");
      return r.ok ? Result.ok(r.checks) : Result.err(r.error);
    }
    if (!noCurrentFundCheck.passed) {
      return Result.err(
        new StateConflictError({
          message: "Intent already has a fund bound (Appendix A.2)",
          checks: [...all],
        }),
      );
    }
    return Result.ok(all);
  };
}
