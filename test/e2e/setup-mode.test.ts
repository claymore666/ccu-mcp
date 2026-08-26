import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DIST, distMissing } from "./_dist.js";
import { startMockCcu, adminResults, type MockCcu } from "../unit/_mock-ccu.js";

// End-to-end test of SETUP MODE (issue #196): the BUILT server, started with
// --stdio --env <missing file>, must come up as a minimal MCP server exposing
// only the setup_* tools, let the flow write a real env file (password via the
// `ccu-mcp secret` CLI, never through the MCP transport), verify it with
// setup_test, and then — restarted with the identical command line — come up
// fully configured. That restart is the product promise: the MCP client entry
// never changes between "not configured yet" and "configured".

/** process.env with every server config var scrubbed. */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CCU_|MCP_|CACHE_|RESOURCE_POLL_INTERVAL$|LOG_LEVEL$)/.test(key)) delete env[key];
  }
  return env;
}

/** Same newline-delimited JSON-RPC framing as stdio-transport.test.ts. */
class StdioClient {
  private buffer = "";
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;

  constructor(private child: ChildProcess) {
    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }

  request(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`stdio request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

function spawnServer(envPath: string): { child: ChildProcess; client: StdioClient } {
  const child = spawn("node", [DIST, "--stdio", "--env", envPath], {
    env: { ...cleanEnv(), LOG_LEVEL: "error", CACHE_DIR: mkdtempSync(join(tmpdir(), "setup-e2e-cache-")) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, client: new StdioClient(child) };
}

async function initialize(client: StdioClient): Promise<any> {
  const init = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e-setup", version: "1" },
  }, 20_000);
  client.notify("notifications/initialized");
  return init;
}

function endChild(child: ChildProcess | undefined): Promise<number | null> {
  if (!child || child.exitCode !== null) return Promise.resolve(child?.exitCode ?? null);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  child.stdin!.end();
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  return exited.finally(() => clearTimeout(killTimer));
}

describe.skipIf(distMissing)("setup mode e2e (built server)", () => {
  let dir: string;
  let envPath: string;
  let ccu: MockCcu;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "setup-e2e-"));
    envPath = join(dir, ".env");
    ccu = await startMockCcu(adminResults());
  });

  afterAll(async () => {
    await endChild(child);
    await ccu.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("walks the whole flow: setup server → write → secret CLI → verify → configured restart", async () => {
    // 1. The env file does not exist: the identical client command line must
    //    yield the setup server, announced via its instructions.
    const first = spawnServer(envPath);
    child = first.child;
    const init = await initialize(first.client);
    expect(init.result?.serverInfo?.name).toBe("ccu-mcp");
    expect(init.result?.instructions).toContain("setup mode");
    expect(init.result?.instructions).toContain("NEVER travel through this conversation");

    const tools = await first.client.request("tools/list");
    const names = (tools.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["setup_probe", "setup_status", "setup_test", "setup_write_profile"]);

    // 2. Status → probe → write, all over MCP.
    const status = await first.client.request("tools/call", { name: "setup_status", arguments: {} });
    expect(status.result?.structuredContent?.fileExists).toBe(false);

    const probe = await first.client.request("tools/call", {
      name: "setup_probe",
      arguments: { host: "127.0.0.1", port: ccu.port, https: false },
    });
    expect(probe.result?.structuredContent?.reachable).toBe(true);

    const write = await first.client.request("tools/call", {
      name: "setup_write_profile",
      arguments: { name: "dev", host: "127.0.0.1", port: ccu.port, https: false },
    });
    expect(write.result?.structuredContent?.written).toBe(true);
    // The printed command must invoke THIS server's own entry point — the
    // subprocess was spawned as `node DIST --stdio …`, so argv[1] is DIST.
    // A bare `npx ccu-mcp` here reaches whichever install npx finds, which for
    // an older global has no `secret` subcommand and fails with a misleading
    // "CCU_HOST environment variable is required".
    expect(write.result?.structuredContent?.nextStep).toContain(`node ${DIST} secret dev`);
    // Read before stat: the reverse order is a check-then-use pattern CodeQL
    // flags as a file-system race (js/file-system-race).
    const written = readFileSync(envPath, "utf-8");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    // The password is NOT in the file yet — the key is absent rather than
    // empty, so it cannot be mistaken for a deliberately empty password — and
    // there is no way to put it there over MCP.
    expect(written).not.toContain("CCU_DEV_PASSWORD");

    // 3. The password arrives out-of-band through the local CLI.
    const secret = spawn("node", [DIST, "secret", "dev", "--env", envPath], {
      env: { ...cleanEnv() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    secret.stdin.end("mock-password\n");
    const secretExit = await new Promise<number | null>((resolve) => secret.once("exit", resolve));
    expect(secretExit).toBe(0);
    expect(readFileSync(envPath, "utf-8")).toContain("CCU_DEV_PASSWORD=mock-password");

    // 4. Verification over MCP goes green and points at reconnecting.
    const test = await first.client.request("tools/call", { name: "setup_test", arguments: {} }, 20_000);
    expect(test.result?.structuredContent?.ok).toBe(true);
    expect(test.result?.structuredContent?.nextStep).toContain("reconnect");

    // 5. "Reconnect": stdin EOF ends the setup server cleanly…
    expect(await endChild(child)).toBe(0);

    // 6. …and the SAME command line now starts the configured server.
    const second = spawnServer(envPath);
    child = second.child;
    const reinit = await initialize(second.client);
    expect(reinit.result?.instructions ?? "").not.toContain("setup mode");
    const fullTools = await second.client.request("tools/list");
    expect((fullTools.result?.tools ?? []).length).toBeGreaterThan(20);
    expect(await endChild(child)).toBe(0);
    child = undefined;
  }, 90_000);

  it("never enters setup mode without --stdio: HTTP with a broken config still dies", () => {
    const res = spawnSync("node", [DIST, "--http", "--env", join(dir, "does-not-exist.env")], {
      env: { ...cleanEnv() },
      encoding: "utf-8",
      timeout: 15_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("does-not-exist.env");
  });

  it("never enters setup mode without --env: a bare stdio start still fails loudly", () => {
    const res = spawnSync("node", [DIST, "--stdio"], {
      env: { ...cleanEnv() },
      encoding: "utf-8",
      timeout: 15_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("CCU_HOST");
  });
});
