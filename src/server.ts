import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import type { SessionManager } from "./ccu/session.js";
import type { RateLimiter } from "./middleware/rate-limiter.js";
import type { Logger } from "./logger.js";
import type { DeviceTypeCache } from "./cache/device-type-cache.js";
import type { Resolver } from "./middleware/resolver.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerReadTools } from "./tools/read.js";
import { registerControlTools } from "./tools/control.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerResources } from "./resources/registry.js";
import { registerPrompts } from "./prompts/registry.js";
import { VERSION } from "./utils.js";

export interface ServerDeps {
  config: AppConfig;
  session: SessionManager;
  rateLimiter: RateLimiter;
  logger: Logger;
  deviceTypeCache: DeviceTypeCache;
  resolver: Resolver;
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
  registerResources(server, deps);
  registerPrompts(server);

  return server;
}
