import { describe, expect, it } from "vitest";

import { UpstreamUnavailableError } from "../../src/errors/tagged.js";
import {
  DEFAULT_GUARDIAN_TIMEOUTS,
  resolveGuardianTimeouts,
  withAbstractionDeadline,
} from "../../src/lib/deadline.js";
import { type LogFn, type Logger, noopLogger } from "../../src/lib/logger.js";

/** Logger that records every error-level message for assertions. */
function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const error: LogFn = ((objOrMsg: object | string, msg?: string) => {
    errors.push(typeof objOrMsg === "string" ? objOrMsg : (msg ?? ""));
  }) as LogFn;
  const logger: Logger = { ...noopLogger, error, child: () => logger };
  return { logger, errors };
}

describe("withAbstractionDeadline", () => {
  it("resolves with the abstraction's value when it beats the deadline", async () => {
    const { logger, errors } = recordingLogger();
    await expect(
      withAbstractionDeadline(async () => "ok", { ms: 1_000, abstraction: "test", logger }),
    ).resolves.toBe("ok");
    expect(errors).toEqual([]);
  });

  it("rejects with UpstreamUnavailable and aborts the signal on expiry", async () => {
    const { logger, errors } = recordingLogger();
    let seen: AbortSignal | undefined;
    await expect(
      withAbstractionDeadline(
        (signal) => {
          seen = signal;
          return new Promise(() => {});
        },
        { ms: 20, abstraction: "test", logger },
      ),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(seen?.aborted).toBe(true);
    expect(errors).toContain("guardian: host abstraction timed out");
  });

  it("maps a synchronous throw cleanly: original error, timer cleared, no unhandled rejection", async () => {
    const { logger, errors } = recordingLogger();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const boom = new Error("sync boom");
      await expect(
        withAbstractionDeadline(
          () => {
            throw boom;
          },
          { ms: 30, abstraction: "authenticate", logger },
        ),
      ).rejects.toBe(boom);
      // Advance past the deadline: a leaked timer would fire here,
      // logging a spurious timeout and rejecting the never-raced
      // deadline promise with no handler attached.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(errors).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

describe("DEFAULT_GUARDIAN_TIMEOUTS", () => {
  it("worst-case sequential composition stays under Bun.serve's 10 s idle timeout", () => {
    // authenticate + accountRateLimit + sign run sequentially on one
    // signing request with no bytes on the socket in between; the sum —
    // not each stage — must beat the idle timeout or the socket is
    // reset before the 503 envelope can be written.
    const { authenticateMs, rateLimitMs, livenessMs, signMs } = DEFAULT_GUARDIAN_TIMEOUTS;
    expect(authenticateMs + rateLimitMs + signMs).toBeLessThan(10_000);
    expect(livenessMs).toBeLessThan(10_000);
  });
});

describe("resolveGuardianTimeouts", () => {
  it("returns the defaults when no overrides are given", () => {
    expect(resolveGuardianTimeouts()).toEqual(DEFAULT_GUARDIAN_TIMEOUTS);
  });

  it("merges partial overrides over the defaults", () => {
    expect(resolveGuardianTimeouts({ signMs: 1_234 })).toEqual({
      ...DEFAULT_GUARDIAN_TIMEOUTS,
      signMs: 1_234,
    });
  });

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY, 2 ** 31])(
    "throws at construction for rateLimitMs = %s",
    (value) => {
      expect(() => resolveGuardianTimeouts({ rateLimitMs: value })).toThrow(
        /timeouts\.rateLimitMs must be a positive number of at most 2147483647ms/,
      );
    },
  );

  it("accepts the setTimeout maximum exactly", () => {
    // 2^31 − 1 is the largest delay setTimeout represents faithfully;
    // one above it wraps to ~1 ms (covered by the rejection case above).
    expect(resolveGuardianTimeouts({ signMs: 2 ** 31 - 1 }).signMs).toBe(2 ** 31 - 1);
  });

  it("throws with the offending key name for every field", () => {
    for (const key of ["authenticateMs", "rateLimitMs", "livenessMs", "signMs"] as const) {
      expect(() => resolveGuardianTimeouts({ [key]: Number.NaN })).toThrow(
        new RegExp(`timeouts\\.${key} `),
      );
    }
  });
});
