import { Result } from "better-result";

import {
  type IntentFundBindingBody,
  StateConflictError,
  UpstreamUnavailableError,
} from "@3flabs/guardian";
import type { CheckEntry, SigningContext } from "@3flabs/guardian";

import { checkDeadline, checkMembership, failed, passed, skipped, rollUp } from "./helpers.js";
import type { CheckRunner, CheckRunnerError } from "./types.js";

/**
 * Per-chain accepted-funds + role policy (§11). The role and
 * collateral lookups are protocol-specific and provided via the
 * `FundContractReader` adapter port.
 */
export type IntentFundBindingPolicy = {
  readonly maxDeadlineSecondsAhead: number;
  /** §11 ACCEPTED_FUNDS, keyed by chainId. */
  readonly acceptedFunds: ReadonlyMap<number, ReadonlySet<string>>;
};

/**
 * Adapter port for protocol-specific reads on the fund contract.
 *
 *  - `readHasActiveOrders` MUST return true iff the fund currently
 *    holds any non-final orders that would be invalidated by a binding
 *    transition. The result drives the only 409-class check in v1.
 *  - `readHoldsRequiredRoles` is a single boolean: the fund either
 *    holds every role policy requires, or it doesn't. Granular role
 *    enumeration is out of scope; the host's adapter is expected to
 *    encapsulate the AND of per-role checks.
 *  - `readPresentOnExternalRegistry` MAY return `null` for funds whose
 *    adapter does not require an external registry check; the runner
 *    then emits a `skipped:true` entry per Appendix A.2.
 *  - `readPositionManagerCollateralMatches` returns true iff the bound
 *    collateral on `positionManager` matches the policy for this fund.
 *    The "policy for this fund" is encapsulated in the adapter — the
 *    runner does not see the expected collateral list.
 */
export type FundContractReader = {
  readonly readHasActiveOrders: (ctx: SigningContext, fundContract: string) => Promise<boolean>;
  readonly readHoldsRequiredRoles: (ctx: SigningContext, fundContract: string) => Promise<boolean>;
  readonly readPresentOnExternalRegistry: (
    ctx: SigningContext,
    fundContract: string,
  ) => Promise<boolean | null>;
  readonly readPositionManagerCollateralMatches: (
    ctx: SigningContext,
    args: { fundContract: string; positionManager: string },
  ) => Promise<boolean>;
};

/**
 * Builds the §A.2 check runner.
 *
 * The fund-state check is the only 409-class check in v1. Per §6.6.1,
 * 422 wins when both classes fail in the same request. The runner
 * therefore:
 *
 *   1. Evaluates every check (no early termination on 409).
 *   2. If ANY 422-class check failed → returns
 *      `Err(ValidationFailedError({ checks }))` with all entries.
 *   3. Else if the 409-class check failed → returns
 *      `Err(StateConflictError({ checks }))` with all entries
 *      (per the spec, `checks` MAY be present on 409 responses).
 *   4. Else → `Ok(checks)`.
 *
 * RPC failures bubble out as `UpstreamUnavailableError` immediately.
 */
export function buildIntentFundBindingChecks(deps: {
  policy: IntentFundBindingPolicy;
  reader: FundContractReader;
}): CheckRunner<IntentFundBindingBody, true> {
  const { policy, reader } = deps;

  return async (ctx, body): Promise<Result<readonly CheckEntry[], CheckRunnerError<true>>> => {
    const { chainId, fundContract, positionManager, deadline } = body;
    const accepted = policy.acceptedFunds.get(chainId) ?? new Set<string>();
    const fundOnList = checkMembership({
      description: "fund contract is on the accepted-funds list",
      value: fundContract,
      accepted,
      addressLike: true,
    });

    // If fund is not on policy, on-chain reads are meaningless. Emit
    // skipped entries for the contract-state checks and return.
    if (!fundOnList.passed) {
      const checks: CheckEntry[] = [
        fundOnList,
        skipped("fund is in a state compatible with binding (no active orders)"),
        skipped("fund holds the roles required by policy"),
        skipped("fund is present on the applicable external registry"),
        skipped("position manager bound collateral matches policy"),
        checkDeadline({
          nowUnixSeconds: Math.floor(ctx.now.getTime() / 1000),
          deadline,
          maxSecondsAhead: policy.maxDeadlineSecondsAhead,
        }),
      ];
      const r = rollUp(checks, "Appendix A.2 checks failed");
      return r.ok ? Result.ok(r.checks) : Result.err(r.error);
    }

    let hasActiveOrders: boolean;
    let holdsRoles: boolean;
    let onRegistry: boolean | null;
    let collateralOk: boolean;
    try {
      [hasActiveOrders, holdsRoles, onRegistry, collateralOk] = await Promise.all([
        reader.readHasActiveOrders(ctx, fundContract),
        reader.readHoldsRequiredRoles(ctx, fundContract),
        reader.readPresentOnExternalRegistry(ctx, fundContract),
        reader.readPositionManagerCollateralMatches(ctx, { fundContract, positionManager }),
      ]);
    } catch (e) {
      ctx.logger.error(
        { err: e instanceof Error ? e.message : e, fundContract },
        "A.2: on-chain read failed",
      );
      return Result.err(
        new UpstreamUnavailableError({
          message: `fund-contract read failed: ${e instanceof Error ? e.message : "unknown"}`,
          status: 503,
        }),
      );
    }

    const stateCheck = hasActiveOrders
      ? failed(
          "fund is in a state compatible with binding (no active orders)",
          "fund has active orders; retry after they clear",
        )
      : passed("fund is in a state compatible with binding (no active orders)");

    const rolesCheck = holdsRoles
      ? passed("fund holds the roles required by policy")
      : failed(
          "fund holds the roles required by policy",
          "fund is missing one or more policy-required roles",
        );

    const registryCheck =
      onRegistry === null
        ? skipped("fund is present on the applicable external registry")
        : onRegistry
          ? passed("fund is present on the applicable external registry")
          : failed(
              "fund is present on the applicable external registry",
              "fund not present on the configured external registry",
            );

    const collateralCheck = collateralOk
      ? passed("position manager bound collateral matches policy")
      : failed(
          "position manager bound collateral matches policy",
          "position manager bound collateral does not match policy for this fund",
        );

    const deadlineCheck = checkDeadline({
      nowUnixSeconds: Math.floor(ctx.now.getTime() / 1000),
      deadline,
      maxSecondsAhead: policy.maxDeadlineSecondsAhead,
    });

    const all: readonly CheckEntry[] = [
      fundOnList,
      stateCheck,
      rolesCheck,
      registryCheck,
      collateralCheck,
      deadlineCheck,
    ];

    // Partition: 422-class is everything except the fund-state check.
    const class422 = [fundOnList, rolesCheck, registryCheck, collateralCheck, deadlineCheck];
    const any422Failed = class422.some((c) => !c.passed);
    if (any422Failed) {
      const r = rollUp(all, "Appendix A.2 checks failed");
      // r.ok is false because at least one 422 failed.
      return r.ok ? Result.ok(r.checks) : Result.err(r.error);
    }

    if (!stateCheck.passed) {
      return Result.err(
        new StateConflictError({
          message: "Fund state incompatible with binding (Appendix A.2)",
          checks: [...all],
        }),
      );
    }

    return Result.ok(all);
  };
}
