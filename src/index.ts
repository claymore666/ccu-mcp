#!/usr/bin/env node

import { createServer, type Server as HttpServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { extractBearerToken } from "./utils.js";

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

  // A failed login must not kill the server: the MCP transport starts anyway
  // (tool registration needs no CCU) and the session retries lazily on the
  // first CCU call. This keeps the server alive through CCU outages and lets
  // it start before the CCU is reachable.
  try {
    await session.login();
  } catch (err) {
    logger.warn("startup_degraded", {
      error: (err as Error).message,
      hint: "CCU unreachable at startup; will retry on first request",
    });
  }

  // Initialize device type cache
  const deviceTypeCache = new DeviceTypeCache(config.cache.dir, config.cache.ttl, logger);
  await deviceTypeCache.loadFromDisk();
  deviceTypeCache.warm(session, rateLimiter).catch((err) => {
    logger.error("cache_warm_background_error", { error: (err as Error).message });
  });

  // Create resolver and shared tool dependencies
  const resolver = new Resolver();
  const deps = { config, session, rateLimiter, logger, deviceTypeCache, resolver };

  let poller: ResourcePoller;
  let closeTransports: () => Promise<void>;
  let httpServer: HttpServer | null = null;

  if (config.mcp.transport === "stdio") {
    const mcpServer = createMcpServer(deps);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    poller = new ResourcePoller(
      () => mcpServer.server.sendResourceListChanged(),
      session, rateLimiter, logger, config.resourcePollInterval,
    );
    poller.start();
    closeTransports = () => mcpServer.close();
    logger.info("server_ready", { transport: "stdio" });
  } else {
    // HTTP mode with auth.
    // A stateless StreamableHTTPServerTransport only survives a single request,
    // so each MCP session gets its own transport + server (deps are shared),
    // routed by the Mcp-Session-Id header per the SDK's session pattern.
    const authToken = await resolveAuthToken(config.mcp.authToken, config.cache.dir, logger);
    const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

    httpServer = createServer(async (req, res) => {
      try {
        // CORS so browser-based MCP clients (e.g. MCP Inspector) can connect
        // directly. Auth is still enforced via the bearer token below.
        // Mcp-Session-Id must be exposed or browsers can't reuse the session.
        // Credit: @marcinn2 (marcinn2/debmatic-mcp@d33a0cb)
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
        );
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        res.setHeader("Access-Control-Max-Age", "86400");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Health check endpoint
        if (req.url === "/health" && req.method === "GET") {
          handleHealthRequest(req, res, { session, deviceTypeCache });
          return;
        }

        // Auth check for MCP endpoints. Token parsing tolerates the
        // case-insensitive scheme (RFC 7235); the comparison is timing-safe
        // (hash both sides so length differences don't leak via timing).
        const presented = extractBearerToken(req.headers.authorization ?? "");
        const ha = createHash("sha256").update(presented).digest();
        const hb = createHash("sha256").update(authToken).digest();
        const headerValid = timingSafeEqual(ha, hb);
        if (!headerValid) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        // Existing session: route to its transport (POST, GET/SSE, DELETE)
        const sessionId = req.headers["mcp-session-id"];
        if (typeof sessionId === "string" && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.transport.handleRequest(req, res);
          return;
        }

        // No (known) session: create a fresh transport + server pair. The
        // transport itself rejects non-initialize requests without a session.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server: sessionServer, transport });
            logger.info("mcp_session_started", { sessions: sessions.size });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId && sessions.delete(transport.sessionId)) {
            logger.info("mcp_session_closed", { sessions: sessions.size });
          }
        };
        const sessionServer = createMcpServer(deps);
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        // One bad request must not take down the process (unhandled rejection)
        logger.error("http_handler_error", { error: (err as Error).message });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });

    poller = new ResourcePoller(
      async () => {
        await Promise.allSettled(
          [...sessions.values()].map((s) => s.server.server.sendResourceListChanged()),
        );
      },
      session, rateLimiter, logger, config.resourcePollInterval,
    );
    poller.start();
    closeTransports = async () => {
      await Promise.allSettled([...sessions.values()].map((s) => s.server.close()));
      sessions.clear();
    };

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
      httpServer?.close();
      await deviceTypeCache.saveToDisk();
      await session.logout();
      session.destroy();
      await closeTransports();
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
