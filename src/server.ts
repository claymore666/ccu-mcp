import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import type { SessionManager } from "./ccu/session.js";
import type { RateLimiter } from "./middleware/rate-limiter.js";
import type { Logger } from "./logger.js";
import type { DeviceTypeCache } from "./cache/device-type-cache.js";
import type { Resolver } from "./middleware/resolver.js";
import type { TargetRegistry } from "./ccu/target-registry.js";
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
  /** All configured CCU targets and the active pointer. */
  targets: TargetRegistry;
  /**
   * The ACTIVE target's session/resolver/device-type cache. These are getters
   * (see index.ts / _helpers.ts) that resolve to `targets.active.*` on each
   * access, so a use_ccu() switch is picked up by the next tool call without
   * touching any tool that reads `deps.session` etc.
   */
  readonly session: SessionManager;
  readonly resolver: Resolver;
  readonly deviceTypeCache: DeviceTypeCache;
  rateLimiter: RateLimiter;
  logger: Logger;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: "ccu-mcp",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
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

  return server;
}
