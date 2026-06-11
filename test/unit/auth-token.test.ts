import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveAuthToken } from "../../src/auth/token.js";
import { Logger } from "../../src/logger.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logger = new Logger("error");

describe("resolveAuthToken", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "debmatic-auth-test-"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns explicit env token if provided", async () => {
    const token = await resolveAuthToken("my-explicit-token", tempDir, logger);
    expect(token).toBe("my-explicit-token");
  });

  it("generates token and saves to .env if none exists", async () => {
    const token = await resolveAuthToken(undefined, tempDir, logger);

    expect(token.length).toBeGreaterThan(20);

    // Check file was created
    const content = await readFile(join(tempDir, ".env"), "utf-8");
    expect(content).toBe(`MCP_AUTH_TOKEN=${token}\n`);
  });

  it("loads existing token from .env", async () => {
    // First call generates
    const token1 = await resolveAuthToken(undefined, tempDir, logger);

    // Second call loads
    const token2 = await resolveAuthToken(undefined, tempDir, logger);

    expect(token2).toBe(token1);
  });

  it("env token takes priority over .env file", async () => {
    // Generate a file token first
    await resolveAuthToken(undefined, tempDir, logger);

    // Explicit env should win
    const token = await resolveAuthToken("override-token", tempDir, logger);
    expect(token).toBe("override-token");
  });

  // Regression: trailing \r from CRLF line endings was kept in the token (issue #13)
  it("trims trailing CR when .env has CRLF line endings", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, ".env"), "MCP_AUTH_TOKEN=crlf-token\r\n", "utf-8");

    const token = await resolveAuthToken(undefined, tempDir, logger);
    expect(token).toBe("crlf-token");
  });

  it("generates base64url token (no padding, URL-safe)", async () => {
    const token = await resolveAuthToken(undefined, tempDir, logger);
    // base64url uses only [A-Za-z0-9_-], no = padding
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("save failure (coverage round)", () => {
  it("still returns a usable token when the data dir is not writable", async () => {
    // /dev/null is a file, so creating a directory beneath it fails fast (ENOTDIR)
    const token = await resolveAuthToken(undefined, "/dev/null/not-writable", logger);
    expect(token.length).toBeGreaterThan(20);
  });
});

describe("malformed .env (coverage round)", () => {
  it("generates a new token when .env exists without MCP_AUTH_TOKEN", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "debmatic-auth-test2-"));
    try {
      await writeFile(join(dir, ".env"), "OTHER_VAR=x\n", "utf-8");
      const token = await resolveAuthToken(undefined, dir, logger);
      expect(token.length).toBeGreaterThan(20);
      const content = await readFile(join(dir, ".env"), "utf-8");
      expect(content).toContain(`MCP_AUTH_TOKEN=${token}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
