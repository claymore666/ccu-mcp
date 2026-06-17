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
        mcp: { transport: "stdio", port: 3000, allowedOrigins: [], allowedHosts: [], allowPlaintext: false, authTokenGraceMs: 86400000 },
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

  // Exercises the real ReGa enumeration + AlConfirm path without mutating the
  // user's CCU: a bogus id matches no active alarm → empty confirmed → NOT_FOUND.
  // We deliberately do NOT auto-confirm a real active alarm (it would silently
  // dismiss the user's warnings during a test run).
  it("acknowledge_service_messages returns NOT_FOUND for an unknown id (live ReGa)", async () => {
    const result: any = await callTool(server, "acknowledge_service_messages", { id: "999999999" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("NOT_FOUND");
  }, 30_000);

  it("acknowledge_service_messages rejects an empty request with INVALID_INPUT", async () => {
    const result: any = await callTool(server, "acknowledge_service_messages", {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
  }, 30_000);

  it("get_rssi returns devices with plausible dBm RSSI values (live)", async () => {
    const result = parseToolResult(await callTool(server, "get_rssi")) as {
      devices: Array<{ address: string; links: Array<{ rssiDevice: number | null; rssiPeer: number | null }> }>;
      interfaces: unknown;
    };
    expect(Array.isArray(result.devices)).toBe(true);

    for (const d of result.devices) {
      expect(typeof d.address).toBe("string");
      for (const link of d.links) {
        for (const v of [link.rssiDevice, link.rssiPeer]) {
          if (v !== null) {
            // dBm: never the 65536 sentinel, within a physically plausible range
            expect(v).not.toBe(65536);
            expect(v).toBeGreaterThan(-130);
            expect(v).toBeLessThan(0);
          }
        }
      }
    }
  }, 60_000);

  it("list_links returns well-formed links (live; production CCU has thermostat↔FALMOT links)", async () => {
    const links = parseToolResult(await callTool(server, "list_links")) as Array<{
      sender: string; receiver: string; senderName: string; receiverName: string; interface: string;
    }>;
    expect(Array.isArray(links)).toBe(true);
    for (const l of links) {
      expect(typeof l.sender).toBe("string");
      expect(typeof l.receiver).toBe("string");
      expect(l.sender).not.toBe("");
      expect(l.receiver).not.toBe("");
    }
    // Filtering by a sender's device returns a subset that all involve that device.
    if (links.length > 0) {
      const dev = links[0]!.sender.split(":")[0]!;
      const filtered = parseToolResult(await callTool(server, "list_links", { address: dev })) as Array<{ sender: string; receiver: string }>;
      for (const l of filtered) {
        expect(l.sender.split(":")[0] === dev || l.receiver.split(":")[0] === dev).toBe(true);
      }
    }
  }, 60_000);

  // Full lifecycle against real ReGa: create → set → read back → delete. Uses a
  // throwaway name and always deletes, so the CCU is left as it was found.
  it("system variable lifecycle: create → set → read → delete (live)", async () => {
    // Unique per run: the CCU keeps hidden VARDP objects for a name even after
    // deletion, so reusing a fixed name eventually makes create dedup it to
    // "<name> N". A fresh name each run sidesteps that and keeps the test clean.
    const name = `debmatic_mcp_test_${Date.now()}`;
    try {
      const created = parseToolResult(await callTool(server, "create_system_variable", { name, type: "float", unit: "°C", min: 0, max: 50 })) as any;
      expect(created.created).toBe(true);
      expect(created.name).toBe(name); // got the exact requested name, not a deduped one

      // Duplicate create is rejected.
      const dup: any = await callTool(server, "create_system_variable", { name, type: "float" });
      expect(dup.isError).toBe(true);
      expect(JSON.parse(dup.content[0].text).error).toBe("INVALID_INPUT");

      // Set and read back through the normal tools (cache must see the new var).
      await callTool(server, "set_system_variable", { name, value: 21.5 });
      const vars = parseToolResult(await callTool(server, "list_system_variables", { name })) as Array<{ name: string; value: unknown }>;
      const mine = vars.find((v) => v.name === name);
      expect(mine).toBeDefined();
      expect(Number(mine!.value)).toBeCloseTo(21.5, 1);
    } finally {
      const del = parseToolResult(await callTool(server, "delete_system_variable", { name })) as any;
      expect(del?.deleted ?? del?.isError === undefined).toBeTruthy();
    }

    // After deletion it's gone → NOT_FOUND on a second delete.
    const second: any = await callTool(server, "delete_system_variable", { name });
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0].text).error).toBe("NOT_FOUND");
  }, 90_000);

  // Assign a channel to a room, verify via list_rooms, then revert — leaving the
  // CCU as found. Skips gracefully if the CCU has no rooms/channels to work with.
  it("assign_channel → verify via list_rooms → unassign (live)", async () => {
    const rooms = parseToolResult(await callTool(server, "list_rooms")) as Array<{ id: string; name: string; channelIds: string[] }>;
    expect(rooms.length).toBeGreaterThan(0);
    // Filtered list_devices returns FULL channel objects (with `id`); the
    // unfiltered/compact form omits `id`, which we need to check room membership.
    const populated = rooms.find((r) => r.channelIds.length > 0) ?? rooms[0]!;
    const devices = parseToolResult(await callTool(server, "list_devices", { room: populated.name })) as Array<{ channels: Array<{ id: string; address: string }> }>;
    const channel = devices.flatMap((d) => d.channels).find((c) => c.id && c.address);
    expect(channel).toBeDefined();

    // Pick a room the channel is NOT already in, so the revert is a true revert.
    const target = rooms.find((r) => !r.channelIds.includes(channel!.id)) ?? rooms[0]!;
    const wasMember = target.channelIds.includes(channel!.id);

    try {
      const res = parseToolResult(await callTool(server, "assign_channel", { channel: channel!.address, room: target.name })) as any;
      expect(res.assignedTo).toContainEqual({ kind: "room", name: target.name });

      const after = parseToolResult(await callTool(server, "list_rooms")) as Array<{ name: string; channelIds: string[] }>;
      const updated = after.find((r) => r.name === target.name)!;
      expect(updated.channelIds).toContain(channel!.id);
    } finally {
      // Revert only if we added it (don't strip a pre-existing membership).
      if (!wasMember) {
        await callTool(server, "unassign_channel", { channel: channel!.address, room: target.name });
      }
    }
  }, 90_000);
});
