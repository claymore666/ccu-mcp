#!/usr/bin/env node

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { SessionManager } from "./ccu/session.js";
import { RateLimiter } from "./middleware/rate-limiter.js";
import { DeviceTypeCache } from "./cache/device-type-cache.js";
import { Resolver } from "./middleware/resolver.js";
import { ResourcePoller } from "./resources/poller.js";
import { resolveAuthToken } from "./auth/token.js";
import { handleHealthRequest } from "./health/handler.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig();

  logger.info("starting", {
    transport: config.mcp.transport,
    ccuHost: config.ccu.host,
    ccuPort: config.ccu.port,
    https: config.ccu.https,
  });

  // Initialize CCU session
  const session = new SessionManager(config.ccu, logger, config.cache.dir);
  const rateLimiter = new RateLimiter(config.rateLimiter.burst, config.rateLimiter.rate);

  try {
    await session.login();
  } catch (err) {
    logger.error("startup_failed", { error: (err as Error).message });
    process.exit(1);
  }

  // Initialize device type cache
  const deviceTypeCache = new DeviceTypeCache(config.cache.dir, config.cache.ttl, logger);
  await deviceTypeCache.loadFromDisk();
  deviceTypeCache.warm(session, rateLimiter).catch((err) => {
    logger.error("cache_warm_background_error", { error: (err as Error).message });
  });

  // Create resolver and MCP server
  const resolver = new Resolver();
  const mcpServer = createMcpServer({ config, session, rateLimiter, logger, deviceTypeCache, resolver });

  // Start resource poller
  const poller = new ResourcePoller(mcpServer.server, session, rateLimiter, logger, config.resourcePollInterval);

  // Connect transport
  if (config.mcp.transport === "stdio") {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    poller.start();
    logger.info("server_ready", { transport: "stdio" });
  } else {
    // HTTP mode with auth
    const authToken = await resolveAuthToken(config.mcp.authToken, config.cache.dir, logger);

    const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    const httpServer = createServer(async (req, res) => {
      try {
        // Health check endpoint
        if (req.url === "/health" && req.method === "GET") {
          handleHealthRequest(req, res, { session, deviceTypeCache });
          return;
        }

        // Auth check for MCP endpoints. The scheme is case-insensitive per
        // RFC 7235; the token comparison is timing-safe (hash both sides so
        // length differences don't create a timing side-channel).
        const authHeader = req.headers.authorization ?? "";
        const presented = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
        const ha = createHash("sha256").update(presented).digest();
        const hb = createHash("sha256").update(authToken).digest();
        const headerValid = timingSafeEqual(ha, hb);
        if (!headerValid) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        // Delegate to MCP transport
        await httpTransport.handleRequest(req, res);
      } catch (err) {
        // One bad request must not take down the process (unhandled rejection)
        logger.error("http_handler_error", { error: (err as Error).message });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });

    await mcpServer.connect(httpTransport);
    poller.start();

    httpServer.listen(config.mcp.port, () => {
      logger.info("server_ready", { transport: "http", port: config.mcp.port });
    });
  }

  // Graceful shutdown with re-entrancy guard
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", { signal });

    // Safety net: force exit after 10s if graceful shutdown hangs
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();

    try {
      poller.stop();
      rateLimiter.destroy();
      await deviceTypeCache.saveToDisk();
      await session.logout();
      session.destroy();
      await mcpServer.close();
    } catch (err) {
      logger.error("shutdown_error", { error: (err as Error).message });
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
