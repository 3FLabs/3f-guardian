import { pino, type Logger as PinoLogger } from "pino";

import type { Logger } from "@3flabs/guardian";

/**
 * Options for the default pino-backed Logger.
 *
 *  - `level`   — minimum level to emit. Default `"info"`.
 *  - `pretty`  — pipe through `pino-pretty`. Default: enabled when
 *                stdout is a TTY (developer ergonomics) and disabled
 *                in production (so log shippers see raw NDJSON).
 *  - `bindings` — top-level fields stamped onto every record (e.g.,
 *                `{ service: "guardian", env: "prod" }`).
 *  - `redact`  — pino redact paths. Defaults to a conservative list
 *                that masks Authorization, X-Guardian-Signature, and
 *                hmacSecret if they appear in the structured payload
 *                under those exact keys.
 */
export type PinoLoggerOptions = {
  readonly level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly pretty?: boolean;
  readonly bindings?: Record<string, unknown>;
  readonly redact?: readonly string[];
};

const DEFAULT_REDACT_PATHS: readonly string[] = [
  "headers.authorization",
  "headers['x-guardian-signature']",
  "headers['x-guardian-timestamp']",
  "tokenInfo.hmacSecret",
  "hmacSecret",
  "secret",
  "*.hmacSecret",
  "*.secret",
];

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
    level = process.env.LOG_LEVEL ?? "info",
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
