#!/usr/bin/env node

import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { RateLimiter } from "./middleware/rate-limiter.js";
import { TargetRegistry } from "./ccu/target-registry.js";
import { ResourcePoller } from "./resources/poller.js";
import { resolveAuthTokens } from "./auth/token.js";
import { handleHealthRequest } from "./health/handler.js";
import { createMcpServer, type ServerDeps } from "./server.js";
import { extractBearerToken, normalizeClientIp } from "./utils.js";

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig();

  logger.info("starting", {
    transport: config.mcp.transport,
    profiles: config.profiles.map((p) => p.name),
    activeProfile: config.defaultProfile,
    ccuHost: config.ccu.host,
    ccuPort: config.ccu.port,
    https: config.ccu.https,
  });

  // Initialize all configured CCU targets (issue #69). Each has its own session,
  // resolver, and per-target caches; `active` is the startup default.
  const rateLimiter = new RateLimiter(config.rateLimiter.burst, config.rateLimiter.rate);
  const targets = new TargetRegistry(config, logger, config.cache.dir);

  // A failed login must not kill the server: the MCP transport starts anyway
  // (tool registration needs no CCU) and the session retries lazily on the
  // first CCU call. This keeps the server alive through CCU outages and lets
  // it start before the CCU is reachable. Only the active target logs in eagerly;
  // others log in lazily on first use / switch.
  try {
    await targets.loginActive();
  } catch (err) {
    logger.warn("startup_degraded", {
      error: (err as Error).message,
      hint: "CCU unreachable at startup; will retry on first request",
    });
  }

  // Load each target's device-type cache; warm only the active one in background.
  await targets.loadCaches();
  targets.warmActive(rateLimiter).catch((err) => {
    logger.error("cache_warm_background_error", { error: (err as Error).message });
  });

  // Shared tool dependencies. session/resolver/deviceTypeCache are getters that
  // resolve to the ACTIVE target each access, so a use_ccu() switch is picked up
  // by the next tool call without touching tools that read deps.session etc.
  const deps: ServerDeps = {
    config,
    targets,
    get session() { return targets.active.session; },
    get resolver() { return targets.active.resolver; },
    get deviceTypeCache() { return targets.active.deviceTypeCache; },
    rateLimiter,
    logger,
  };

  let poller: ResourcePoller;
  let closeTransports: () => Promise<void>;
  let httpServer: HttpServer | HttpsServer | null = null;

  if (config.mcp.transport === "stdio") {
    const mcpServer = createMcpServer(deps);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    poller = new ResourcePoller(
      () => mcpServer.server.sendResourceListChanged(),
      targets.active.session, rateLimiter, logger, config.resourcePollInterval,
    );
    poller.start();
    closeTransports = () => mcpServer.close();
    logger.info("server_ready", { transport: "stdio" });
  } else {
    // HTTP mode with auth.
    // A stateless StreamableHTTPServerTransport only survives a single request,
    // so each MCP session gets its own transport + server (deps are shared),
    // routed by the Mcp-Session-Id header per the SDK's session pattern.
    const authTokens = await resolveAuthTokens(
      {
        envToken: config.mcp.authToken,
        envPreviousToken: config.mcp.authTokenPrevious,
        dataDir: config.cache.dir,
        ttlMs: config.mcp.authTokenTtlMs,
        graceMs: config.mcp.authTokenGraceMs,
      },
      logger,
    );
    const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

    const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
      try {
        // CORS so browser-based MCP clients (e.g. MCP Inspector) can connect
        // directly. Default-deny against a configurable origin allowlist
        // (MCP_ALLOWED_ORIGINS): a cross-origin browser is allowed solely when
        // its Origin is on the list, and we reflect that exact origin back —
        // never `*`, which would let any web page drive a local instance that
        // controls real CCU hardware (the DNS-rebinding vector). With the list
        // empty (the default) no CORS headers are sent at all. The same list
        // also feeds the transport's DNS-rebinding `allowedOrigins` (below), so
        // a disallowed origin is rejected server-side too. Auth is still
        // enforced via the bearer token regardless.
        // CORS first implemented by @marcinn2 (marcinn2/debmatic-mcp@d33a0cb).
        const requestOrigin = req.headers.origin;
        const originAllowed =
          typeof requestOrigin === "string" && config.mcp.allowedOrigins.includes(requestOrigin);
        if (originAllowed) {
          // Reflect the exact origin (never `*`); Vary so shared caches don't
          // serve this response to a different origin.
          res.setHeader("Access-Control-Allow-Origin", requestOrigin);
          res.setHeader("Vary", "Origin");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
          res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
          );
          res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
          res.setHeader("Access-Control-Max-Age", "86400");
        }

        if (req.method === "OPTIONS") {
          // Preflight succeeds (204, with the CORS headers above) only for an
          // allowed origin; anything else gets 403 and no allow headers, so the
          // browser blocks the actual request.
          res.writeHead(originAllowed ? 204 : 403);
          res.end();
          return;
        }

        // Health check endpoint
        if (req.url === "/health" && req.method === "GET") {
          handleHealthRequest(req, res, { session: targets.active.session, deviceTypeCache: targets.active.deviceTypeCache });
          return;
        }

        // Auth check for MCP endpoints. Token parsing tolerates the
        // case-insensitive scheme (RFC 7235); verify() is timing-safe across all
        // currently-valid tokens (it hashes both sides and checks every entry
        // without early return) and enforces expiry live (issue #52).
        const presented = extractBearerToken(req.headers.authorization ?? "");
        const headerValid = authTokens.verify(presented);
        if (!headerValid) {
          // Structured, greppable failure line so an external tool (fail2ban et
          // al.) can ban brute-force sources at the firewall — the server
          // deliberately does NOT throttle in-process (that belongs upstream;
          // see README "Brute-force protection"). `client` is the peer IP
          // (fail2ban's <HOST>); `hadToken` lets a filter ignore credential-less
          // probes and ban only actual bad-token guesses.
          logger.warn("auth_failed", {
            client: normalizeClientIp(req.socket.remoteAddress),
            hadToken: Boolean(presented),
          });
          // Challenge header so clients can discover the scheme (RFC 6750 /
          // MCP auth spec). Add error=invalid_token only when a (bad) token was
          // actually presented; RFC 6750 §3 omits the error param when no
          // credentials were sent.
          const challenge = presented
            ? 'Bearer realm="ccu-mcp", error="invalid_token"'
            : 'Bearer realm="ccu-mcp"';
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": challenge,
          });
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
          // Defense-in-depth against DNS rebinding: reject requests whose Host
          // header isn't an expected one (a browser tricked into hitting a
          // local instance carries the attacker's host, not localhost:port).
          // allowedOrigins mirrors the CORS allowlist so a browser request with
          // a disallowed Origin is also rejected server-side; an empty list
          // disables the Origin check (the SDK only enforces it when non-empty,
          // and only when an Origin header is present — non-browser clients that
          // send no Origin are unaffected).
          enableDnsRebindingProtection: true,
          allowedHosts: config.mcp.allowedHosts,
          allowedOrigins: config.mcp.allowedOrigins,
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
    };

    // Native TLS is opt-in (issue #50): with both cert and key set we serve
    // HTTPS so the bearer token isn't exposed in transit; otherwise we keep
    // plain HTTP (the zero-config default). config validates that cert/key are
    // set together.
    const useTls = Boolean(config.mcp.tlsCertPath && config.mcp.tlsKeyPath);
    if (useTls) {
      const [cert, key] = await Promise.all([
        readFile(config.mcp.tlsCertPath!),
        readFile(config.mcp.tlsKeyPath!),
      ]);
      httpServer = createHttpsServer({ cert, key }, handleRequest);
    } else {
      httpServer = createHttpServer(handleRequest);
      // Plain HTTP is allowed (some run behind a TLS-terminating proxy, or on a
      // trusted LAN), but the bearer token then travels in the clear. Warn once
      // at startup unless the listener is loopback-only or the operator has
      // acknowledged it via MCP_ALLOW_PLAINTEXT.
      const host = config.mcp.host;
      const loopbackOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
      if (!loopbackOnly && !config.mcp.allowPlaintext) {
        logger.warn("plaintext_http", {
          hint:
            "MCP is serving the bearer token over unencrypted HTTP on a non-loopback " +
            "address. Set MCP_TLS_CERT/MCP_TLS_KEY for native TLS, put a TLS-terminating " +
            "reverse proxy in front, bind loopback with MCP_HOST=127.0.0.1, or set " +
            "MCP_ALLOW_PLAINTEXT=true to silence this warning.",
        });
      }
    }

    poller = new ResourcePoller(
      async () => {
        await Promise.allSettled(
          [...sessions.values()].map((s) => s.server.server.sendResourceListChanged()),
        );
      },
      targets.active.session, rateLimiter, logger, config.resourcePollInterval,
    );
    poller.start();
    closeTransports = async () => {
      await Promise.allSettled([...sessions.values()].map((s) => s.server.close()));
      sessions.clear();
    };

    httpServer.listen(config.mcp.port, config.mcp.host, () => {
      logger.info("server_ready", {
        transport: useTls ? "https" : "http",
        port: config.mcp.port,
        host: config.mcp.host ?? "0.0.0.0",
        tls: useTls,
        authTokens: authTokens.liveCount(),
      });
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
      await targets.saveCaches();
      await targets.logoutAll();
      targets.destroyAll();
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
