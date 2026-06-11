import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildGetValuesScript, tryParseJson } from "../../src/tools/read.js";
import { createTestServer, callTool, parseToolResult, cleanupDeps } from "./_helpers.js";

describe("buildGetValuesScript", () => {
  it("generates address-based script", () => {
    // Production code builds sentinel-comma format: ",addr1:1,addr2:1,"
    const script = buildGetValuesScript('",addr1:1,addr2:1,"', "addresses");
    expect(script).toContain("targetAddrs");
    expect(script).toContain("Find(needle)");
    expect(script).toContain("ch.DPs()");
  });

  // Regression: names/values were interpolated into JSON unescaped (issue #3)
  it("JSON-escapes channel names and datapoint values in the script", () => {
    const script = buildGetValuesScript('",addr1:1,"', "addresses");
    expect(script).toContain('chNameEsc.Replace("\\\\", "\\\\\\\\")');
    expect(script).toContain('chNameEsc.Replace("\\"", "\\\\\\"")');
    expect(script).toContain('dpValEsc.Replace("\\\\", "\\\\\\\\")');
    expect(script).toContain('dpValEsc.Replace("\\"", "\\\\\\"")');
  });

  it("generates room-based script", () => {
    const script = buildGetValuesScript('"Wohnzimmer"', "room");
    expect(script).toContain("ID_ROOMS");
    expect(script).toContain("Wohnzimmer");
  });

  it("generates function-based script", () => {
    const script = buildGetValuesScript('"Heating"', "function");
    expect(script).toContain("ID_FUNCTIONS");
    expect(script).toContain("Heating");
  });
});

describe("tryParseJson (from read.ts)", () => {
  it("parses valid JSON", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns raw string for invalid JSON", () => {
    expect(tryParseJson("not json")).toBe("not json");
  });
});

describe("get_values handler", () => {
  it("returns error when no filter provided", async () => {
    const { server, deps } = createTestServer();
    const result = await callTool(server, "get_values", {}) as any;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
    cleanupDeps(deps);
  });

  it("executes script for channels array", async () => {
    const sessionCall = vi.fn().mockResolvedValue('[{"address":"A:1","name":"Ch","datapoints":{}}]');
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "get_values", { channels: ["A:1", "B:1"] }));
    expect(Array.isArray(result)).toBe(true);
    expect(sessionCall).toHaveBeenCalledWith("ReGa.runScript", expect.anything(), expect.any(Number));
    cleanupDeps(deps);
  });

  it("executes script for room filter", async () => {
    const sessionCall = vi.fn().mockResolvedValue("[]");
    const { server, deps } = createTestServer({ sessionCall });

    await callTool(server, "get_values", { room: "Wohnzimmer" });
    const script = sessionCall.mock.calls[0][1].script;
    expect(script).toContain("ID_ROOMS");
    cleanupDeps(deps);
  });

  it("returns raw string when result is not JSON", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue("raw output"),
    });

    const result = parseToolResult(await callTool(server, "get_values", { channels: ["A:1"] }));
    expect(result).toBe("raw output");
    cleanupDeps(deps);
  });
});

describe("get_value handler", () => {
  // Populate resolver via deps in each test

  it("returns value with auto-resolved interface", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue(21.5),
    });
    deps.resolver.updateDeviceList([{ id: "1", name: "Dev", address: "AAA", interface: "HmIP-RF", type: "T", operateGroupOnly: "false", isReady: "true", channels: [] }] as any);

    const result = parseToolResult(await callTool(server, "get_value", { address: "AAA:1", valueKey: "ACTUAL_TEMPERATURE" })) as any;
    expect(result.value).toBe(21.5);
    expect(result.address).toBe("AAA:1");
    cleanupDeps(deps);
  });

  it("uses explicit interface when provided", async () => {
    const sessionCall = vi.fn().mockResolvedValue(true);
    const { server, deps } = createTestServer({ sessionCall });

    await callTool(server, "get_value", { address: "AAA:1", valueKey: "STATE", interface: "BidCos-RF" });
    expect(sessionCall).toHaveBeenCalledWith("Interface.getValue", expect.objectContaining({ interface: "BidCos-RF" }));
    cleanupDeps(deps);
  });
});

describe("get_paramset handler", () => {
  // Populate resolver via deps in each test

  it("reads paramset with auto-resolved interface", async () => {
    const mockParamset = [{ ID: "TEMP", TYPE: "FLOAT", OPERATIONS: "5" }];
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue(mockParamset),
    });
    deps.resolver.updateDeviceList([{ id: "1", name: "Dev", address: "AAA", interface: "HmIP-RF", type: "T", operateGroupOnly: "false", isReady: "true", channels: [] }] as any);

    const result = parseToolResult(await callTool(server, "get_paramset", { address: "AAA:1", paramsetKey: "VALUES" })) as any;
    expect(result.paramsetKey).toBe("VALUES");
    expect(result.params).toEqual(mockParamset);
    cleanupDeps(deps);
  });
});

describe("error and edge paths (coverage round)", () => {
  it("get_value maps CcuError to a structured tool error", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new CcuError({ error: "NOT_FOUND", code: 502, message: "no device", hint: "" })),
    });
    const result: any = await callTool(server, "get_value", { address: "XXX:1", valueKey: "STATE", interface: "HmIP-RF" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("NOT_FOUND");
    cleanupDeps(deps);
  });

  it("get_paramset parses flat object values to native types", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue({ LEVEL: "0.500000", STATE: "true" }),
    });
    const result = parseToolResult(await callTool(server, "get_paramset", { address: "AAA:1", paramsetKey: "VALUES", interface: "HmIP-RF" })) as any;
    expect(result.params.LEVEL).toBe(0.5);
    expect(result.params.STATE).toBe(true);
    cleanupDeps(deps);
  });

  it("get_paramset passes arrays through unparsed", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue([1, 2, 3]),
    });
    const result = parseToolResult(await callTool(server, "get_paramset", { address: "AAA:1", paramsetKey: "LINK", interface: "HmIP-RF" })) as any;
    expect(result.params).toEqual([1, 2, 3]);
    cleanupDeps(deps);
  });

  it("get_values maps CcuError (script timeout) to a structured tool error", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new CcuError({ error: "TIMEOUT", code: 0, message: "slow", hint: "" })),
    });
    const result: any = await callTool(server, "get_values", { room: "Bad" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("TIMEOUT");
    cleanupDeps(deps);
  });

  it("get_values returns object results from the CCU as-is", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue([{ already: "parsed" }]),
    });
    const result = parseToolResult(await callTool(server, "get_values", { channels: ["AAA:1"] })) as any;
    expect(result).toEqual([{ already: "parsed" }]);
    cleanupDeps(deps);
  });
});
