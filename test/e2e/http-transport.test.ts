import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request, type Server, type IncomingHttpHeaders } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";

// End-to-end test of the HTTP transport against the BUILT server (dist/) with a
// mocked CCU. Regression test for issue #17: a reused stateless transport broke
// every request after the first; the server must support multiple requests per
// session and multiple concurrent sessions.

const DIST = join(__dirname, "../../dist/index.js");
const AUTH_TOKEN = "e2e-test-token";

function startCcuMock(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let method = "";
      try { method = JSON.parse(body).method; } catch { /* ignore */ }
      const results: Record<string, unknown> = {
        "Session.login": "mock-session-id",
        "Session.renew": true,
        "Session.logout": true,
        "Interface.listInterfaces": [],
        "Device.listAllDetail": [],
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "2.0", result: results[method] ?? [], error: null }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

async function mcpPost(port: number, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function initialize(port: number): Promise<string> {
  const res = await mcpPost(port, {
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  await res.text();
  return sid!;
}

async function parseSse(res: Response): Promise<any> {
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(data!.slice(6));
}

// Degraded startup: the server must come up and speak MCP even when the CCU
// is unreachable (required for CCU outages and for Glama's containerized
// build checks, which start the server with placeholder credentials).
describe.skipIf(!existsSync(DIST))("degraded startup e2e (CCU unreachable)", () => {
  let child: ChildProcess;
  let mcpPort: number;
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "debmatic-e2e-degraded-"));
    mcpPort = 20000 + Math.floor(Math.random() * 20000);

    child = spawn("node", [DIST], {
      env: {
        ...process.env,
        CCU_HOST: "127.0.0.1",
        CCU_PORT: "9", // discard port — nothing listens, connection refused
        CCU_HTTPS: "false",
        CCU_PASSWORD: "placeholder",
        CCU_TIMEOUT: "1000",
        MCP_TRANSPORT: "http",
        MCP_PORT: String(mcpPort),
        MCP_AUTH_TOKEN: AUTH_TOKEN,
        CACHE_DIR: cacheDir,
        RESOURCE_POLL_INTERVAL: "3600",
        LOG_LEVEL: "error",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${mcpPort}/health`);
        if (r.status === 200 || r.status === 503) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("server did not start without CCU");
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 20_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    child?.kill("SIGKILL");
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("stays alive and reports degraded health", async () => {
    expect(child.exitCode).toBeNull();
    const res = await fetch(`http://127.0.0.1:${mcpPort}/health`);
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("degraded");
  });

  it("answers the MCP initialize handshake and lists tools without a CCU", async () => {
    const sid = await initialize(mcpPort);
    const res = await mcpPost(mcpPort, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, sid);
    expect(res.status).toBe(200);
    const msg = await parseSse(res);
    expect(msg.result.tools.length).toBe(18);
  });

  it("returns a structured tool error (not a crash) when a tool needs the CCU", async () => {
    const sid = await initialize(mcpPort);
    const res = await mcpPost(mcpPort, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "get_system_info", arguments: {} },
    }, sid);
    expect(res.status).toBe(200);
    await res.text();
    expect(child.exitCode).toBeNull(); // server survived the failed CCU call
  });
});

describe.skipIf(!existsSync(DIST))("HTTP transport e2e (built server, mocked CCU)", () => {
  let ccu: { server: Server; port: number };
  let child: ChildProcess;
  let mcpPort: number;
  let cacheDir: string;

  beforeAll(async () => {
    ccu = await startCcuMock();
    cacheDir = mkdtempSync(join(tmpdir(), "debmatic-e2e-"));
    mcpPort = 20000 + Math.floor(Math.random() * 20000);

    child = spawn("node", [DIST], {
      env: {
        ...process.env,
        CCU_HOST: "127.0.0.1",
        CCU_PORT: String(ccu.port),
        CCU_HTTPS: "false",
        CCU_PASSWORD: "mock",
        MCP_TRANSPORT: "http",
        MCP_PORT: String(mcpPort),
        MCP_AUTH_TOKEN: AUTH_TOKEN,
        // This block exercises the dev/MCP-Inspector configuration: wildcard
        // CORS is opt-in (issue #28). The secure-defaults block below covers
        // the unset (default-deny) behavior.
        MCP_CORS_ALLOW_ORIGIN: "*",
        CACHE_DIR: cacheDir,
        RESOURCE_POLL_INTERVAL: "3600",
        LOG_LEVEL: "error",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Wait for the port to accept connections
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${mcpPort}/health`);
        if (r.status === 200 || r.status === 503) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 20_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    child?.kill("SIGKILL");
    ccu?.server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("serves the health endpoint without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("healthy");
  });

  it("rejects MCP requests without a token", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  // Regression #17: with a reused stateless transport, request 2+ returned 500
  it("handles many sequential requests on one session", async () => {
    const sid = await initialize(mcpPort);
    for (let i = 1; i <= 5; i++) {
      const res = await mcpPost(mcpPort, { jsonrpc: "2.0", id: i, method: "tools/list", params: {} }, sid);
      expect(res.status).toBe(200);
      const msg = await parseSse(res);
      expect(msg.result.tools.length).toBe(18);
    }
  });

  it("supports multiple concurrent sessions", async () => {
    const [a, b] = await Promise.all([initialize(mcpPort), initialize(mcpPort)]);
    expect(a).not.toBe(b);
    const [ra, rb] = await Promise.all([
      mcpPost(mcpPort, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, a),
      mcpPost(mcpPort, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, b),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
  });

  it("rejects non-initialize requests without a session", async () => {
    const res = await mcpPost(mcpPort, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // CORS (issue #19, credit @marcinn2): browser clients need preflight + exposed session header
  it("answers OPTIONS preflight with 204 and CORS headers, without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "OPTIONS",
      headers: {
        "Origin": "http://localhost:6274",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, authorization, mcp-session-id",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("mcp-session-id");
  });

  it("sets CORS headers on MCP responses and exposes Mcp-Session-Id", async () => {
    const res = await mcpPost(mcpPort, {
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cors", version: "1" } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("mcp-session-id");
    await res.text();
  });

  it("sets CORS headers on 401 responses too", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  // Must be last: terminates the server and asserts a clean exit
  it("shuts down gracefully on SIGTERM with exit code 0", async () => {
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown timed out")), 12_000)),
    ]);
    expect(code).toBe(0);
  }, 15_000);
});

// Issue #28: secure HTTP defaults — no CORS env set, DNS-rebinding protection on.
// `request` is used (not fetch) because undici forbids overriding the Host header,
// and a forged Host is exactly the DNS-rebinding vector we need to exercise.
function rawPost(
  port: number,
  body: unknown,
  opts: { host?: string; token?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.host ? { Host: opts.host } : {}),
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.on("data", () => {}); // drain
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const INIT_BODY = {
  jsonrpc: "2.0", id: 0, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "secure", version: "1" } },
};

describe.skipIf(!existsSync(DIST))("secure HTTP defaults e2e (no CORS, DNS-rebinding on)", () => {
  let ccu: { server: Server; port: number };
  let child: ChildProcess;
  let mcpPort: number;
  let cacheDir: string;

  beforeAll(async () => {
    ccu = await startCcuMock();
    cacheDir = mkdtempSync(join(tmpdir(), "debmatic-e2e-secure-"));
    mcpPort = 20000 + Math.floor(Math.random() * 20000);

    child = spawn("node", [DIST], {
      env: {
        ...process.env,
        CCU_HOST: "127.0.0.1",
        CCU_PORT: String(ccu.port),
        CCU_HTTPS: "false",
        CCU_PASSWORD: "mock",
        MCP_TRANSPORT: "http",
        MCP_PORT: String(mcpPort),
        MCP_AUTH_TOKEN: AUTH_TOKEN,
        // MCP_CORS_ALLOW_ORIGIN deliberately unset → default-deny CORS.
        CACHE_DIR: cacheDir,
        RESOURCE_POLL_INTERVAL: "3600",
        LOG_LEVEL: "error",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${mcpPort}/health`);
        if (r.status === 200 || r.status === 503) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 20_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    child?.kill("SIGKILL");
    ccu?.server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("does not emit Access-Control-Allow-Origin when CORS is unconfigured (default-deny)", async () => {
    const preflight = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "OPTIONS",
      headers: { "Origin": "http://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const init = await initialize(mcpPort);
    expect(init).toBeTruthy(); // a non-browser client still works fine
  });

  it("accepts a request whose Host header is on the allowlist", async () => {
    const res = await rawPost(mcpPort, INIT_BODY, { token: AUTH_TOKEN, host: `127.0.0.1:${mcpPort}` });
    expect(res.status).toBe(200);
  });

  it("rejects a forged Host header with 403 (DNS-rebinding protection)", async () => {
    const res = await rawPost(mcpPort, INIT_BODY, { token: AUTH_TOKEN, host: "evil.example" });
    expect(res.status).toBe(403);
  });

  // Must be last: clean shutdown
  it("shuts down gracefully on SIGTERM with exit code 0", async () => {
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown timed out")), 12_000)),
    ]);
    expect(code).toBe(0);
  }, 15_000);
});
