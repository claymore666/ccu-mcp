import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpServer } from "../../src/server.js";
import { createMockDeps } from "./_helpers.js";

describe("MCP Server Registration", () => {
  it("creates server without errors", () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);
    expect(server).toBeDefined();
    deps.rateLimiter.destroy();
  });

  it("announces an identity a client can display, not just a package name", () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);
    const info = (server.server as any)._serverInfo as Record<string, unknown>;
    expect(info.title).toBe("HomeMatic CCU");
    expect(info.websiteUrl).toContain("github.com/claymore666/ccu-mcp");
    // Mirrors server.json's description, so the registry entry and the live
    // handshake cannot say different things about what this server is.
    expect(info.description).toBe(
      JSON.parse(readFileSync(join(__dirname, "../../server.json"), "utf-8")).description,
    );
    deps.rateLimiter.destroy();
  });

  it("ships instructions naming the write gate and how names resolve", () => {
    // These reach the model without it choosing to call `help`, so the two
    // facts that decide whether a first call succeeds have to be in here.
    const deps = createMockDeps();
    const server = createMcpServer(deps);
    const instructions = (server.server as any)._instructions as string;
    expect(instructions).toContain("confirm: true");
    expect(instructions).toContain("run_script");
    expect(instructions).toMatch(/name/i);
    deps.rateLimiter.destroy();
  });

  it("advertises the completions capability, backed by completable prompt arguments", () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);
    // The SDK turns this capability on by itself the moment a prompt argument
    // is completable, so asserting it here is really asserting that the
    // completers in prompts/registry.ts are still wired up.
    const caps = (server.server as any)._capabilities as Record<string, unknown>;
    expect(caps.completions).toBeDefined();
    deps.rateLimiter.destroy();
  });

  it("registers all tools", () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);

    const tools = (server as any)._registeredTools as Record<string, unknown>;
    const toolNames = Object.keys(tools).sort();

    expect(toolNames).toEqual([
      "acknowledge_service_messages",
      "assign_channel",
      "create_system_variable",
      "delete_system_variable",
      "describe_device_type",
      "execute_program",
      "get_connection_info",
      "get_paramset",
      "get_rssi",
      "get_service_messages",
      "get_system_info",
      "get_value",
      "get_values",
      "help",
      "list_ccu_targets",
      "list_devices",
      "list_functions",
      "list_interfaces",
      "list_links",
      "list_programs",
      "list_rooms",
      "list_system_variables",
      "put_paramset",
      "run_script",
      "set_system_variable",
      "set_value",
      "unassign_channel",
      "use_ccu",
    ]);

    expect(Object.keys(tools).length).toBe(28);
    deps.rateLimiter.destroy();
  });

  it("registers all 8 resources", () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);

    const resources = (server as any)._registeredResources as Record<string, unknown>;
    const uris = Object.keys(resources).sort();

    expect(uris).toEqual([
      "homematic://device-types",
      "homematic://devices",
      "homematic://functions",
      "homematic://interfaces",
      "homematic://programs",
      "homematic://rooms",
      "homematic://system",
      "homematic://sysvars",
    ]);

    expect(Object.keys(resources).length).toBe(8);
    deps.rateLimiter.destroy();
  });

  it("registers all 6 prompts", () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);

    const prompts = (server as any)._registeredPrompts as Record<string, unknown>;
    const names = Object.keys(prompts).sort();

    expect(names).toEqual([
      "check-windows",
      "device-info",
      "diagnostics",
      "good-night",
      "room-status",
      "set-heating",
    ]);

    expect(Object.keys(prompts).length).toBe(6);
    deps.rateLimiter.destroy();
  });
});

// Issue #27: tool annotation hints drive client UX (auto-approve safe reads,
// reason about retries). These assert the invariants, not each tool by hand.
describe("Tool annotations", () => {
  const READ_TOOLS = [
    "describe_device_type", "get_paramset", "get_service_messages", "get_system_info",
    "get_rssi", "get_value", "get_values", "help", "list_devices", "list_functions",
    "list_interfaces", "list_links", "list_programs", "list_rooms", "list_system_variables",
  ];
  const WRITE_TOOLS = ["acknowledge_service_messages", "assign_channel", "create_system_variable", "delete_system_variable", "execute_program", "put_paramset", "run_script", "set_system_variable", "set_value", "unassign_channel"];
  const IDEMPOTENT_WRITES = ["acknowledge_service_messages", "assign_channel", "delete_system_variable", "put_paramset", "set_system_variable", "set_value", "unassign_channel"];
  // help + the target-management tools are local-only (never reach a CCU).
  const LOCAL_TOOLS = ["help", "list_ccu_targets", "get_connection_info", "use_ccu"];

  type Ann = {
    title?: string; readOnlyHint?: boolean; destructiveHint?: boolean;
    idempotentHint?: boolean; openWorldHint?: boolean;
  };
  function annotationsByTool(): Record<string, Ann> {
    const deps = createMockDeps();
    const server = createMcpServer(deps);
    const tools = (server as any)._registeredTools as Record<string, { annotations?: Ann }>;
    const out: Record<string, Ann> = {};
    for (const [name, t] of Object.entries(tools)) out[name] = t.annotations ?? {};
    deps.rateLimiter.destroy();
    return out;
  }

  it("read tools set readOnlyHint and carry no write hints", () => {
    const ann = annotationsByTool();
    for (const name of READ_TOOLS) {
      expect(ann[name].readOnlyHint, name).toBe(true);
      expect(ann[name].destructiveHint, name).toBeUndefined();
      expect(ann[name].idempotentHint, name).toBeUndefined();
    }
  });

  it("write tools set destructiveHint and never readOnlyHint", () => {
    const ann = annotationsByTool();
    for (const name of WRITE_TOOLS) {
      expect(ann[name].destructiveHint, name).toBe(true);
      expect(ann[name].readOnlyHint, name).not.toBe(true);
    }
  });

  it("idempotentHint marks only the idempotent writes", () => {
    const ann = annotationsByTool();
    for (const name of WRITE_TOOLS) {
      expect(ann[name].idempotentHint ?? false, name).toBe(IDEMPOTENT_WRITES.includes(name));
    }
  });

  it("openWorldHint is true for CCU-reaching tools, false for local help", () => {
    const ann = annotationsByTool();
    for (const [name, a] of Object.entries(ann)) {
      expect(a.openWorldHint, name).toBe(!LOCAL_TOOLS.includes(name));
    }
  });

  it("drops the redundant annotations.title (it duplicates the top-level title)", () => {
    const ann = annotationsByTool();
    for (const [name, a] of Object.entries(ann)) {
      expect(a.title, name).toBeUndefined();
    }
  });
});
