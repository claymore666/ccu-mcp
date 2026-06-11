import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestServer, callTool, parseToolResult, cleanupDeps } from "./_helpers.js";

describe("help handler", () => {
  it("returns conceptual guide when no topic", async () => {
    const { server, deps } = createTestServer();
    const result = parseToolResult(await callTool(server, "help", {}));
    expect(typeof result).toBe("string");
    expect((result as string)).toContain("HomeMatic via debmatic-mcp");
    expect((result as string)).toContain("Object Hierarchy");
    cleanupDeps(deps);
  });

  it("returns tool help for known tool name", async () => {
    const { server, deps } = createTestServer();
    const result = parseToolResult(await callTool(server, "help", { topic: "set_value" }));
    expect(typeof result).toBe("string");
    expect((result as string)).toContain("set_value");
    expect((result as string)).toContain("Idempotent");
    cleanupDeps(deps);
  });

  it("returns device type info from cache", async () => {
    const { server, deps } = createTestServer();
    (deps.deviceTypeCache as any).cache.set("HmIP-eTRV-2", {
      interface: "HmIP-RF",
      channels: { "1": { type: "HEATING", paramsets: {} } },
    });

    const result = parseToolResult(await callTool(server, "help", { topic: "HmIP-eTRV-2" })) as any;
    expect(result.deviceType).toBe("HmIP-eTRV-2");
    expect(result.interface).toBe("HmIP-RF");
    cleanupDeps(deps);
  });

  it("returns error with lists for unknown topic", async () => {
    const { server, deps } = createTestServer();
    const result = parseToolResult(await callTool(server, "help", { topic: "nonexistent" }));
    expect(typeof result).toBe("string");
    expect((result as string)).toContain("Unknown topic");
    expect((result as string)).toContain("set_value"); // available tools list
    cleanupDeps(deps);
  });
});

describe("run_script handler", () => {
  it("passes script to ReGa.runScript", async () => {
    const sessionCall = vi.fn().mockResolvedValue("script output");
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "run_script", { script: 'Write("hello");' }));
    expect(result).toBe("script output");
    expect(sessionCall).toHaveBeenCalledWith(
      "ReGa.runScript",
      expect.objectContaining({ script: 'Write("hello");' }),
      10000, // scriptTimeout
    );
    cleanupDeps(deps);
  });
});

describe("run_script error paths (coverage round)", () => {
  it("maps CcuError to a structured tool error", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new CcuError({ error: "TIMEOUT", code: 0, message: "slow script", hint: "" })),
    });
    const result: any = await callTool(server, "run_script", { script: "Write(1);" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("TIMEOUT");
    cleanupDeps(deps);
  });
});
