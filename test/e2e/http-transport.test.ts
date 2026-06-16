import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request, type Server, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";

// End-to-end test of the HTTP transport against the BUILT server (dist/) with a
// mocked CCU. Regression test for issue #17: a reused stateless transport broke
// every request after the first; the server must support multiple requests per
// session and multiple concurrent sessions.

const DIST = join(__dirname, "../../dist/index.js");
const AUTH_TOKEN = "e2e-test-token";
// Origin on the allowlist for the CORS-enabled describe block below.
const ALLOWED_ORIGIN = "http://localhost:6274";

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
    expect(msg.result.tools.length).toBe(25);
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
        // This block exercises the browser-client configuration (issue #37):
        // a single trusted origin is allowlisted. The secure-defaults block
        // below covers the unset (default-deny) behavior.
        MCP_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
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

  // Issue #29: 401 carries a WWW-Authenticate challenge (RFC 6750 / MCP auth spec)
  it("challenges with WWW-Authenticate: Bearer and no error when no token is sent", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain('realm="debmatic-mcp"');
    expect(challenge).not.toContain("error="); // no credentials presented
  });

  it("adds error=invalid_token to the challenge when a bad token is sent", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer wrong-token",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"');
  });

  // Regression #17: with a reused stateless transport, request 2+ returned 500
  it("handles many sequential requests on one session", async () => {
    const sid = await initialize(mcpPort);
    for (let i = 1; i <= 5; i++) {
      const res = await mcpPost(mcpPort, { jsonrpc: "2.0", id: i, method: "tools/list", params: {} }, sid);
      expect(res.status).toBe(200);
      const msg = await parseSse(res);
      expect(msg.result.tools.length).toBe(25);
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

  // CORS (issue #37, building on #19/@marcinn2): an allowlisted browser origin
  // gets preflight + the exact origin reflected back — never `*`.
  it("answers OPTIONS preflight from an allowed origin with 204 and reflects the exact origin", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "OPTIONS",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, authorization, mcp-session-id",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("mcp-session-id");
  });

  it("rejects an OPTIONS preflight from a disallowed origin (403, no CORS headers)", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "OPTIONS",
      headers: {
        "Origin": "http://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reflects the allowed origin on MCP responses and exposes Mcp-Session-Id", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "POST",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "Authorization": `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 0, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cors", version: "1" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("mcp-session-id");
    await res.text();
  });

  it("omits CORS headers for a disallowed origin even when another is allowlisted", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "POST",
      headers: {
        "Origin": "http://evil.example",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reflects the allowed origin on 401 responses too", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
      method: "POST",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  // Issue #26: a successful tool call returns structuredContent AND passes the
  // SDK's server-side outputSchema validation (a schema mismatch would come back
  // as a JSON-RPC error instead). This is the end-to-end check unit tests can't do.
  it("returns structuredContent that passes outputSchema validation", async () => {
    const sid = await initialize(mcpPort);
    const res = await mcpPost(mcpPort, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_system_info", arguments: {} },
    }, sid);
    expect(res.status).toBe(200);
    const msg = await parseSse(res);
    expect(msg.error).toBeUndefined();            // validation passed
    expect(msg.result.isError).toBeFalsy();
    expect(msg.result.structuredContent).toBeTypeOf("object");
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
        // MCP_ALLOWED_ORIGINS deliberately unset → default-deny CORS.
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

// Issue #50: native TLS for the HTTP transport. When MCP_TLS_CERT/MCP_TLS_KEY
// are set the server must listen over HTTPS so the bearer token isn't sent in
// the clear. Skipped if openssl isn't available to mint a throwaway cert.
const HAVE_OPENSSL = spawnSync("openssl", ["version"]).status === 0;

// Minimal HTTPS client. TLS validation stays ENABLED — we trust the specific
// throwaway cert by passing it as the CA (the cert carries an IP:127.0.0.1 SAN
// so identity verification against the loopback host succeeds), rather than
// disabling certificate validation.
function httpsJson(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown; ca?: Buffer } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path: opts.path ?? "/",
        method: opts.method ?? "GET",
        ca: opts.ca,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe.skipIf(!existsSync(DIST) || !HAVE_OPENSSL)("HTTPS transport e2e (native TLS, mocked CCU)", () => {
  let ccu: { server: Server; port: number };
  let child: ChildProcess;
  let mcpPort: number;
  let cacheDir: string;
  let caCert: Buffer;

  beforeAll(async () => {
    ccu = await startCcuMock();
    cacheDir = mkdtempSync(join(tmpdir(), "debmatic-e2e-tls-"));
    mcpPort = 20000 + Math.floor(Math.random() * 20000);

    // Mint a throwaway self-signed cert. The SAN must include IP:127.0.0.1 —
    // Node (>=17) no longer falls back to the subject CN for identity checks,
    // so a CN-only cert would fail verification against the loopback host.
    const certPath = join(cacheDir, "cert.pem");
    const keyPath = join(cacheDir, "key.pem");
    const gen = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: "ignore" });
    if (gen.status !== 0) throw new Error("openssl failed to generate test cert");
    caCert = readFileSync(certPath);

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
        MCP_TLS_CERT: certPath,
        MCP_TLS_KEY: keyPath,
        CACHE_DIR: cacheDir,
        RESOURCE_POLL_INTERVAL: "3600",
        LOG_LEVEL: "error",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const r = await httpsJson(mcpPort, { path: "/health", ca: caCert });
        if (r.status === 200 || r.status === 503) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("HTTPS server did not start");
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

  it("serves the health endpoint over HTTPS", async () => {
    const res = await httpsJson(mcpPort, { path: "/health", ca: caCert });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.text) as { status: string }).status).toBe("healthy");
  });

  it("rejects a plaintext HTTP request to the TLS port (TLS is actually on)", async () => {
    // A plain-HTTP GET to an HTTPS listener does not complete a normal response.
    await expect(
      fetch(`http://127.0.0.1:${mcpPort}/health`, { signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow();
  });

  it("completes the MCP initialize handshake over TLS", async () => {
    const res = await httpsJson(mcpPort, {
      method: "POST",
      ca: caCert,
      headers: {
        "Authorization": `Bearer ${AUTH_TOKEN}`,
        "Accept": "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: {
        jsonrpc: "2.0", id: 0, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tls", version: "1" } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeTruthy();
  });

  it("still enforces the bearer token over TLS", async () => {
    const res = await httpsJson(mcpPort, {
      method: "POST",
      ca: caCert,
      headers: { "Accept": "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(res.status).toBe(401);
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
