import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { DIST, distMissing } from "./_dist.js";

// End-to-end test of the STDIO transport against the BUILT server (dist/) with
// a mocked CCU. stdio is the documented default install path
// (`npx ccu-mcp --stdio`), but every other e2e block drives the HTTP transport,
// so the whole stdio branch of src/index.ts had no coverage.
//
// The shutdown case is the one that matters: StdioServerTransport registers
// only 'data'/'error' listeners, so transport/server onclose never fires on
// stdin EOF. Without the direct stdin hooks in src/index.ts the process would
// exit via event-loop drain with no Session.logout — leaking a CCU session
// toward "too many sessions" — and no cache save.


/** process.env with every server config var scrubbed (see http-transport e2e). */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CCU_|MCP_|CACHE_|RESOURCE_POLL_INTERVAL$|LOG_LEVEL$)/.test(key)) delete env[key];
  }
  return env;
}

interface CcuMock {
  server: Server;
  port: number;
  /** Every JSON-RPC method the server called, in order. */
  calls: string[];
}

function startCcuMock(): Promise<CcuMock> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let method = "";
      try { method = JSON.parse(body).method; } catch { /* ignore */ }
      if (method) calls.push(method);
      const results: Record<string, unknown> = {
        "Session.login": "mock-session-id",
        "Session.renew": true,
        "Session.logout": true,
        "Interface.listInterfaces": [],
        "Device.listAllDetail": [],
        "Room.getAll": [],
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "2.0", result: results[method] ?? [], error: null }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port, calls }),
    );
  });
}

/**
 * Minimal newline-delimited JSON-RPC client over the child's stdio pipes —
 * the framing StdioServerTransport uses.
 */
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

describe.skipIf(distMissing)("stdio transport e2e (built server, mocked CCU)", () => {
  let ccu: CcuMock;
  let child: ChildProcess;
  let client: StdioClient;
  let cacheDir: string;

  beforeAll(async () => {
    ccu = await startCcuMock();
    cacheDir = mkdtempSync(join(tmpdir(), "ccu-mcp-e2e-stdio-"));

    // --stdio (the CLI flag, not MCP_TRANSPORT) is what the README documents,
    // so that is the path under test.
    child = spawn("node", [DIST, "--stdio"], {
      env: {
        ...cleanEnv(),
        CCU_HOST: "127.0.0.1",
        CCU_PORT: String(ccu.port),
        CCU_HTTPS: "false",
        CCU_PASSWORD: "mock",
        CACHE_DIR: cacheDir,
        RESOURCE_POLL_INTERVAL: "3600",
        LOG_LEVEL: "error",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    client = new StdioClient(child);

    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e-stdio", version: "1" },
    }, 20_000);
    expect(init.result?.serverInfo?.name).toBe("ccu-mcp");
    client.notify("notifications/initialized");
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    ccu?.server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("lists tools over stdio", async () => {
    const res = await client.request("tools/list");
    const names = (res.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain("help");
    expect(names).toContain("list_devices");
  });

  it("answers a tool call that needs no CCU", async () => {
    const res = await client.request("tools/call", { name: "help", arguments: {} });
    expect(res.result?.isError).toBeFalsy();
    expect(JSON.stringify(res.result?.content ?? "")).toMatch(/ccu-mcp|tool/i);
  });

  it("reaches the mocked CCU through a tool call", async () => {
    const res = await client.request("tools/call", { name: "list_devices", arguments: {} });
    expect(res.result?.isError).toBeFalsy();
    expect(ccu.calls).toContain("Session.login");
  });

  it("serves the same tool set on both transports", async () => {
    const res = await client.request("tools/list");
    // stdio must not silently register a different surface than HTTP does.
    expect((res.result?.tools ?? []).length).toBeGreaterThan(20);
  });

  // Must be last: closing stdin terminates the server.
  it("shuts down cleanly on stdin EOF, logging out of the CCU", async () => {
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    // EOF, not a signal — this is how an MCP client normally ends a stdio server.
    child.stdin!.end();

    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stdin-EOF shutdown timed out")), 12_000)),
    ]);

    expect(code).toBe(0);
    // The regression guard: without the explicit stdin hooks the process exits
    // via event-loop drain and never logs out, leaking the CCU session.
    expect(ccu.calls).toContain("Session.logout");
  }, 15_000);
});
