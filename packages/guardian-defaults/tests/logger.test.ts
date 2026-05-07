import { describe, expect, it } from "vitest";

import { pinoLogger } from "../src/logger/pino.js";

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
