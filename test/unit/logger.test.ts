import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "../../src/logger.js";

describe("Logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("logs at configured level and above", () => {
    const logger = new Logger("warn");

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(stderrSpy).toHaveBeenCalledTimes(2);

    const warnLine = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim());
    expect(warnLine.level).toBe("warn");
    expect(warnLine.msg).toBe("warn msg");

    const errorLine = JSON.parse((stderrSpy.mock.calls[1]![0] as string).trim());
    expect(errorLine.level).toBe("error");
  });

  it("outputs structured JSON with timestamp", () => {
    const logger = new Logger("info");
    logger.info("test", { tool: "get_value", duration_ms: 12 });

    const line = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim());
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(line.level).toBe("info");
    expect(line.msg).toBe("test");
    expect(line.tool).toBe("get_value");
    expect(line.duration_ms).toBe(12);
  });

  it("redacts sensitive fields", () => {
    const logger = new Logger("debug");
    logger.debug("call", { password: "secret123", _session_id_: "abc", other: "visible" });

    const line = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim());
    expect(line.password).toBe("[REDACTED]");
    expect(line._session_id_).toBe("[REDACTED]");
    expect(line.other).toBe("visible");
  });

  it("redacts nested sensitive fields", () => {
    const logger = new Logger("debug");
    logger.debug("nested", { params: { password: "secret", user: "admin" } });

    const line = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim());
    expect(line.params.password).toBe("[REDACTED]");
    expect(line.params.user).toBe("admin");
  });

  it("redacts sensitive fields nested inside arrays", () => {
    const logger = new Logger("debug");
    logger.debug("array", { items: [{ password: "secret", user: "admin" }], _session_id_: "top" });

    const line = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim());
    expect(line.items[0].password).toBe("[REDACTED]");
    expect(line.items[0].user).toBe("admin");
    expect(line._session_id_).toBe("[REDACTED]");
  });
});
