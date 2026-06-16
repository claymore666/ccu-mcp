import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inferType } from "../../src/tools/control.js";
import { createTestServer, callTool, parseToolResult, cleanupDeps } from "./_helpers.js";

describe("inferType", () => {
  it("returns 'bool' for booleans", () => {
    expect(inferType(true)).toBe("bool");
    expect(inferType(false)).toBe("bool");
  });

  it("returns 'int' for integers", () => {
    expect(inferType(0)).toBe("int");
    expect(inferType(42)).toBe("int");
    expect(inferType(-1)).toBe("int");
  });

  it("returns 'double' for floats", () => {
    expect(inferType(3.14)).toBe("double");
    expect(inferType(0.5)).toBe("double");
  });

  it("returns 'string' for strings", () => {
    expect(inferType("hello")).toBe("string");
    expect(inferType("")).toBe("string");
  });
});

describe("set_value handler", () => {
  it("reads previous value before writing", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn()
        .mockResolvedValueOnce(21.5)    // getValue (pre-read)
        .mockResolvedValueOnce(true),   // setValue
    });

    const result = parseToolResult(await callTool(server, "set_value", {
      address: "ABC123:1", valueKey: "SET_POINT_TEMPERATURE", value: 22.0, interface: "HmIP-RF", type: "double",
    }));

    expect((result as any).previousValue).toBe(21.5);
    expect((result as any).newValue).toBe(22.0);
    cleanupDeps(deps);
  });

  it("continues write if previous-value read fails", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn()
        .mockRejectedValueOnce(new Error("unreachable"))  // getValue fails
        .mockResolvedValueOnce(true),                       // setValue succeeds
    });

    const result = parseToolResult(await callTool(server, "set_value", {
      address: "ABC123:1", valueKey: "STATE", value: true, interface: "HmIP-RF", type: "bool",
    }));

    expect((result as any).previousValue).toBe(null);
    expect((result as any).newValue).toBe(true);
    cleanupDeps(deps);
  });

  it("falls back to inferType when type not provided and cache empty", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue(true),
    });

    const result = parseToolResult(await callTool(server, "set_value", {
      address: "ABC123:1", valueKey: "STATE", value: true, interface: "HmIP-RF",
    }));

    expect((result as any).type).toBe("bool");
    cleanupDeps(deps);
  });
});

describe("set_system_variable handler", () => {
  // Regression: missing variables silently fell back to SysVar.setBool (issue #9)
  it("returns NOT_FOUND error when the variable does not exist", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValueOnce([{ name: "Anwesenheit", type: "BOOL" }]), // SysVar.getAll
    });

    const result: any = await callTool(server, "set_system_variable", { name: "DoesNotExist", value: true });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("NOT_FOUND");
    expect(parsed.message).toContain("DoesNotExist");
    cleanupDeps(deps);
  });

  it("returns INVALID_INPUT error for unsupported variable types", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValueOnce([{ name: "Weird", type: "TIMESTAMP" }]), // SysVar.getAll
    });

    const result: any = await callTool(server, "set_system_variable", { name: "Weird", value: "x" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("INVALID_INPUT");
    cleanupDeps(deps);
  });

  // Issue #10: variable types are cached for 30s — one SysVar.getAll across calls
  it("caches sysvar types so repeated writes fetch SysVar.getAll only once", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "SysVar.getAll") return [{ name: "Anwesenheit", type: "BOOL" }];
      return true;
    });
    const { server, deps } = createTestServer({ sessionCall });

    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: true });
    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: false });

    const getAllCalls = sessionCall.mock.calls.filter((c: unknown[]) => c[0] === "SysVar.getAll");
    expect(getAllCalls.length).toBe(1);
    cleanupDeps(deps);
  });

  it("refetches the sysvar list on a fresh-cache miss (new variable)", async () => {
    let round = 0;
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "SysVar.getAll") {
        round++;
        return round === 1
          ? [{ name: "Anwesenheit", type: "BOOL" }]
          : [{ name: "Anwesenheit", type: "BOOL" }, { name: "NeueVariable", type: "FLOAT" }];
      }
      return true;
    });
    const { server, deps } = createTestServer({ sessionCall });

    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: true });
    const result = parseToolResult(await callTool(server, "set_system_variable", { name: "NeueVariable", value: 1.5 }));

    expect((result as any).method).toBe("SysVar.setFloat");
    expect(round).toBe(2); // cache was fresh but missed → refetched
    cleanupDeps(deps);
  });

  it("uses ReGa.runScript for string variables, with escaping", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "SysVar.getAll") return [{ name: "Notiz", type: "STRING" }];
      return "";
    });
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "set_system_variable", { name: "Notiz", value: 'say "hi" #1' }));

    expect((result as any).method).toBe("ReGa.runScript (string)");
    const scriptCall = sessionCall.mock.calls.find((c: unknown[]) => c[0] === "ReGa.runScript");
    const script = (scriptCall![1] as { script: string }).script;
    expect(script).toContain('say \\"hi\\" #1'); // quotes escaped, # untouched (issue #16)
    cleanupDeps(deps);
  });

  it("uses SysVar.setFloat for enum variables", async () => {
    const sessionCall = vi.fn()
      .mockResolvedValueOnce([{ name: "Modus", type: "ENUM" }])
      .mockResolvedValueOnce(true);
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "set_system_variable", { name: "Modus", value: 2 }));

    expect((result as any).method).toBe("SysVar.setFloat");
    cleanupDeps(deps);
  });

  it("uses SysVar.setBool for bool variables", async () => {
    const sessionCall = vi.fn()
      .mockResolvedValueOnce([{ name: "Anwesenheit", type: "BOOL" }]) // SysVar.getAll
      .mockResolvedValueOnce(true);                                    // SysVar.setBool
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "set_system_variable", { name: "Anwesenheit", value: true }));

    expect((result as any).method).toBe("SysVar.setBool");
    expect(sessionCall).toHaveBeenLastCalledWith("SysVar.setBool", { name: "Anwesenheit", value: true });
    cleanupDeps(deps);
  });
});

describe("create_system_variable handler", () => {
  const reGaScriptOf = (sessionCall: any): string => {
    const call = sessionCall.mock.calls.find((c: unknown[]) => c[0] === "ReGa.runScript");
    return call?.[1]?.script ?? "";
  };

  it("creates a bool variable via ReGa and reports created:true", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "SysVar.getAll") return []; // no existing vars
      return null;
    });
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "create_system_variable", { name: "Urlaub", type: "bool" })) as any;
    expect(result).toEqual({ name: "Urlaub", type: "bool", created: true });
    const script = reGaScriptOf(sessionCall);
    expect(script).toContain("ivtBinary");
    expect(script).toContain("istBool");
    expect(script).toContain('sv.Name("Urlaub")');
    // ValueUnit/DPInfo (and the verifying WriteLine) come AFTER oSysVars.Add — a
    // CCU naming quirk renames the variable if they're set before Add.
    expect(script.indexOf("oSysVars.Add")).toBeLessThan(script.indexOf("WriteLine(sv.Name())"));
    cleanupDeps(deps);
  });

  it("rejects a CCU name-dedup (script echoes a suffixed name) and cleans it up", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "SysVar.getAll") return [];        // exact name looks free…
      if (method === "ReGa.runScript") return "Urlaub 1"; // …but the CCU deduped it
      return null;
    });
    const { server, deps } = createTestServer({ sessionCall });

    const result: any = await callTool(server, "create_system_variable", { name: "Urlaub", type: "bool" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
    // the unintended, dedup'd variable is removed
    expect(sessionCall.mock.calls.some(
      (c: unknown[]) => c[0] === "SysVar.deleteSysVarByName" && (c[1] as any)?.name === "Urlaub 1",
    )).toBe(true);
    cleanupDeps(deps);
  });

  it("creates a float variable with unit/min/max", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => (method === "SysVar.getAll" ? [] : null));
    const { server, deps } = createTestServer({ sessionCall });

    await callTool(server, "create_system_variable", { name: "Soll", type: "float", unit: "°C", min: 5, max: 30 });
    const script = reGaScriptOf(sessionCall);
    expect(script).toContain("ivtFloat");
    expect(script).toContain('sv.ValueUnit("°C")');
    expect(script).toContain("sv.ValueMin(5)");
    expect(script).toContain("sv.ValueMax(30)");
    cleanupDeps(deps);
  });

  it("rejects an enum without values (INVALID_INPUT, before any CCU call)", async () => {
    const sessionCall = vi.fn();
    const { server, deps } = createTestServer({ sessionCall });
    const result: any = await callTool(server, "create_system_variable", { name: "Modus", type: "enum" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
    expect(sessionCall).not.toHaveBeenCalled();
    cleanupDeps(deps);
  });

  it("rejects a duplicate name (INVALID_INPUT)", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) =>
      method === "SysVar.getAll" ? [{ name: "Urlaub", type: "BOOL" }] : null);
    const { server, deps } = createTestServer({ sessionCall });
    const result: any = await callTool(server, "create_system_variable", { name: "Urlaub", type: "bool" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
    cleanupDeps(deps);
  });
});

describe("delete_system_variable handler", () => {
  it("deletes an existing variable via deleteSysVarByName", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) =>
      method === "SysVar.getAll" ? [{ name: "Urlaub", type: "BOOL" }] : null);
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "delete_system_variable", { name: "Urlaub" })) as any;
    expect(result).toEqual({ name: "Urlaub", deleted: true });
    expect(sessionCall.mock.calls.some((c: unknown[]) => c[0] === "SysVar.deleteSysVarByName")).toBe(true);
    cleanupDeps(deps);
  });

  it("returns NOT_FOUND for an unknown name (and never calls delete)", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => (method === "SysVar.getAll" ? [] : null));
    const { server, deps } = createTestServer({ sessionCall });
    const result: any = await callTool(server, "delete_system_variable", { name: "Ghost" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("NOT_FOUND");
    expect(sessionCall.mock.calls.some((c: unknown[]) => c[0] === "SysVar.deleteSysVarByName")).toBe(false);
    cleanupDeps(deps);
  });
});

describe("sysvar type cache invalidation (issue #24)", () => {
  it("create_system_variable invalidates the shared type cache so the next set re-fetches", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "SysVar.getAll") return [{ name: "Anwesenheit", type: "BOOL" }];
      return null;
    });
    const { server, deps } = createTestServer({ sessionCall });
    const getAllCount = () => sessionCall.mock.calls.filter((c: unknown[]) => c[0] === "SysVar.getAll").length;

    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: true });  // getAll #1 (cache fill)
    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: false }); // cached → no getAll
    expect(getAllCount()).toBe(1);

    await callTool(server, "create_system_variable", { name: "Neu", type: "bool" });        // getAll #2 (dup check) + invalidate
    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: true });    // cache invalidated → getAll #3
    expect(getAllCount()).toBe(3);
    cleanupDeps(deps);
  });
});

describe("assign_channel / unassign_channel handlers", () => {
  const membershipMock = () =>
    vi.fn().mockImplementation(async (method: string) => {
      switch (method) {
        case "Device.listAllDetail":
          return [{
            id: "1", name: "Sensor", address: "AAA", interface: "HmIP-RF", type: "x",
            operateGroupOnly: "false", isReady: "true",
            channels: [{ id: "ch10", name: "Kanal", address: "AAA:1", deviceId: "1", index: 1 }],
          }];
        case "Room.getAll":
          return [{ id: "room5", name: "Schlafzimmer", channelIds: [] }];
        case "Subsection.getAll":
          return [{ id: "fn3", name: "Licht", channelIds: [] }];
        default:
          return true; // add/removeChannel ack
      }
    });

  it("assigns a channel to a room by resolving names→IDs", async () => {
    const sessionCall = membershipMock();
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "assign_channel", { channel: "AAA:1", room: "Schlafzimmer" })) as any;
    expect(result.assignedTo).toEqual([{ kind: "room", name: "Schlafzimmer" }]);
    const call = sessionCall.mock.calls.find((c: unknown[]) => c[0] === "Room.addChannel");
    expect(call?.[1]).toEqual({ id: "room5", channelId: "ch10" });
    cleanupDeps(deps);
  });

  it("assigns a channel to a function (Subsection)", async () => {
    const sessionCall = membershipMock();
    const { server, deps } = createTestServer({ sessionCall });
    await callTool(server, "assign_channel", { channel: "AAA:1", function: "Licht" });
    const call = sessionCall.mock.calls.find((c: unknown[]) => c[0] === "Subsection.addChannel");
    expect(call?.[1]).toEqual({ id: "fn3", channelId: "ch10" });
    cleanupDeps(deps);
  });

  it("unassign_channel uses the remove APIs", async () => {
    const sessionCall = membershipMock();
    const { server, deps } = createTestServer({ sessionCall });
    const result = parseToolResult(await callTool(server, "unassign_channel", { channel: "AAA:1", room: "Schlafzimmer" })) as any;
    expect(result.removedFrom).toEqual([{ kind: "room", name: "Schlafzimmer" }]);
    expect(sessionCall.mock.calls.some((c: unknown[]) => c[0] === "Room.removeChannel")).toBe(true);
    cleanupDeps(deps);
  });

  it("INVALID_INPUT when neither room nor function is given", async () => {
    const sessionCall = membershipMock();
    const { server, deps } = createTestServer({ sessionCall });
    const result: any = await callTool(server, "assign_channel", { channel: "AAA:1" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
    cleanupDeps(deps);
  });

  it("NOT_FOUND for an unknown channel address", async () => {
    const sessionCall = membershipMock();
    const { server, deps } = createTestServer({ sessionCall });
    const result: any = await callTool(server, "assign_channel", { channel: "ZZZ:9", room: "Schlafzimmer" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("NOT_FOUND");
    cleanupDeps(deps);
  });

  it("NOT_FOUND for an unknown room, with valid names in the hint", async () => {
    const sessionCall = membershipMock();
    const { server, deps } = createTestServer({ sessionCall });
    const result: any = await callTool(server, "assign_channel", { channel: "AAA:1", room: "Nirgendwo" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe("NOT_FOUND");
    expect(body.hint).toContain("Schlafzimmer");
    cleanupDeps(deps);
  });
});

describe("execute_program handler", () => {
  const programList = [{ id: "123", name: "Morgenroutine" }];

  it("validates the ID and calls Program.execute", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "Program.getAll") return programList;
      return true;
    });
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "execute_program", { id: "123" }));

    expect((result as any).executed).toBe(true);
    expect((result as any).name).toBe("Morgenroutine");
    expect(sessionCall).toHaveBeenCalledWith("Program.execute", expect.objectContaining({ id: "123" }));
    cleanupDeps(deps);
  });

  // Regression: the CCU reports executed:true even for nonexistent IDs (issue #18)
  it("returns NOT_FOUND for nonexistent program IDs without executing", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "Program.getAll") return programList;
      return true;
    });
    const { server, deps } = createTestServer({ sessionCall });

    const result: any = await callTool(server, "execute_program", { id: "999999999" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("NOT_FOUND");
    expect(sessionCall).not.toHaveBeenCalledWith("Program.execute", expect.anything());
    cleanupDeps(deps);
  });
});

describe("remaining error paths (coverage round)", () => {
  it("set_value maps CcuError to a structured tool error", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new CcuError({ error: "INVALID_INPUT", code: 505, message: "bad key", hint: "" })),
    });
    const result: any = await callTool(server, "set_value", { address: "AAA:1", valueKey: "NOPE", value: 1, interface: "HmIP-RF" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
    cleanupDeps(deps);
  });

  it("set_value rethrows non-CcuError failures", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await expect(callTool(server, "set_value", { address: "AAA:1", valueKey: "STATE", value: true, interface: "HmIP-RF" }))
      .rejects.toThrow("boom");
    cleanupDeps(deps);
  });

  it("put_paramset resolves types from the device type cache", async () => {
    const sessionCall = vi.fn().mockResolvedValue(true);
    const { server, deps } = createTestServer({ sessionCall });
    deps.resolver.updateDeviceList([
      { id: "1", name: "T", address: "AAA", interface: "HmIP-RF", type: "HmIP-eTRV-2", operateGroupOnly: "false", isReady: "true", channels: [] },
    ] as any);
    (deps.deviceTypeCache as any).cache.set("HmIP-eTRV-2", {
      interface: "HmIP-RF",
      channels: { "1": { type: "HEATING", paramsets: { VALUES: { SET_POINT_TEMPERATURE: { type: "FLOAT", operations: 7 } } } } },
    });

    await callTool(server, "put_paramset", { address: "AAA:1", paramsetKey: "VALUES", set: { SET_POINT_TEMPERATURE: 21.5 }, interface: "HmIP-RF" });

    const call = sessionCall.mock.calls.find((c: unknown[]) => c[0] === "Interface.putParamset");
    expect((call![1] as any).set).toEqual([{ name: "SET_POINT_TEMPERATURE", type: "double", value: "21.5" }]);
    cleanupDeps(deps);
  });

  it("put_paramset maps CcuError to a structured tool error", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new CcuError({ error: "NOT_FOUND", code: 502, message: "no channel", hint: "" })),
    });
    const result: any = await callTool(server, "put_paramset", { address: "XXX:1", paramsetKey: "VALUES", set: { A: 1 }, interface: "HmIP-RF" });
    expect(result.isError).toBe(true);
    cleanupDeps(deps);
  });

  it("set_system_variable surfaces SysVar.getAll failures as structured errors", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new CcuError({ error: "UNREACHABLE", code: 0, message: "down", hint: "" })),
    });
    const result: any = await callTool(server, "set_system_variable", { name: "X", value: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("UNREACHABLE");
    cleanupDeps(deps);
  });
});
