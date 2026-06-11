import { UpstreamUnavailableError } from "../errors/tagged.js";
import type { Logger } from "./logger.js";

/**
 * Optional per-call deadlines (milliseconds) for the host-supplied async
 * abstractions. Missing fields fall back to
 * {@link DEFAULT_GUARDIAN_TIMEOUTS}.
 *
 * On expiry the shell responds `503 upstream_unavailable` and aborts the
 * `AbortSignal` it forwarded to the abstraction; the host promise itself
 * keeps running (the shell cannot cancel it), so implementations SHOULD
 * honour the signal to stop consuming resources.
 *
 * The idle-timeout constraint on these values is CUMULATIVE, not
 * per-call: the deadlines apply sequentially on one request, so the
 * worst-case SUM that can hit a single signing request
 * (`authenticateMs + rateLimitMs + signMs`) must stay below the HTTP
 * server's idle timeout (Bun.serve defaults to 10 s), otherwise the
 * socket is reset before the 503 envelope can be written. The defaults
 * compose to 9 s; hosts raising any deadline past that budget SHOULD
 * also raise `idleTimeout` in their `.listen()` options (Bun.serve
 * accepts up to 255 s).
 */
export type GuardianTimeouts = {
  /** Deadline for `authenticate(token)`. Default 2 000 ms. */
  readonly authenticateMs?: number;
  /** Deadline for `accountRateLimit(tokenInfo)`. Default 1 000 ms. */
  readonly rateLimitMs?: number;
  /** Deadline for `liveness()` (GET /health). Default 5 000 ms. */
  readonly livenessMs?: number;
  /** Deadline for a whole `sign*` validate-and-sign call. Default 6 000 ms. */
  readonly signMs?: number;
};

/**
 * Conservative defaults for {@link GuardianTimeouts}. Chosen so the
 * worst-case sequential composition on one request (authenticate +
 * accountRateLimit + sign = 9 s) stays under Bun.serve's default 10 s
 * idle timeout — see the cumulative constraint on
 * {@link GuardianTimeouts}.
 */
export const DEFAULT_GUARDIAN_TIMEOUTS = {
  authenticateMs: 2_000,
  rateLimitMs: 1_000,
  livenessMs: 5_000,
  signMs: 6_000,
} as const satisfies Required<GuardianTimeouts>;

export type ResolvedGuardianTimeouts = Required<GuardianTimeouts>;

/**
 * Merge host overrides over {@link DEFAULT_GUARDIAN_TIMEOUTS}.
 *
 * Overrides are validated loudly: `setTimeout` clamps NaN / 0 / negative
 * delays to 0, so a misconfigured deadline would time every abstraction
 * call out instantly and turn the whole service into 503s. Rejecting at
 * construction matches the `inMemoryRateLimiter` / `inMemoryCache`
 * semantics in guardian-defaults.
 */
export function resolveGuardianTimeouts(overrides?: GuardianTimeouts): ResolvedGuardianTimeouts {
  const resolved: { -readonly [K in keyof ResolvedGuardianTimeouts]: number } = {
    ...DEFAULT_GUARDIAN_TIMEOUTS,
  };
  for (const key of Object.keys(DEFAULT_GUARDIAN_TIMEOUTS) as (keyof ResolvedGuardianTimeouts)[]) {
    const value = overrides?.[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(
        `guardian: timeouts.${key} must be a positive finite number, got ${value}`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Bound a host-abstraction call with a deadline.
 *
 * `run` receives an `AbortSignal` that fires when the deadline expires so
 * well-behaved hosts can cancel the underlying work; the race is the
 * backstop for hosts that ignore it. On expiry the returned promise
 * rejects with `UpstreamUnavailableError` (503, retryable) and the
 * timeout is logged at error level with the abstraction name so
 * operators can distinguish shell-imposed deadlines from host-returned
 * errors. A losing host promise that rejects later is swallowed so it
 * never surfaces as an unhandled rejection.
 */
export async function withAbstractionDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  opts: { readonly ms: number; readonly abstraction: string; readonly logger: Logger },
): Promise<T> {
  const { ms, abstraction, logger } = opts;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      logger.error({ abstraction, timeoutMs: ms }, "guardian: host abstraction timed out");
      controller.abort(new Error(`guardian: ${abstraction} timed out after ${ms}ms`));
      reject(
        new UpstreamUnavailableError({
          message: `${abstraction} did not complete within ${ms}ms`,
          status: 503,
        }),
      );
    }, ms);
  });
  // The async IIFE normalises a synchronous throw from the host
  // abstraction into a rejection, so it flows through the race/finally
  // below — otherwise the throw would escape before the race, leaking
  // the timer (which later fires: spurious timeout log, aborted signal,
  // and an unhandled rejection from the never-raced deadline promise).
  const task = (async () => run(controller.signal))();
  // Promise.race leaves the losing promise running; if it rejects after
  // the deadline already won, this no-op handler keeps the rejection
  // from being reported as unhandled.
  task.catch(() => {});
  try {
    return await Promise.race([task, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
