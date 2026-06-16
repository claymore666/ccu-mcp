import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestServer, callTool, parseToolResult, cleanupDeps } from "./_helpers.js";

const mockDevices = [
  { id: "1", name: "Thermostat Wohnzimmer", address: "AAA", interface: "HmIP-RF", type: "HmIP-eTRV-2",
    operateGroupOnly: "false", isReady: "true",
    channels: [
      { id: "10", name: "Maintenance", address: "AAA:0", deviceId: "1", index: 0 },
      { id: "11", name: "Heizung Wohnzimmer", address: "AAA:1", deviceId: "1", index: 1 },
    ] },
  { id: "2", name: "Fensterkontakt Küche", address: "BBB", interface: "HmIP-RF", type: "HmIP-SWDO-I",
    operateGroupOnly: "false", isReady: "true",
    channels: [
      { id: "20", name: "Fenster Küche", address: "BBB:0", deviceId: "2", index: 0 },
      { id: "21", name: "Fenster Küche Kanal", address: "BBB:1", deviceId: "2", index: 1 },
    ] },
  { id: "3", name: "Wandtaster", address: "CCC", interface: "BidCos-RF", type: "HM-PB-6-WM55",
    operateGroupOnly: "false", isReady: "true",
    channels: [{ id: "30", name: "Taster 1", address: "CCC:1", deviceId: "3", index: 1 }] },
];

const mockRooms = [
  { id: "100", name: "Wohnzimmer", description: "", channelIds: ["11"] },
  { id: "101", name: "Küche", description: "", channelIds: ["21"] },
];

const mockFunctions = [
  { id: "200", name: "Heizung", description: "", channelIds: ["11"] },
];

describe("list_devices handler", () => {
  function createServer() {
    return createTestServer({
      sessionCall: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Device.listAllDetail") return mockDevices;
        if (method === "Room.getAll") return mockRooms;
        if (method === "Subsection.getAll") return mockFunctions;
        return [];
      }),
    });
  }

  it("returns all devices when no filter", async () => {
    const { server, deps } = createServer();
    const result = parseToolResult(await callTool(server, "list_devices")) as any[];
    expect(result.length).toBe(3);
    cleanupDeps(deps);
  });

  it("filters by room name", async () => {
    const { server, deps } = createServer();
    const result = parseToolResult(await callTool(server, "list_devices", { room: "Wohnzimmer" })) as any[];
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Thermostat Wohnzimmer");
    cleanupDeps(deps);
  });

  it("returns empty when room not found", async () => {
    const { server, deps } = createServer();
    const result = parseToolResult(await callTool(server, "list_devices", { room: "Nonexistent" })) as any[];
    expect(result.length).toBe(0);
    cleanupDeps(deps);
  });

  it("filters by function group", async () => {
    const { server, deps } = createServer();
    const result = parseToolResult(await callTool(server, "list_devices", { function: "Heizung" })) as any[];
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("HmIP-eTRV-2");
    cleanupDeps(deps);
  });

  it("filters by device type (exact match)", async () => {
    const { server, deps } = createServer();
    const result = parseToolResult(await callTool(server, "list_devices", { type: "HmIP-SWDO-I" })) as any[];
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Fensterkontakt Küche");
    cleanupDeps(deps);
  });

  it("filters by name (case-insensitive substring)", async () => {
    const { server, deps } = createServer();
    const result = parseToolResult(await callTool(server, "list_devices", { name: "küche" })) as any[];
    expect(result.length).toBe(1);
    expect(result[0].address).toBe("BBB");
    cleanupDeps(deps);
  });

  it("matches channel names in name filter", async () => {
    const { server, deps } = createServer();
    const result = parseToolResult(await callTool(server, "list_devices", { name: "Taster" })) as any[];
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("HM-PB-6-WM55");
    cleanupDeps(deps);
  });

  it("combines room + type filter", async () => {
    const { server, deps } = createServer();
    const result = parseToolResult(await callTool(server, "list_devices", { room: "Wohnzimmer", type: "HmIP-SWDO-I" })) as any[];
    expect(result.length).toBe(0); // Wohnzimmer has thermostat, not SWDO
    cleanupDeps(deps);
  });
});

describe("list_programs handler", () => {
  it("filters by name substring", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue([
        { id: "1", name: "Good Night" },
        { id: "2", name: "Morning Routine" },
        { id: "3", name: "Night Light" },
      ]),
    });

    const result = parseToolResult(await callTool(server, "list_programs", { name: "night" })) as any[];
    expect(result.length).toBe(2);
    expect(result.map((p: any) => p.name).sort()).toEqual(["Good Night", "Night Light"]);
    cleanupDeps(deps);
  });
});

describe("describe_device_type handler", () => {
  it("returns cached type info", async () => {
    const { server, deps } = createTestServer();
    (deps.deviceTypeCache as any).cache.set("HmIP-eTRV-2", {
      interface: "HmIP-RF", channels: { "1": { type: "HEATING", paramsets: {} } },
    });

    const result = parseToolResult(await callTool(server, "describe_device_type", { deviceType: "HmIP-eTRV-2" })) as any;
    expect(result.deviceType).toBe("HmIP-eTRV-2");
    expect(result.interface).toBe("HmIP-RF");
    cleanupDeps(deps);
  });

  it("returns cache-miss message for unknown type", async () => {
    const { server, deps } = createTestServer();
    const result = parseToolResult(await callTool(server, "describe_device_type", { deviceType: "UNKNOWN" })) as any;
    expect(result.message).toContain("not in cache");
    cleanupDeps(deps);
  });

  it("falls back to a live query when the resolver knows a device of that type", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "Interface.getParamsetDescription") {
        return [{ ID: "STATE", TYPE: "BOOL", OPERATIONS: "7" }];
      }
      return [];
    });
    const { server, deps } = createTestServer({ sessionCall });
    deps.resolver.updateDeviceList(mockDevices as any);

    const result = parseToolResult(await callTool(server, "describe_device_type", { deviceType: "HmIP-SWDO-I" })) as any;

    expect(result.channels["1"].paramsets["VALUES"]["STATE"].type).toBe("BOOL");
    expect(deps.deviceTypeCache.has("HmIP-SWDO-I")).toBe(true);
    cleanupDeps(deps);
  });
});

describe("simple list tools", () => {
  const SIMPLE_TOOLS = [
    ["list_interfaces", "Interface.listInterfaces", [{ name: "HmIP-RF", port: 2010, info: "" }]],
    ["list_rooms", "Room.getAll", mockRooms],
    ["list_functions", "Subsection.getAll", mockFunctions],
  ] as const;

  for (const [tool, method, response] of SIMPLE_TOOLS) {
    it(`${tool} returns CCU data`, async () => {
      const sessionCall = vi.fn().mockImplementation(async (m: string) => (m === method ? response : []));
      const { server, deps } = createTestServer({ sessionCall });

      const result = parseToolResult(await callTool(server, tool)) as any[];
      expect(result.length).toBeGreaterThan(0);
      expect(sessionCall).toHaveBeenCalledWith(method);
      cleanupDeps(deps);
    });

    it(`${tool} maps CcuError to a structured tool error`, async () => {
      const { CcuError } = await import("../../src/middleware/error-mapper.js");
      const sessionCall = vi.fn().mockRejectedValue(
        new CcuError({ error: "UNREACHABLE", code: 0, message: "down", hint: "" }),
      );
      const { server, deps } = createTestServer({ sessionCall });

      const result: any = await callTool(server, tool);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBe("UNREACHABLE");
      cleanupDeps(deps);
    });
  }

  it("list_system_variables filters by substring", async () => {
    const sessionCall = vi.fn().mockResolvedValue([
      { name: "Anwesenheit" }, { name: "Alarmzone" }, { name: "Urlaub" },
    ]);
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "list_system_variables", { name: "a" })) as any[];
    expect(result.map((v: any) => v.name).sort()).toEqual(["Alarmzone", "Anwesenheit", "Urlaub"]);

    const filtered = parseToolResult(await callTool(server, "list_system_variables", { name: "alarm" })) as any[];
    expect(filtered.map((v: any) => v.name)).toEqual(["Alarmzone"]);
    cleanupDeps(deps);
  });
});

describe("list_devices error path (coverage round)", () => {
  it("maps CcuError to a structured tool error", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new CcuError({ error: "UNREACHABLE", code: 0, message: "down", hint: "" })),
    });
    const result: any = await callTool(server, "list_devices", {});
    expect(result.isError).toBe(true);
    cleanupDeps(deps);
  });
});

describe("list_links handler", () => {
  const linksMock = () =>
    vi.fn().mockImplementation(async (method: string, params?: any) => {
      switch (method) {
        case "Device.listAllDetail":
          return [
            { id: "1", name: "Wandtaster", address: "AAA", interface: "HmIP-RF", type: "x", operateGroupOnly: "false", isReady: "true",
              channels: [{ id: "11", name: "Taste Oben", address: "AAA:1", deviceId: "1", index: 1 }] },
            { id: "2", name: "Deckenlampe", address: "BBB", interface: "HmIP-RF", type: "y", operateGroupOnly: "false", isReady: "true",
              channels: [{ id: "21", name: "Licht", address: "BBB:3", deviceId: "2", index: 3 }] },
          ];
        case "Interface.listInterfaces":
          return [{ name: "HmIP-RF" }, { name: "VirtualDevices" }];
        case "Interface.getLinks":
          if (params?.interface === "VirtualDevices") throw new Error("getLinks not supported");
          return [{ SENDER: "AAA:1", RECEIVER: "BBB:3", NAME: "Taster→Licht", DESCRIPTION: "", FLAGS: 0 }];
        default:
          return null;
      }
    });

  it("lists links with sender/receiver channel names resolved", async () => {
    const { server, deps } = createTestServer({ sessionCall: linksMock() });
    const result = parseToolResult(await callTool(server, "list_links")) as any[];

    expect(result).toHaveLength(1);
    expect(result[0].sender).toBe("AAA:1");
    expect(result[0].senderName).toBe("Taste Oben");
    expect(result[0].receiver).toBe("BBB:3");
    expect(result[0].receiverName).toBe("Licht");
    expect(result[0].interface).toBe("HmIP-RF");
    cleanupDeps(deps);
  });

  it("filters by device address (matches either endpoint)", async () => {
    const { server, deps } = createTestServer({ sessionCall: linksMock() });
    const hit = parseToolResult(await callTool(server, "list_links", { address: "BBB" })) as any[];
    expect(hit).toHaveLength(1);

    const miss = parseToolResult(await callTool(server, "list_links", { address: "ZZZ" })) as any[];
    expect(miss).toHaveLength(0);
    cleanupDeps(deps);
  });

  it("tolerates interfaces that don't support getLinks", async () => {
    const { server, deps } = createTestServer({ sessionCall: linksMock() });
    // VirtualDevices.getLinks throws; the HmIP-RF link still comes back
    const result = parseToolResult(await callTool(server, "list_links")) as any[];
    expect(result).toHaveLength(1);
    cleanupDeps(deps);
  });
});
