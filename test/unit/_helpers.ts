import { vi } from "vitest";
import { createMcpServer, type ServerDeps } from "../../src/server.js";
import { Logger } from "../../src/logger.js";
import { RateLimiter } from "../../src/middleware/rate-limiter.js";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { Resolver } from "../../src/middleware/resolver.js";
import type { Target, TargetRegistry } from "../../src/ccu/target-registry.js";
import { CcuError } from "../../src/middleware/error-mapper.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type SessionCall = (method: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>;

interface TargetSpec {
  name?: string;
  protected?: boolean;
  readonly?: boolean;
  password?: string;
  sessionCall?: SessionCall;
}

function makeSession(sessionCall?: SessionCall) {
  return {
    call: sessionCall ?? vi.fn(async () => []),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    isLoggedIn: vi.fn(() => true),
    getSessionId: vi.fn(() => "test-session"),
    callNoSession: vi.fn(async () => null),
    destroy: vi.fn(),
  } as any;
}

function makeTarget(spec: TargetSpec): Target {
  const name = spec.name ?? "default";
  return {
    profile: {
      name,
      protected: spec.protected ?? false,
      readonly: spec.readonly ?? false,
      ccu: { host: "test", port: 80, https: false, tlsVerify: false, user: "Admin", password: spec.password ?? "pw", timeout: 5000, scriptTimeout: 10000 },
    },
    session: makeSession(spec.sessionCall),
    resolver: new Resolver(),
    deviceTypeCache: new DeviceTypeCache("/tmp/nonexistent-test", 86400, new Logger("error"), `device-type-cache.${name}.json`),
    sysVarTypeCache: { entry: null },
    unlocked: false,
  };
}

// Minimal in-memory stand-in for TargetRegistry (real one builds live sessions).
class FakeRegistry {
  private readonly byName = new Map<string, Target>();
  private readonly order: string[] = [];
  private activeKey: string;
  constructor(targets: Target[]) {
    for (const t of targets) {
      this.byName.set(t.profile.name.toLowerCase(), t);
      this.order.push(t.profile.name);
    }
    this.activeKey = targets[0]!.profile.name.toLowerCase();
  }
  get active(): Target { return this.byName.get(this.activeKey)!; }
  getByName(name: string): Target | undefined { return this.byName.get(name.toLowerCase()); }
  has(name: string): boolean { return this.byName.has(name.toLowerCase()); }
  list(): Target[] { return this.order.map((n) => this.byName.get(n.toLowerCase())!); }
  use(name: string): Target {
    const t = this.getByName(name);
    if (!t) throw new CcuError({ error: "NOT_FOUND", code: 0, message: `Unknown CCU target: ${name}`, hint: "Call list_ccu_targets." });
    this.activeKey = t.profile.name.toLowerCase();
    return t;
  }
}

export function createMockDeps(overrides?: {
  sessionCall?: SessionCall;
  /** Mark the (single default) target protected. */
  protected?: boolean;
  /** Mark the (single default) target read-only. */
  readonly?: boolean;
  /** Build a multi-target registry instead of the single default target. */
  targets?: TargetSpec[];
}): ServerDeps {
  const rateLimiter = new RateLimiter(1000, 1000); // effectively unlimited for tests
  const specs: TargetSpec[] = overrides?.targets ?? [{
    name: "default",
    protected: overrides?.protected,
    readonly: overrides?.readonly,
    sessionCall: overrides?.sessionCall,
  }];
  const registry = new FakeRegistry(specs.map(makeTarget));

  return {
    config: {
      ccu: registry.active.profile.ccu,
      profiles: registry.list().map((t) => t.profile),
      defaultProfile: registry.active.profile.name,
      mcp: { transport: "stdio" as const, port: 3000, allowedOrigins: [], allowedHosts: [], allowPlaintext: false, authTokenGraceMs: 86400000 },
      cache: { dir: "/tmp", ttl: 86400 },
      rateLimiter: { burst: 1000, rate: 1000 },
      resourcePollInterval: 60,
    },
    targets: registry as unknown as TargetRegistry,
    get session() { return registry.active.session; },
    get resolver() { return registry.active.resolver; },
    get deviceTypeCache() { return registry.active.deviceTypeCache; },
    rateLimiter,
    logger: new Logger("error"),
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
