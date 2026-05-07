/**
 * Structured-logger interface modelled on pino's surface so a host can
 * pass a real `pino.Logger` directly with no adapter.
 *
 * Each level accepts either:
 *   - `(msg)`               — bare message
 *   - `(obj)`               — structured object only
 *   - `(obj, msg)`          — structured object + message
 *
 * `child(bindings)` MUST return a logger that merges `bindings` into every
 * subsequent record. The shell uses this to attach `{ requestId, tokenId }`
 * once at request entry; child loggers then propagate those fields without
 * the abstraction having to thread them by hand.
 *
 * A pino instance is structurally assignable to this type; callers wanting
 * the default implementation can construct one via `pinoLogger()` from
 * `@3flabs/guardian-defaults`.
 */
export type Logger = {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child: (bindings: Record<string, unknown>) => Logger;
};

export type LogFn = {
  (msg: string): void;
  (obj: object, msg?: string): void;
};

/**
 * Default fallback when the host does not supply a Logger. Drops every
 * record on the floor; never throws. Used by `buildGuardianServer` when
 * `abs.logger` is absent so internal `log.info(...)` call sites always
 * have a target.
 */
export const noopLogger: Logger = (() => {
  const noop: LogFn = (() => {}) as LogFn;
  const self: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => self,
  };
  return self;
})();
