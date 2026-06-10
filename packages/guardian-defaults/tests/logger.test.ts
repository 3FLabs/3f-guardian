import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_REDACT_PATHS, pinoLogger } from "../src/logger/pino.js";

const levelOf = (log: unknown): string => (log as { level: string }).level;

describe("pinoLogger", () => {
  it("returns a Logger that satisfies the @3flabs/guardian Logger contract", () => {
    const log = pinoLogger({ pretty: false, level: "trace" });
    expect(typeof log.trace).toBe("function");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.fatal).toBe("function");
    expect(typeof log.child).toBe("function");
  });

  it("never throws on the canonical call shapes", () => {
    const log = pinoLogger({ pretty: false, level: "trace" });
    expect(() => log.info("string-only")).not.toThrow();
    expect(() => log.info({ k: 1 })).not.toThrow();
    expect(() => log.info({ k: 1 }, "object + msg")).not.toThrow();
    expect(() => log.warn({ requestId: "abc" }, "warn-shape")).not.toThrow();
  });

  it("child(bindings) returns a new Logger that propagates bindings", () => {
    const log = pinoLogger({ pretty: false, level: "trace" });
    const child = log.child({ requestId: "r-1" });
    expect(typeof child.info).toBe("function");
    expect(child).not.toBe(log);
    // pino child loggers can themselves spawn children — recursive
    // child binding is part of the contract.
    const grand = child.child({ tokenId: "t-1" });
    expect(typeof grand.info).toBe("function");
  });
});

describe("pinoLogger LOG_LEVEL handling", () => {
  const original = process.env.LOG_LEVEL;

  afterEach(() => {
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
    vi.restoreAllMocks();
  });

  it("falls back to info with a one-time stderr warning on an invalid LOG_LEVEL", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.LOG_LEVEL = "banana";

    let log: unknown;
    expect(() => {
      log = pinoLogger({ pretty: false });
    }).not.toThrow();
    expect(levelOf(log)).toBe("info");

    const warnings = () =>
      stderr.mock.calls.filter(([chunk]) => String(chunk).includes("LOG_LEVEL"));
    expect(warnings()).toHaveLength(1);
    // One-time: constructing again does not warn again.
    pinoLogger({ pretty: false });
    expect(warnings()).toHaveLength(1);
  });

  it("maps the syslog-style alias warning → warn instead of crashing pino", () => {
    process.env.LOG_LEVEL = "warning";
    expect(levelOf(pinoLogger({ pretty: false }))).toBe("warn");
  });

  it("normalises case before validating (WARN → warn)", () => {
    process.env.LOG_LEVEL = "WARN";
    expect(levelOf(pinoLogger({ pretty: false }))).toBe("warn");
  });

  it("accepts silent from the environment", () => {
    process.env.LOG_LEVEL = "silent";
    expect(levelOf(pinoLogger({ pretty: false }))).toBe("silent");
  });

  it("prefers an explicit level option over LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "error";
    expect(levelOf(pinoLogger({ pretty: false, level: "debug" }))).toBe("debug");
  });
});

describe("DEFAULT_REDACT_PATHS", () => {
  // Drives a raw pino instance configured exactly like pinoLogger's
  // default (`redact: { paths, remove: false }`) into an in-memory
  // destination so emitted NDJSON can be asserted on.
  function captureLogger() {
    const lines: string[] = [];
    const log = pino(
      { level: "trace", base: null, redact: { paths: [...DEFAULT_REDACT_PATHS], remove: false } },
      {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    );
    return { log, lines };
  }

  it("masks hmacSecret nested two levels deep (e.g. auth.tokenInfo.hmacSecret)", () => {
    const { log, lines } = captureLogger();
    log.error({ auth: { tokenInfo: { hmacSecret: "leak-hmac" } } }, "auth failed");
    const out = lines.join("");
    expect(out).not.toContain("leak-hmac");
    expect(out).toContain("[Redacted]");
  });

  it("masks privateKey at the top level and up to two levels of nesting", () => {
    const { log, lines } = captureLogger();
    log.info({ privateKey: "leak-pk-0" });
    log.info({ signer: { privateKey: "leak-pk-1" } });
    log.info({ ctx: { signer: { privateKey: "leak-pk-2" } } });
    const out = lines.join("");
    expect(out).not.toContain("leak-pk-0");
    expect(out).not.toContain("leak-pk-1");
    expect(out).not.toContain("leak-pk-2");
  });

  it("masks secret / hmacSecret at every depth up to two levels", () => {
    const { log, lines } = captureLogger();
    log.info({ secret: "leak-s-0" });
    log.info({ a: { secret: "leak-s-1" } });
    log.info({ a: { b: { secret: "leak-s-2" } } });
    log.info({ hmacSecret: "leak-h-0" });
    log.info({ tokenInfo: { hmacSecret: "leak-h-1" } });
    const out = lines.join("");
    for (const leak of ["leak-s-0", "leak-s-1", "leak-s-2", "leak-h-0", "leak-h-1"]) {
      expect(out).not.toContain(leak);
    }
  });
});
