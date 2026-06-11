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
