import { describe, it, expect, vi, afterEach } from "vitest";
import { tryParseJson } from "../../src/tools/diagnostics.js";
import { createTestServer, callTool, parseToolResult, cleanupDeps } from "./_helpers.js";

describe("tryParseJson", () => {
  it("parses valid JSON", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it("returns raw string for invalid JSON", () => {
    expect(tryParseJson("not json")).toBe("not json");
    expect(tryParseJson("")).toBe("");
  });
});

describe("get_service_messages handler", () => {
  it("executes HM Script and returns parsed JSON", async () => {
    const mockMessages = '[{"id":"1","name":"LOWBAT","address":"ABC:0","channelName":"Thermostat","timestamp":"2026-03-30"}]';
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue(mockMessages),
    });

    const result = parseToolResult(await callTool(server, "get_service_messages"));
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[])[0].name).toBe("LOWBAT");
    cleanupDeps(deps);
  });

  // Issue #8: single-pass script returns {alarms, channelNames}; names merged in JS
  it("merges channel names from the single-pass script format", async () => {
    const mock = JSON.stringify({
      alarms: [
        { id: "1", type: "LOWBAT", address: "ABC:0", timestamp: "2026-06-11" },
        { id: "2", type: "UNREACH", address: "XYZ:0", timestamp: "2026-06-11" },
      ],
      channelNames: { "ABC:0": "Thermostat Büro" },
    });
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue(mock),
    });

    const result = parseToolResult(await callTool(server, "get_service_messages")) as any[];

    expect(result[0].channelName).toBe("Thermostat Büro");
    expect(result[1].channelName).toBe(""); // unresolved address → empty, not undefined
    cleanupDeps(deps);
  });

  it("returns raw string when script output is not JSON", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue("raw output"),
    });

    const result = parseToolResult(await callTool(server, "get_service_messages"));
    expect(result).toBe("raw output");
    cleanupDeps(deps);
  });
});

describe("acknowledge_service_messages handler", () => {
  it("confirms a single alarm by id and reports what was confirmed", async () => {
    const mock = JSON.stringify({ confirmed: [{ id: "4711", type: "LOWBAT", address: "ABC:0" }] });
    const sessionCall = vi.fn().mockResolvedValue(mock);
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "acknowledge_service_messages", { id: "4711" })) as any;
    expect(result.count).toBe(1);
    expect(result.confirmed[0].id).toBe("4711");
    cleanupDeps(deps);
  });

  it("confirms all active messages on a channel address", async () => {
    const mock = JSON.stringify({
      confirmed: [
        { id: "1", type: "LOWBAT", address: "ABC:0" },
        { id: "2", type: "UNREACH", address: "ABC:0" },
      ],
    });
    const { server, deps } = createTestServer({ sessionCall: vi.fn().mockResolvedValue(mock) });

    const result = parseToolResult(await callTool(server, "acknowledge_service_messages", { address: "ABC:0" })) as any;
    expect(result.count).toBe(2);
    cleanupDeps(deps);
  });

  it("returns INVALID_INPUT when neither id nor address is given", async () => {
    const sessionCall = vi.fn();
    const { server, deps } = createTestServer({ sessionCall });

    const result: any = await callTool(server, "acknowledge_service_messages", {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
    expect(sessionCall).not.toHaveBeenCalled(); // validated before touching the CCU
    cleanupDeps(deps);
  });

  it("returns NOT_FOUND when nothing matched (no active alarm for that id/address)", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue(JSON.stringify({ confirmed: [] })),
    });

    const result: any = await callTool(server, "acknowledge_service_messages", { id: "9999" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("NOT_FOUND");
    cleanupDeps(deps);
  });

  it("generates a script that confirms (AlConfirm) and escapes the requested id/address", async () => {
    const sessionCall = vi.fn().mockResolvedValue(JSON.stringify({ confirmed: [{ id: "1", type: "x", address: 'A":0' }] }));
    const { server, deps } = createTestServer({ sessionCall });

    await callTool(server, "acknowledge_service_messages", { address: 'A":0' });
    const script = sessionCall.mock.calls[0][1].script as string;
    expect(script).toContain("AlConfirm()");
    expect(script).toContain("OT_ALARMDP");
    // the embedded address literal is escaped (quote -> \")
    expect(script).toContain('string wantAddr = "A\\":0";');
    cleanupDeps(deps);
  });
});

describe("get_rssi handler", () => {
  const rssiMock = () =>
    vi.fn().mockImplementation(async (method: string, params?: any) => {
      switch (method) {
        case "Device.listAllDetail":
          return [
            { id: "1", name: "Thermostat Büro", address: "ABC123", interface: "HmIP-RF", type: "HmIP-eTRV",
              channels: [{ id: "10", name: "M", address: "ABC123:0", deviceId: "1", index: 0 }] },
            { id: "2", name: "Fenster Küche", address: "DEF456", interface: "BidCos-RF", type: "HM-SWDO", channels: [] },
          ];
        case "Interface.listInterfaces":
          return [{ name: "HmIP-RF" }, { name: "BidCos-RF" }, { name: "VirtualDevices" }];
        case "Interface.rssiInfo":
          // Real JSON-RPC shape: array of {name: <addr>, partner: [{name: <addr>, rssiData: [a,b]}]}.
          // HmIP-RF and VirtualDevices don't implement rssiInfo on a real CCU → throw.
          if (params?.interface === "BidCos-RF") return [{ name: "DEF456", partner: [{ name: "BidCoS-RF", rssiData: [65536, -80] }] }];
          throw new Error("rssiInfo not supported");
        case "Interface.getParamset":
          // HmIP :0 maintenance channel exposes RSSI_DEVICE (dBm, negative).
          // Raw getParamset returns STRING values (the tool coerces them).
          if (params?.address === "ABC123:0") return { RSSI_DEVICE: "-72", UNREACH: "0" };
          return {};
        case "Interface.listBidcosInterfaces":
          return [{ ADDRESS: "OEQ0123456", DUTY_CYCLE: 12, CONNECTED: true }];
        default:
          return null;
      }
    });

  it("reports BidCos RSSI via rssiInfo (65536 → null) and HmIP RSSI via maintenance datapoints", async () => {
    const { server, deps } = createTestServer({ sessionCall: rssiMock() });
    const result = parseToolResult(await callTool(server, "get_rssi")) as any;

    const byAddr = Object.fromEntries(result.devices.map((d: any) => [d.address, d]));
    // BidCos via rssiInfo: 65536 sentinel → null, other direction kept
    expect(byAddr.DEF456.links[0].rssiDevice).toBeNull();
    expect(byAddr.DEF456.links[0].rssiPeer).toBe(-80);
    // HmIP via RSSI_DEVICE datapoint (rssiInfo threw for HmIP-RF)
    expect(byAddr.ABC123.name).toBe("Thermostat Büro");
    expect(byAddr.ABC123.links[0].rssiDevice).toBe(-72);
    expect(byAddr.ABC123.links[0].rssiPeer).toBeNull(); // no RSSI_PEER datapoint
    cleanupDeps(deps);
  });

  it("includes BidCos interface health (duty cycle, connected)", async () => {
    const { server, deps } = createTestServer({ sessionCall: rssiMock() });
    const result = parseToolResult(await callTool(server, "get_rssi")) as any;
    expect(result.interfaces[0].DUTY_CYCLE).toBe(12);
    expect(result.interfaces[0].CONNECTED).toBe(true);
    cleanupDeps(deps);
  });

  it("filters by device name/address substring", async () => {
    const { server, deps } = createTestServer({ sessionCall: rssiMock() });
    const result = parseToolResult(await callTool(server, "get_rssi", { name: "küche" })) as any;
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].address).toBe("DEF456");
    cleanupDeps(deps);
  });

  it("tolerates interfaces that don't support rssiInfo (e.g. VirtualDevices)", async () => {
    const { server, deps } = createTestServer({ sessionCall: rssiMock() });
    const result = parseToolResult(await callTool(server, "get_rssi")) as any;
    expect(result.devices).toHaveLength(2); // both RF devices present despite VirtualDevices throwing
    cleanupDeps(deps);
  });

  it("tolerates listBidcosInterfaces failure (returns empty interfaces)", async () => {
    const base = rssiMock().getMockImplementation()!;
    const sessionCall = vi.fn().mockImplementation(async (method: string, params?: any) => {
      if (method === "Interface.listBidcosInterfaces") throw new Error("unsupported");
      return base(method, params);
    });
    const { server, deps } = createTestServer({ sessionCall });
    const result = parseToolResult(await callTool(server, "get_rssi")) as any;
    expect(result.interfaces).toEqual([]);
    cleanupDeps(deps);
  });
});

describe("get_system_info handler", () => {
  it("returns all system info fields", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockImplementation(async (method: string) => {
        const responses: Record<string, unknown> = {
          "CCU.getVersion": "3.75.6",
          "CCU.getSerial": "NEQ1234567",
          "CCU.getAddress": "192.168.0.35",
          "CCU.getHmIPAddress": "0014DA12345678",
        };
        return responses[method] ?? null;
      }),
    });

    const result = parseToolResult(await callTool(server, "get_system_info")) as any;
    expect(result.version).toBe("3.75.6");
    expect(result.serial).toBe("NEQ1234567");
    expect(result.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.cacheTypes).toBe(0);
    expect(typeof result.cacheWarming).toBe("boolean");
    cleanupDeps(deps);
  });

  it("returns null for individual call failures", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockImplementation(async (method: string) => {
        if (method === "CCU.getSerial") throw new Error("fail");
        return "ok";
      }),
    });

    const result = parseToolResult(await callTool(server, "get_system_info")) as any;
    expect(result.version).toBe("ok");
    expect(result.serial).toBe(null);
    cleanupDeps(deps);
  });
});

describe("error and edge paths (coverage round)", () => {
  it("get_system_info returns null for failing CCU calls but keeps the rest", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockImplementation(async (method: string) => {
        if (method === "CCU.getVersion") return "3.85.7";
        throw new Error("unsupported");
      }),
    });
    const result = parseToolResult(await callTool(server, "get_system_info")) as any;
    expect(result.version).toBe("3.85.7");
    expect(result.serial).toBeNull();
    expect(result.hmipAddress).toBeNull();
    cleanupDeps(deps);
  });

  it("get_service_messages maps CcuError to a structured tool error", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new CcuError({ error: "CCU_ERROR", code: 501, message: "rega busy", hint: "" })),
    });
    const result: any = await callTool(server, "get_service_messages");
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("CCU_ERROR");
    cleanupDeps(deps);
  });
});

describe("merge fallbacks (coverage round)", () => {
  it("handles the alarms format without channelNames", async () => {
    const mock = JSON.stringify({ alarms: [{ id: "1", type: "LOWBAT", address: "ABC:0", timestamp: "t" }] });
    const { server, deps } = createTestServer({ sessionCall: vi.fn().mockResolvedValue(mock) });
    const result = parseToolResult(await callTool(server, "get_service_messages")) as any[];
    expect(result[0].channelName).toBe("");
    cleanupDeps(deps);
  });
});
