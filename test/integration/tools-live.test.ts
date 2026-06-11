import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SessionManager } from "../../src/ccu/session.js";
import { RateLimiter } from "../../src/middleware/rate-limiter.js";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { Resolver } from "../../src/middleware/resolver.js";
import { createLogger } from "../../src/logger.js";
import { createMcpServer, type ServerDeps } from "../../src/server.js";
import { escapeHmScript } from "../../src/utils.js";
import { callTool, parseToolResult } from "../unit/_helpers.js";
import type { CcuConfig } from "../../src/ccu/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Integration tests for the full tool layer against a live CCU, in particular
// the two HM Script generators (get_values, get_service_messages) whose
// behavior depends on the real ReGa interpreter.
const CCU_HOST = process.env.CCU_HOST;
const describeIf = CCU_HOST ? describe : describe.skip;

describeIf("MCP tools against live CCU", () => {
  const config: CcuConfig = {
    host: CCU_HOST!,
    port: parseInt(process.env.CCU_PORT || "80", 10),
    https: process.env.CCU_HTTPS === "true",
    tlsVerify: process.env.CCU_TLS_VERIFY === "true",
    user: process.env.CCU_USER || "Admin",
    password: process.env.CCU_PASSWORD || "",
    timeout: 10_000,
    scriptTimeout: 30_000,
  };

  const logger = createLogger();
  let session: SessionManager;
  let server: McpServer;
  let deps: ServerDeps;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "debmatic-tools-live-"));
    session = new SessionManager(config, logger, tempDir);
    await session.login();
    deps = {
      config: {
        ccu: config,
        mcp: { transport: "stdio", port: 3000 },
        cache: { dir: tempDir, ttl: 86400 },
        rateLimiter: { burst: 20, rate: 10 },
        resourcePollInterval: 3600,
      },
      session,
      rateLimiter: new RateLimiter(20, 10),
      logger,
      deviceTypeCache: new DeviceTypeCache(tempDir, 86400, logger),
      resolver: new Resolver(),
    };
    server = createMcpServer(deps);
  }, 30_000);

  afterAll(async () => {
    await session.logout();
    session.destroy();
    deps.rateLimiter.destroy();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("get_values by room returns parsed channel data (live ReGa script)", async () => {
    const rooms = parseToolResult(await callTool(server, "list_rooms")) as Array<{ name: string }>;
    expect(rooms.length).toBeGreaterThan(0);

    const result = parseToolResult(await callTool(server, "get_values", { room: rooms[0]!.name })) as any[];
    expect(Array.isArray(result)).toBe(true); // would be a raw string if the script emitted invalid JSON
    if (result.length > 0) {
      expect(result[0]).toHaveProperty("address");
      expect(result[0]).toHaveProperty("datapoints");
    }
  }, 60_000);

  it("get_values by channel list returns exactly the requested channels", async () => {
    const devices = parseToolResult(await callTool(server, "list_devices")) as Array<{ channels: Array<{ address: string }> }>;
    const channel = devices[0]!.channels[0]!.address;

    const result = parseToolResult(await callTool(server, "get_values", { channels: [channel] })) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].address).toBe(channel);
  }, 60_000);

  it("get_service_messages returns a parsed array (live single-pass script)", async () => {
    const result = parseToolResult(await callTool(server, "get_service_messages")) as any[];
    expect(Array.isArray(result)).toBe(true); // raw string would mean invalid JSON from the script
    for (const msg of result) {
      expect(msg).toHaveProperty("address");
      expect(msg).toHaveProperty("channelName");
    }
  }, 60_000);

  it("escapeHmScript round-trips quotes, backslashes, and # through ReGa (issue #16)", async () => {
    const tricky = 'mix "quotes" \\back\\ and #hash#';
    const result = parseToolResult(await callTool(server, "run_script", {
      script: `Write("${escapeHmScript(tricky)}");`,
    }));
    expect(result).toBe(tricky);
  }, 30_000);

  it("execute_program rejects nonexistent IDs against the live CCU (issue #18)", async () => {
    const result: any = await callTool(server, "execute_program", { id: "999999999" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("NOT_FOUND");
  }, 30_000);
});
