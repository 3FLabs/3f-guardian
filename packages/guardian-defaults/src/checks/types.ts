import type { Result } from "better-result";

import type {
  CheckEntry,
  SigningContext,
  StateConflictError,
  UpstreamUnavailableError,
  ValidationFailedError,
} from "@3flabs/guardian";

/**
 * Errors a check runner may emit. The host's `ValidateAndSign`
 * function maps these (or augments with its own) before returning to
 * the shell.
 *
 * Per Appendix A, only the §A.2 fund-state check yields
 * `StateConflictError`; the other endpoints' runners are typed
 * `CheckRunnerError<false>` to make this statically obvious.
 */
export type CheckRunnerError<WithStateConflict extends boolean = false> =
  | ValidationFailedError
  | UpstreamUnavailableError
  | (WithStateConflict extends true ? StateConflictError : never);

/**
 * A `CheckRunner` evaluates the per-endpoint Appendix-A checks against
 * `body` + `ctx` (which carries the chain client + wall-clock + logger)
 * and returns either:
 *
 *  - `Ok(checks)` — all entries are `passed:true` (skipped counts as
 *    passed); the host then builds the typed-data payload, calls
 *    `ctx.signTypedData`, and assembles the §6.4 SigningSuccess.
 *  - `Err(...)`   — one or more entries failed; the host propagates the
 *    error verbatim (it already carries the populated `checks` array).
 */
export type CheckRunner<TBody, WithStateConflict extends boolean = false> = (
  ctx: SigningContext,
  body: TBody,
) => Promise<Result<readonly CheckEntry[], CheckRunnerError<WithStateConflict>>>;
