import { describe, it, expect } from "vitest";
import { createMcpServer } from "../../src/server.js";
import { Logger } from "../../src/logger.js";
import { RateLimiter } from "../../src/middleware/rate-limiter.js";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { Resolver } from "../../src/middleware/resolver.js";

// Minimal mock deps — we're testing that registration doesn't throw, not calling tools
function createMockDeps() {
  return {
    config: {
      ccu: { host: "test", port: 80, https: false, tlsVerify: false, user: "Admin", password: "pw", timeout: 5000, scriptTimeout: 10000 },
      mcp: { transport: "stdio" as const, port: 3000 },
      cache: { dir: "/tmp", ttl: 86400 },
      rateLimiter: { burst: 20, rate: 10 },
      resourcePollInterval: 60,
    },
    session: {
      call: async () => [],
      login: async () => {},
      logout: async () => {},
      isLoggedIn: () => true,
      getSessionId: () => "test",
      callNoSession: async () => null,
      destroy: () => {},
    } as any,
    rateLimiter: new RateLimiter(20, 10),
    logger: new Logger("error"),
    deviceTypeCache: new DeviceTypeCache("/tmp", 86400, new Logger("error")),
    resolver: new Resolver(),
  };
}

describe("MCP Server Registration", () => {
  it("creates server without errors", () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);
    expect(server).toBeDefined();
    deps.rateLimiter.destroy();
  });

  it("registers all 18 tools", () => {
    const deps = createMockDeps();
    const server = createMcpServer(deps);

    const tools = (server as any)._registeredTools as Record<string, unknown>;
    const toolNames = Object.keys(tools).sort();

    expect(toolNames).toEqual([
      "describe_device_type",
      "execute_program",
      "get_paramset",
      "get_service_messages",
      "get_system_info",
      "get_value",
      "get_values",
      "help",
      "list_devices",
      "list_functions",
      "list_interfaces",
      "list_programs",
      "list_rooms",
      "list_system_variables",
      "put_paramset",
      "run_script",
      "set_system_variable",
      "set_value",
    ]);

    expect(Object.keys(tools).length).toBe(18);
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
