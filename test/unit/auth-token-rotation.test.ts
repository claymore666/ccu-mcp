import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveAuthTokens, startAutoRotation } from "../../src/auth/token.js";
import { Logger } from "../../src/logger.js";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Runtime auto-rotation (src/auth/token.ts startAutoRotation). The tricky part
// is not rotating on time — it is NOT rotating when the data dir is broken.
// A tick that blindly adopted its own resolve would mint and announce a brand
// new token every interval, 401ing the one clients are actually holding, and
// it would do so silently for as long as the dir stays unwritable.

const logger = new Logger("error");
const HOUR = 3_600_000;

/** Poll until `predicate` holds, so we never race the tick's async work. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not reached within timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function fileToken(dir: string): Promise<string | undefined> {
  try {
    const content = await readFile(join(dir, ".env"), "utf-8");
    return content.match(/^MCP_AUTH_TOKEN=(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

describe("startAutoRotation", () => {
  let dir: string;
  let stop: (() => void) | undefined;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccu-mcp-rotation-"));
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stop?.();
    stop = undefined;
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rotates on the immediate tick, without waiting out the first interval", async () => {
    // A token already past its TTL: if the first tick only ran after `intervalMs`,
    // clients would 401 for that whole window. The interval here is deliberately
    // far longer than the test, so only the immediate tick can do the work.
    await writeFile(
      join(dir, ".env"),
      `MCP_AUTH_TOKEN=stale-token\nMCP_AUTH_TOKEN_ISSUED=${Date.now() - 4 * HOUR}\n`,
      "utf-8",
    );
    const tokens = await resolveAuthTokens({ dataDir: dir, ttlMs: HOUR, graceMs: HOUR }, logger);

    stop = startAutoRotation(tokens, { dataDir: dir, ttlMs: HOUR, graceMs: HOUR }, logger, 600_000);

    await waitFor(async () => (await fileToken(dir)) !== "stale-token");
    const rotated = await fileToken(dir);
    expect(rotated).toBeDefined();
    expect(tokens.verify(rotated!)).toBe(true);
  });

  it("keeps the outgoing token valid for the grace window after rotating", async () => {
    await writeFile(
      join(dir, ".env"),
      `MCP_AUTH_TOKEN=outgoing-token\nMCP_AUTH_TOKEN_ISSUED=${Date.now() - 4 * HOUR}\n`,
      "utf-8",
    );
    const tokens = await resolveAuthTokens({ dataDir: dir, ttlMs: HOUR, graceMs: HOUR }, logger);

    stop = startAutoRotation(tokens, { dataDir: dir, ttlMs: HOUR, graceMs: HOUR }, logger, 600_000);
    await waitFor(async () => (await fileToken(dir)) !== "outgoing-token");

    // Both must validate: a client mid-migration is not cut off.
    expect(tokens.verify("outgoing-token")).toBe(true);
    expect(tokens.verify((await fileToken(dir))!)).toBe(true);
  });

  it("stops ticking once the returned stop function is called", async () => {
    const tokens = await resolveAuthTokens({ dataDir: dir, ttlMs: 50, graceMs: HOUR }, logger);
    const stopFn = startAutoRotation(tokens, { dataDir: dir, ttlMs: 50, graceMs: HOUR }, logger, 20);

    await waitFor(async () => (await fileToken(dir)) !== undefined);
    stopFn();
    const afterStop = await fileToken(dir);

    // Several intervals' worth of wall clock with no further rotation.
    await new Promise((r) => setTimeout(r, 200));
    expect(await fileToken(dir)).toBe(afterStop);
  });

  describe("unwritable data dir", () => {
    let brokenDir: string;

    beforeEach(async () => {
      // A FILE where the data dir should be: mkdir fails with ENOTDIR for any
      // user, unlike chmod 000 which root ignores.
      brokenDir = join(dir, "not-a-directory");
      await writeFile(brokenDir, "", "utf-8");
    });

    it("does not replace the in-memory token while nothing can be persisted", async () => {
      // Long TTL on purpose: a short one would expire the startup token and
      // mask the thing under test. With a broken dir every tick mints a fresh
      // token regardless of TTL, because it can never read a persisted one.
      const opts = { dataDir: brokenDir, ttlMs: HOUR, graceMs: HOUR };
      const tokens = await resolveAuthTokens(opts, logger);
      // The startup mint was announced with the token echoed (it could not be saved).
      const minted = String(stderr.mock.calls.at(-1)?.[0]).match(/token: (\S+)/)?.[1];
      expect(minted).toBeDefined();
      expect(tokens.verify(minted!)).toBe(true);

      stderr.mockClear();
      stop = startAutoRotation(tokens, opts, logger, 20);

      // Let several ticks run. Each one resolves a fresh token internally; none
      // may be adopted, or the token clients hold would stop validating.
      await new Promise((r) => setTimeout(r, 200));

      expect(tokens.verify(minted!)).toBe(true);
      expect(tokens.liveCount()).toBe(1);
    });

    it("announces nothing per tick while the dir stays broken", async () => {
      const opts = { dataDir: brokenDir, ttlMs: HOUR, graceMs: HOUR };
      const tokens = await resolveAuthTokens(opts, logger);

      stderr.mockClear();
      stop = startAutoRotation(tokens, opts, logger, 20);
      await new Promise((r) => setTimeout(r, 200));

      // announceUnpersisted:false — a broken dir must not spam a new token on
      // every tick, which would also invalidate the previous announcement.
      const announcements = stderr.mock.calls.filter((c: unknown[]) => String(c[0]).includes("[ccu-mcp]"));
      expect(announcements).toHaveLength(0);
    });

    it("adopts with grace once persistence recovers, without a 401 gap", async () => {
      const opts = { dataDir: brokenDir, ttlMs: HOUR, graceMs: HOUR };
      const tokens = await resolveAuthTokens(opts, logger);
      const inMemory = String(stderr.mock.calls.at(-1)?.[0]).match(/token: (\S+)/)?.[1];
      expect(inMemory).toBeDefined();

      stop = startAutoRotation(tokens, opts, logger, 20);
      await new Promise((r) => setTimeout(r, 100));

      // Operator fixes the data dir; the next tick persists for the first time.
      await rm(brokenDir, { force: true });
      await mkdir(brokenDir, { recursive: true });

      await waitFor(async () => (await fileToken(brokenDir)) !== undefined);
      const persisted = await fileToken(brokenDir);

      expect(tokens.verify(persisted!)).toBe(true);
      // The token clients were handed at startup keeps working through the overlap.
      expect(tokens.verify(inMemory!)).toBe(true);
    });
  });

  it("survives a failing tick and keeps the timer alive", async () => {
    const opts = { dataDir: dir, ttlMs: 50, graceMs: HOUR };
    const tokens = await resolveAuthTokens(opts, logger);
    const before = await fileToken(dir);

    const failing = vi.spyOn(logger, "error").mockImplementation(() => {});
    stop = startAutoRotation(tokens, opts, logger, 20);
    await waitFor(async () => (await fileToken(dir)) !== before);

    // Rotation kept working; nothing escaped as an unhandled rejection.
    expect(tokens.liveCount()).toBeGreaterThanOrEqual(1);
    failing.mockRestore();
  });
});
