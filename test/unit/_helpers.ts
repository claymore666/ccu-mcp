import { vi } from "vitest";
import { createMcpServer, type ServerDeps } from "../../src/server.js";
import { Logger } from "../../src/logger.js";
import { RateLimiter } from "../../src/middleware/rate-limiter.js";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { Resolver } from "../../src/middleware/resolver.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createMockDeps(overrides?: {
  sessionCall?: (method: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>;
}): ServerDeps {
  const rateLimiter = new RateLimiter(1000, 1000); // effectively unlimited for tests
  return {
    config: {
      ccu: { host: "test", port: 80, https: false, tlsVerify: false, user: "Admin", password: "pw", timeout: 5000, scriptTimeout: 10000 },
      mcp: { transport: "stdio" as const, port: 3000 },
      cache: { dir: "/tmp", ttl: 86400 },
      rateLimiter: { burst: 1000, rate: 1000 },
      resourcePollInterval: 60,
    },
    session: {
      call: overrides?.sessionCall ?? vi.fn(async () => []),
      login: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      isLoggedIn: vi.fn(() => true),
      getSessionId: vi.fn(() => "test-session"),
      callNoSession: vi.fn(async () => null),
      destroy: vi.fn(),
    } as any,
    rateLimiter,
    logger: new Logger("error"),
    deviceTypeCache: new DeviceTypeCache("/tmp/nonexistent-test", 86400, new Logger("error")),
    resolver: new Resolver(),
  };
}

export function createTestServer(overrides?: Parameters<typeof createMockDeps>[0]) {
  const deps = createMockDeps(overrides);
  const server = createMcpServer(deps);
  return { server, deps };
}

export async function callTool(server: McpServer, toolName: string, args: Record<string, unknown> = {}) {
  const tools = (server as any)._registeredTools as Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool '${toolName}' not registered`);
  return tool.handler(args);
}

export async function readResource(server: McpServer, uri: string) {
  const resources = (server as any)._registeredResources as Record<string, { readCallback: (uri: URL, extra: unknown) => Promise<unknown> }>;
  const resource = resources[uri];
  if (!resource) throw new Error(`Resource '${uri}' not registered`);
  return resource.readCallback(new URL(uri), {});
}

export async function getPrompt(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const prompts = (server as any)._registeredPrompts as Record<string, { callback: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }>;
  const prompt = prompts[name];
  if (!prompt) throw new Error(`Prompt '${name}' not registered`);
  return prompt.callback(args, {});
}

export function parseToolResult(result: any): unknown {
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
  }
  return result;
}

export function cleanupDeps(deps: ServerDeps): void {
  deps.rateLimiter.destroy();
}
