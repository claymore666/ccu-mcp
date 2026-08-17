import { describe, it, expect } from "vitest";
import { withRetry } from "../../src/middleware/retry.js";
import { CcuError } from "../../src/middleware/error-mapper.js";
import { Logger } from "../../src/logger.js";

const logger = new Logger("error"); // Suppress logs in tests

describe("withRetry", () => {
  it("returns result on success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"), "Interface.getValue", logger);
    expect(result).toBe("ok");
  });

  it("retries on TIMEOUT error", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts === 1) {
        throw new CcuError({
          error: "TIMEOUT",
          code: 0,
          message: "timeout",
          hint: "",
        });
      }
      return "ok";
    };

    const result = await withRetry(fn, "Interface.getValue", logger, { delayMs: 10 });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("retries on UNREACHABLE error", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts === 1) {
        throw new CcuError({
          error: "UNREACHABLE",
          code: 0,
          message: "ECONNREFUSED",
          hint: "",
        });
      }
      return "ok";
    };

    const result = await withRetry(fn, "Interface.getValue", logger, { delayMs: 10 });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does NOT retry non-idempotent methods", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new CcuError({
        error: "TIMEOUT",
        code: 0,
        message: "timeout",
        hint: "",
      });
    };

    await expect(
      withRetry(fn, "Program.execute", logger, { delayMs: 10 }),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });

  it("does NOT retry INVALID_INPUT errors", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new CcuError({
        error: "INVALID_INPUT",
        code: 505,
        message: "unknown argument",
        hint: "",
      });
    };

    await expect(
      withRetry(fn, "Interface.setValue", logger, { delayMs: 10 }),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });

  it("throws after max retries exhausted", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new CcuError({
        error: "TIMEOUT",
        code: 0,
        message: "timeout",
        hint: "",
      });
    };

    await expect(
      withRetry(fn, "Interface.getValue", logger, { maxRetries: 2, delayMs: 10 }),
    ).rejects.toThrow();

    expect(attempts).toBe(3); // initial + 2 retries
  });
});
