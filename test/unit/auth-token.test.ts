import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveAuthTokens } from "../../src/auth/token.js";
import { Logger } from "../../src/logger.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logger = new Logger("error");

const DAY = 86_400_000;
const HOUR = 3_600_000;

// Pull the persisted token straight out of the .env file the resolver wrote.
async function fileToken(dir: string): Promise<string> {
  const content = await readFile(join(dir, ".env"), "utf-8");
  return content.match(/^MCP_AUTH_TOKEN=(.+)$/m)![1].trim();
}

describe("resolveAuthTokens", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "debmatic-auth-test-"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("accepts the explicit env token and rejects everything else", async () => {
    const tokens = await resolveAuthTokens(
      { envToken: "my-explicit-token", dataDir: dir, graceMs: 24 * HOUR },
      logger,
    );
    expect(tokens.verify("my-explicit-token")).toBe(true);
    expect(tokens.verify("nope")).toBe(false);
    expect(tokens.verify("")).toBe(false);
  });

  it("env token takes priority and leaves the data dir untouched", async () => {
    const tokens = await resolveAuthTokens(
      { envToken: "override", dataDir: dir, graceMs: 24 * HOUR },
      logger,
    );
    expect(tokens.verify("override")).toBe(true);
    // No file should have been written for the explicit-token path.
    await expect(readFile(join(dir, ".env"), "utf-8")).rejects.toThrow();
  });

  it("accepts both env current and previous during a rotation overlap", async () => {
    const tokens = await resolveAuthTokens(
      { envToken: "new", envPreviousToken: "old", dataDir: dir, graceMs: 24 * HOUR },
      logger,
    );
    expect(tokens.verify("new")).toBe(true);
    expect(tokens.verify("old")).toBe(true);
    expect(tokens.verify("ancient")).toBe(false);
  });

  it("generates and persists a token when none exists", async () => {
    const tokens = await resolveAuthTokens({ dataDir: dir, graceMs: 24 * HOUR }, logger);
    const token = await fileToken(dir);
    expect(token.length).toBeGreaterThan(20);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(tokens.verify(token)).toBe(true);
  });

  it("loads the same token across runs", async () => {
    await resolveAuthTokens({ dataDir: dir, graceMs: 24 * HOUR }, logger);
    const token = await fileToken(dir);
    const tokens2 = await resolveAuthTokens({ dataDir: dir, graceMs: 24 * HOUR }, logger);
    expect(tokens2.verify(token)).toBe(true);
  });

  it("trims a trailing CR from CRLF-edited files (issue #13)", async () => {
    await writeFile(join(dir, ".env"), "MCP_AUTH_TOKEN=crlf-token\r\n", "utf-8");
    const tokens = await resolveAuthTokens({ dataDir: dir, graceMs: 24 * HOUR }, logger);
    expect(tokens.verify("crlf-token")).toBe(true);
  });

  it("generates a fresh token when .env lacks MCP_AUTH_TOKEN", async () => {
    await writeFile(join(dir, ".env"), "OTHER_VAR=x\n", "utf-8");
    const tokens = await resolveAuthTokens({ dataDir: dir, graceMs: 24 * HOUR }, logger);
    const token = await fileToken(dir);
    expect(tokens.verify(token)).toBe(true);
  });

  describe("expiry (TTL)", () => {
    it("a generated token is rejected once its TTL lapses", async () => {
      const t0 = 1_000_000_000_000;
      const tokens = await resolveAuthTokens(
        { dataDir: dir, ttlMs: 30 * DAY, graceMs: 24 * HOUR },
        logger,
        t0,
      );
      const token = await fileToken(dir);
      // boundary: valid right up to the edge, rejected past it
      expect(tokens.verify(token, t0)).toBe(true);
      expect(tokens.verify(token, t0 + 30 * DAY)).toBe(true);
      expect(tokens.verify(token, t0 + 30 * DAY + 1)).toBe(false);
    });

    it("without a TTL the generated token never expires", async () => {
      const t0 = 1_000_000_000_000;
      const tokens = await resolveAuthTokens({ dataDir: dir, graceMs: 24 * HOUR }, logger, t0);
      const token = await fileToken(dir);
      expect(tokens.verify(token, t0 + 3650 * DAY)).toBe(true);
    });

    it("backfills issued-at for a legacy file so TTL starts from first sight", async () => {
      await writeFile(join(dir, ".env"), "MCP_AUTH_TOKEN=legacy\n", "utf-8");
      const t0 = 1_000_000_000_000;
      const tokens = await resolveAuthTokens(
        { dataDir: dir, ttlMs: 10 * DAY, graceMs: 24 * HOUR },
        logger,
        t0,
      );
      // legacy token kept, now carrying an issued-at == t0
      expect(tokens.verify("legacy", t0)).toBe(true);
      expect(tokens.verify("legacy", t0 + 10 * DAY + 1)).toBe(false);
      const content = await readFile(join(dir, ".env"), "utf-8");
      expect(content).toContain(`MCP_AUTH_TOKEN_ISSUED=${t0}`);
    });
  });

  describe("rotation overlap", () => {
    it("rotates an expired generated token but keeps the old one valid during grace", async () => {
      const t0 = 1_000_000_000_000;
      // First run mints token A.
      await resolveAuthTokens({ dataDir: dir, ttlMs: 30 * DAY, graceMs: 24 * HOUR }, logger, t0);
      const tokenA = await fileToken(dir);

      // Second run, past A's TTL → rotate to token B, A stays valid for grace.
      const tRotate = t0 + 31 * DAY;
      const tokens = await resolveAuthTokens(
        { dataDir: dir, ttlMs: 30 * DAY, graceMs: 24 * HOUR },
        logger,
        tRotate,
      );
      const tokenB = await fileToken(dir);
      expect(tokenB).not.toBe(tokenA);

      // Both accepted inside the overlap (in-flight clients survive the swap).
      expect(tokens.verify(tokenB, tRotate)).toBe(true);
      expect(tokens.verify(tokenA, tRotate)).toBe(true);
      // Old token lapses at the grace boundary; new one lives on.
      expect(tokens.verify(tokenA, tRotate + 24 * HOUR + 1)).toBe(false);
      expect(tokens.verify(tokenB, tRotate + 24 * HOUR + 1)).toBe(true);
    });

    it("drops a rotated-out token from the file once its grace fully elapses", async () => {
      const t0 = 1_000_000_000_000;
      await resolveAuthTokens({ dataDir: dir, ttlMs: 30 * DAY, graceMs: 24 * HOUR }, logger, t0);
      const tokenA = await fileToken(dir);
      // Rotate to B.
      await resolveAuthTokens(
        { dataDir: dir, ttlMs: 30 * DAY, graceMs: 24 * HOUR },
        logger,
        t0 + 31 * DAY,
      );
      // A later run, well past the grace window: A should be pruned from the file.
      const tokens = await resolveAuthTokens(
        { dataDir: dir, ttlMs: 30 * DAY, graceMs: 24 * HOUR },
        logger,
        t0 + 40 * DAY,
      );
      const content = await readFile(join(dir, ".env"), "utf-8");
      expect(content).not.toContain("MCP_AUTH_TOKEN_PREVIOUS");
      expect(tokens.verify(tokenA, t0 + 40 * DAY)).toBe(false);
    });
  });

  it("still returns a usable verifier when the data dir is not writable", async () => {
    // /dev/null is a file, so creating a dir beneath it fails fast (ENOTDIR).
    const tokens = await resolveAuthTokens(
      { dataDir: "/dev/null/nope", graceMs: 24 * HOUR },
      logger,
    );
    // It minted an in-memory token even though persistence failed; the operator
    // gets it on stderr. We can't read it from a file, but a bogus token fails.
    expect(tokens.verify("definitely-not-it")).toBe(false);
    expect(tokens.liveCount()).toBe(1);
  });
});
