import { pino, type Logger as PinoLogger } from "pino";

import type { Logger } from "@3flabs/guardian";

/**
 * Options for the default pino-backed Logger.
 *
 *  - `level`   — minimum level to emit. When omitted, falls back to the
 *                `LOG_LEVEL` environment variable (case-insensitive;
 *                the syslog-style alias `warning` maps to `warn`), then
 *                to `"info"`. Unrecognised `LOG_LEVEL` values are
 *                ignored with a one-time stderr warning instead of
 *                crashing pino at construction.
 *  - `pretty`  — pipe through `pino-pretty`. Default: enabled when
 *                stdout is a TTY (developer ergonomics) and disabled
 *                in production (so log shippers see raw NDJSON).
 *  - `bindings` — top-level fields stamped onto every record (e.g.,
 *                `{ service: "guardian", env: "prod" }`).
 *  - `redact`  — pino redact paths. Defaults to `DEFAULT_REDACT_PATHS`,
 *                a conservative list that masks Authorization,
 *                X-Guardian-Signature, and `hmacSecret` / `secret` /
 *                `privateKey` fields up to two levels of nesting.
 *                Note pino wildcards match exactly one path segment —
 *                there is no recursive wildcard — so hosts logging
 *                secrets nested three or more levels deep must supply
 *                their own paths. Supplying `redact` REPLACES the
 *                defaults; spread `DEFAULT_REDACT_PATHS` to extend
 *                them instead.
 */
export type PinoLoggerOptions = {
  readonly level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
  readonly pretty?: boolean;
  readonly bindings?: Record<string, unknown>;
  readonly redact?: readonly string[];
};

// Frozen at runtime, not just `readonly` at the type level: this array
// is reused as the default for every `pinoLogger()` call, so an in-place
// mutation (possible from plain JS) would silently weaken redaction for
// all later logger instances.
export const DEFAULT_REDACT_PATHS: readonly string[] = Object.freeze([
  "headers.authorization",
  "headers['x-guardian-signature']",
  "headers['x-guardian-timestamp']",
  "tokenInfo.hmacSecret",
  "hmacSecret",
  "secret",
  "privateKey",
  "*.hmacSecret",
  "*.secret",
  "*.privateKey",
  "*.tokenInfo.hmacSecret",
  "*.*.hmacSecret",
  "*.*.secret",
  "*.*.privateKey",
]);

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

let warnedInvalidLogLevel = false;

/**
 * Resolve the level from the `LOG_LEVEL` environment variable,
 * normalising case and the common `warning` alias, and falling back to
 * `"info"` (with a one-time stderr warning) for values pino would
 * reject — an unrelated `LOG_LEVEL=warning` in the container must not
 * crash-loop the signer at boot.
 */
function levelFromEnv(): string {
  const raw = process.env.LOG_LEVEL;
  if (raw === undefined) return "info";
  const normalized = raw.toLowerCase();
  const mapped = normalized === "warning" ? "warn" : normalized;
  if (VALID_LEVELS.has(mapped)) return mapped;
  if (!warnedInvalidLogLevel) {
    warnedInvalidLogLevel = true;
    process.stderr.write(
      `pinoLogger: ignoring invalid LOG_LEVEL ${JSON.stringify(raw)} ` +
        `(expected one of trace, debug, info, warn, error, fatal, silent); using "info"\n`,
    );
  }
  return "info";
}

/**
 * Build a pino-backed `Logger`. The returned value is a real
 * `pino.Logger`, which is structurally assignable to the Guardian
 * `Logger` contract — call `pinoLogger().bindings()` etc. as needed.
 *
 * Pretty-printing is auto-enabled on a TTY and disabled otherwise so
 * production deployments get NDJSON without further configuration. Pass
 * `pretty: false` (or `pretty: true`) to override.
 */
export function pinoLogger(options: PinoLoggerOptions = {}): Logger {
  const {
    level = levelFromEnv(),
    pretty = process.stdout.isTTY === true,
    bindings,
    redact = DEFAULT_REDACT_PATHS,
  } = options;

  const transport = pretty
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
      }
    : undefined;

  const instance: PinoLogger = pino({
    level,
    base: bindings ?? null,
    redact: { paths: [...redact], remove: false },
    ...(transport ? { transport } : {}),
  });

  return instance as unknown as Logger;
}
