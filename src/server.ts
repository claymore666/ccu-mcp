import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import type { SessionManager } from "./ccu/session.js";
import type { RateLimiter } from "./middleware/rate-limiter.js";
import type { Logger } from "./logger.js";
import type { DeviceTypeCache } from "./cache/device-type-cache.js";
import type { Resolver } from "./middleware/resolver.js";
import type { TargetRegistry, TargetSelection } from "./ccu/target-registry.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerReadTools } from "./tools/read.js";
import { registerControlTools } from "./tools/control.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerTargetTools } from "./tools/targets.js";
import { registerResources } from "./resources/registry.js";
import { registerPrompts } from "./prompts/registry.js";
import { VERSION } from "./utils.js";

export interface ServerDeps {
  config: AppConfig;
  /** All configured CCU targets (shared across MCP sessions). */
  targets: TargetRegistry;
  /**
   * THIS MCP session's active-target pointer + protected-target unlocks.
   * One per McpServer instance so concurrent HTTP clients can't retarget or
   * de-gate each other.
   */
  selection: TargetSelection;
  /**
   * The session-active target's session/resolver/device-type cache. These are
   * getters (see index.ts / _helpers.ts) that resolve to `selection.active.*`
   * on each access, so a use_ccu() switch is picked up by the next tool call
   * without touching any tool that reads `deps.session` etc.
   */
  readonly session: SessionManager;
  readonly resolver: Resolver;
  readonly deviceTypeCache: DeviceTypeCache;
  rateLimiter: RateLimiter;
  logger: Logger;
}

/**
 * Per-server resource subscriptions (URIs a client subscribed to via
 * resources/subscribe). The poller consults this to send
 * notifications/resources/updated only where they were asked for. WeakMap so
 * an evicted/closed server's entry is collectable with the server itself.
 */
export const serverSubscriptions = new WeakMap<McpServer, Set<string>>();

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: "ccu-mcp",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        // subscribe is backed by the handlers registered below; the poller
        // sends notifications/resources/updated for changed URIs to
        // subscribers (list_changed would be wrong — the list is static).
        resources: { listChanged: true, subscribe: true },
        prompts: {},
        logging: {},
      },
    },
  );

  registerDiscoveryTools(server, deps);
  registerReadTools(server, deps);
  registerControlTools(server, deps);
  registerDiagnosticsTools(server, deps);
  registerMetaTools(server, deps);
  registerTargetTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server);

  // resources/subscribe support: the SDK's McpServer registers no handler for
  // it, so back the advertised capability ourselves.
  const subscriptions = new Set<string>();
  serverSubscriptions.set(server, subscriptions);
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscriptions.delete(req.params.uri);
    return {};
  });

  return server;
}
