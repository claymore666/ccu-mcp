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
import { loadConfig, targetsAwaitingPassword, envPrefix } from "./config.js";
import { createLogger } from "./logger.js";
import { RateLimiter } from "./middleware/rate-limiter.js";
import { TargetRegistry, TargetSelection } from "./ccu/target-registry.js";
import { ResourcePoller } from "./resources/poller.js";
import { resolveAuthTokens, startAutoRotation } from "./auth/token.js";
import { handleHealthRequest } from "./health/handler.js";
import { endWithInternalError } from "./http/error-response.js";
import { createMcpServer, serverSubscriptions, type ServerDeps } from "./server.js";
import { extractBearerToken, normalizeClientIp, VERSION, loadBuildInfo } from "./utils.js";

const USAGE = `ccu-mcp — MCP server for a HomeMatic CCU (debmatic, CCU3, OpenCCU/RaspberryMatic)

Usage:
  ccu-mcp [--stdio | --http] [--env <path>]
  ccu-mcp init   [--env <path>]
  ccu-mcp doctor [--env <path>]
  ccu-mcp secret [<profile>] [--env <path>]
  ccu-mcp --version
  ccu-mcp --help

Subcommands:
  init             Interactive setup: probe the CCU, pin its TLS certificate,
                   test the login, and write an env file (default: ./.env)
  doctor           Validate an existing env file end-to-end: reachability,
                   certificate pin, login, privilege level
  secret           Store the CCU password into the env file via a local hidden
                   prompt (used by the LLM-guided setup; also for rotation)

Options:
  --stdio          Serve MCP over stdin/stdout (overrides MCP_TRANSPORT).
                   With --env and a missing/incomplete configuration the server
                   starts in SETUP MODE, exposing only setup_* tools that let
                   an LLM configure it conversationally
  --http           Serve MCP over HTTP (default)
  --env <path>     Load configuration from this dotenv file (already-set
                   environment variables win, like node's own --env-file)
  -v, --version    Print the version and exit
  -h, --help       Print this help and exit

Required environment:
  CCU_HOST         Hostname or IP of the CCU
  CCU_PASSWORD     Password for CCU_USER

Common environment:
  CCU_USER         CCU username (default: Admin)
  CCU_PORT         API port (default: 80, or 443 with CCU_HTTPS=true)
  CCU_HTTPS        Connect over HTTPS (default: false)
  MCP_TRANSPORT    "http" or "stdio" (default: http)
  MCP_PORT         HTTP listener port (default: 3000)
  CACHE_DIR        Cache, session and generated token (default: /data)
  LOG_LEVEL        error | warn | info | debug (default: info)

Multiple CCUs, TLS pinning, auth-token rotation and the full variable list:
https://github.com/claymore666/ccu-mcp#configuration`;

/**
 * Handle the flags that must work with NO environment at all (issue #112).
 *
 * Deliberately runs before createLogger()/loadConfig(): asking an installed
 * copy "which version are you?" must not require a reachable CCU, and
 * loadConfig() throws on a missing CCU_HOST. Returns true when the process
 * should exit without starting a server.
 */
function handleInfoFlags(argv: string[]): boolean {
  if (argv.includes("--version") || argv.includes("-v")) {
    const { describe, commit, dirty } = loadBuildInfo();
    // Prefer the git describe stamped at build time; fall back to the bare
    // version for an npm install, which carries no build-info.json.
    const stamp = describe ?? commit;
    // `git describe --dirty` already carries the marker; the commit fallback
    // does not. Appending unconditionally would print "...-dirty-dirty".
    const dirtyMark = stamp && dirty && !stamp.endsWith("-dirty") ? "-dirty" : "";
    process.stdout.write(`${VERSION}${stamp ? ` (${stamp}${dirtyMark})` : ""}\n`);
    return true;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    // stdout, not stderr, so `ccu-mcp --help | less` works.
    process.stdout.write(`${USAGE}\n`);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Subcommands run in the same no-environment-needed early path as the info
  // flags (issue #112): `ccu-mcp init` exists precisely because there is no
  // valid configuration yet. Dynamic import keeps server startup unaffected.
  if (argv[0] === "init" || argv[0] === "doctor" || argv[0] === "secret") {
    const mod =
      argv[0] === "init"
        ? await import("./cli/init.js")
        : argv[0] === "doctor"
          ? await import("./cli/doctor.js")
          : await import("./cli/secret.js");
    process.exitCode = await mod.run(argv.slice(1));
    return;
  }

  // A bare first word is always a subcommand attempt — server mode is entered
  // with flags (--stdio/--http/--env). Falling through to startup instead made
  // an OLDER binary answer `ccu-mcp secret …` with "CCU_HOST environment
  // variable is required": a complaint about configuration, for what is really
  // "this build predates that command". Name the version, so the next person
  // who runs a printed command against the wrong install can see which one it
  // reached.
  if (argv[0] !== undefined && !argv[0].startsWith("-")) {
    process.stderr.write(
      `ccu-mcp: unknown command "${argv[0]}" (ccu-mcp ${VERSION}).\n` +
        `Known commands: init, doctor, secret. Run \`ccu-mcp --help\` for usage.\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (handleInfoFlags(argv)) return;

  // `--env` for server mode: lets an MCP client entry reference the file
  // `ccu-mcp init` wrote instead of inlining credentials in its JSON config.
  // Same precedence as node's own flag: already-set environment wins.
  let envPath: string | undefined;
  if (argv.includes("--env")) {
    const { envFileArg, loadEnvFile, applyEnvVars } = await import("./cli/common.js");
    envPath = envFileArg(argv); // throws on a missing value — always fatal
    try {
      applyEnvVars(loadEnvFile(envPath));
    } catch (err) {
      // A missing/unreadable env file is exactly the state the LLM-guided
      // setup starts from (issue #196) — over stdio it leads into setup mode
      // below. Everywhere else it stays fatal, as before.
      if (!argv.includes("--stdio")) throw err;
    }
  }

  const logger = createLogger();
  // Setup mode is only reachable from a stdio start that named an env file;
  // computing it here keeps the extra completeness check below from turning a
  // tolerated configuration into a fatal error on any other start path.
  const setupEligible = envPath !== undefined && argv.includes("--stdio");
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
    // A loadable configuration is not necessarily a finished one. A named
    // target whose password key was never written (QA F-008) loads with an
    // empty password, so the server would leave setup mode mid-flow and then
    // fail every call with AUTH 501 — with the setup_* tools gone, the model
    // has no way to finish or explain it. Treat it as not-yet-configured, and
    // say exactly which command completes it.
    if (setupEligible) {
      const pending = targetsAwaitingPassword(config);
      if (pending.length > 0) {
        const { selfCommand } = await import("./cli/common.js");
        const runs = pending.map((n) => selfCommand("secret", n, "--env", envPath!)).join("  |  ");
        throw new Error(
          `no password stored yet for target${pending.length > 1 ? "s" : ""} ` +
          `${pending.join(", ")} — run: ${runs}  ` +
          `(a CCU that genuinely has no password needs the key present but empty: ` +
          `CCU_${envPrefix(pending[0]!)}_PASSWORD=)`,
        );
      }
    }
  } catch (err) {
    // Setup mode (issue #196): started for stdio with an explicit --env file
    // but no loadable configuration, serve only the setup_* tools so an LLM
    // can walk the user through writing that file. Strictly stdio — an
    // unconfigured, unauthenticated HTTP endpoint that writes config files is
    // not an acceptable surface. A bare start still fails loudly.
    if (envPath === undefined || !argv.includes("--stdio")) throw err;
    const { resolve } = await import("node:path");
    const { createSetupServer } = await import("./setup-server.js");
    const setupServer = createSetupServer(resolve(envPath), (err as Error).message, logger);
    await setupServer.connect(new StdioServerTransport());
    logger.info("server_ready", { transport: "stdio", mode: "setup" });
    let closing = false;
    const closeSetup = (): void => {
      if (closing) return;
      closing = true;
      void setupServer.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", closeSetup);
    process.on("SIGINT", closeSetup);
    // Same stdin-EOF hook as the configured stdio server below: the client
    // terminates by closing the pipe, not by signaling.
    process.stdin.on("end", closeSetup);
    process.stdin.on("close", closeSetup);
    return;
  }

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
    await targets.loginDefault();
  } catch (err) {
    logger.warn("startup_degraded", {
      error: (err as Error).message,
      hint: "CCU unreachable at startup; will retry on first request",
    });
  }

  // Load each target's device-type cache; warm only the default one in background.
  await targets.loadCaches();
  targets.warmDefault(rateLimiter).catch((err) => {
    logger.error("cache_warm_background_error", { error: (err as Error).message });
  });

  // Per-MCP-session tool dependencies: each McpServer gets its OWN
  // TargetSelection (active-target pointer + protected-target unlocks), so in
  // HTTP mode one client's use_ccu/confirm can't affect another client.
  // session/resolver/deviceTypeCache are getters that resolve to the
  // selection's active target on each access, so a use_ccu() switch is picked
  // up by the next tool call without touching tools that read deps.session etc.
  const makeDeps = (): ServerDeps => {
    const selection = new TargetSelection(targets);
    return {
      config,
      targets,
      selection,
      get session() { return selection.active.session; },
      get resolver() { return selection.active.resolver; },
      get deviceTypeCache() { return selection.active.deviceTypeCache; },
      rateLimiter,
      logger,
    };
  };

  let poller: ResourcePoller;
  let closeTransports: () => Promise<void>;
  let httpServer: HttpServer | HttpsServer | null = null;
  let stdioServer: McpServer | null = null;

  if (config.mcp.transport === "stdio") {
    // stdio has exactly one MCP session; the poller follows ITS selection so a
    // use_ccu switch moves change-detection along with the resource reads.
    const stdioDeps = makeDeps();
    const mcpServer = createMcpServer(stdioDeps);
    stdioServer = mcpServer;
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    poller = new ResourcePoller(
      async (changedUris) => {
        const subs = serverSubscriptions.get(mcpServer);
        for (const uri of changedUris) {
          if (subs?.has(uri)) await mcpServer.server.sendResourceUpdated({ uri });
        }
      },
      () => stdioDeps.selection.active.session, rateLimiter, logger, config.resourcePollInterval,
    );
    poller.start();
    closeTransports = () => mcpServer.close();
    logger.info("server_ready", { transport: "stdio" });
  } else {
    // HTTP mode with auth.
    // A stateless StreamableHTTPServerTransport only survives a single request,
    // so each MCP session gets its own transport + server (deps are shared),
    // routed by the Mcp-Session-Id header per the SDK's session pattern.
    const authTokenOpts = {
      envToken: config.mcp.authToken,
      envPreviousToken: config.mcp.authTokenPrevious,
      dataDir: config.cache.dir,
      ttlMs: config.mcp.authTokenTtlMs,
      graceMs: config.mcp.authTokenGraceMs,
    };
    const authTokens = await resolveAuthTokens(authTokenOpts, logger);
    // With a TTL on the auto-generated token, rotation must also happen while
    // the server RUNS — verify() enforces expiry live, and a long-running
    // process would otherwise lock every client out until a manual restart.
    const stopTokenRotation =
      !config.mcp.authToken && config.mcp.authTokenTtlMs !== undefined
        ? startAutoRotation(authTokens, authTokenOpts, logger)
        : null;
    // Bound the session map. Each MCP session pins a McpServer + transport that
    // is removed only on transport.onclose (explicit DELETE / clean teardown).
    // A client that initializes then drops its connection — or reconnects in a
    // loop — would otherwise leak one pair per session forever. Cap the count
    // and reclaim sessions idle past the timeout. Auth runs before session
    // creation, so only valid-token holders reach here, but a single misbehaving
    // authenticated client must still not grow this without bound.
    const MAX_SESSIONS = 256;
    const SESSION_IDLE_MS = 30 * 60_000; // 30 min without a request → reclaim
    const MAX_BODY_BYTES = 4 * 1024 * 1024; // JSON-RPC messages are tiny; 4 MB is generous
    const sessions = new Map<
      string,
      { server: McpServer; transport: StreamableHTTPServerTransport; lastSeen: number; openStreams: number }
    >();

    // Reclaim sessions whose last request predates `cutoff`. Returns how many
    // were evicted. Shared by the periodic sweep and the at-capacity fast path.
    // A session with an open SSE stream is NOT idle even without new POSTs —
    // it is passively receiving notifications — so it is never reclaimed while
    // the stream is up (openStreams drops to 0 when the connection closes).
    const evictIdleSessions = (cutoff: number): number => {
      let evicted = 0;
      for (const [sid, s] of sessions) {
        if (s.lastSeen < cutoff && s.openStreams === 0) {
          sessions.delete(sid);
          s.server.close().catch(() => {});
          evicted++;
        }
      }
      if (evicted > 0) logger.info("mcp_sessions_idle_evicted", { evicted, sessions: sessions.size });
      return evicted;
    };

    // Periodic idle sweep. unref'd so it never holds the process open; cleared
    // on shutdown via closeTransports.
    const idleSweep = setInterval(() => evictIdleSessions(Date.now() - SESSION_IDLE_MS), 60_000);
    idleSweep.unref();

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

        // Verify the bearer token BEFORE any path routing, so the request path
        // — attacker-controlled — never decides whether credentials are checked
        // at all; it only decides what an already-known-good/bad verdict means.
        // (CodeQL js/user-controlled-bypass flagged the previous shape, where
        // the /health branch ran its own verify() inside a path-guarded block.)
        // Token parsing tolerates the case-insensitive scheme (RFC 7235);
        // verify() is timing-safe across all currently-valid tokens (it hashes
        // both sides and checks every entry without early return) and enforces
        // expiry live (issue #52). One call now serves both consumers below.
        const presented = extractBearerToken(req.headers.authorization ?? "");
        const headerValid = authTokens.verify(presented);

        // Path routing: MCP is served on the root path only (README points
        // clients at the bare URL; "/mcp" accepted as a common convention).
        // Without this, the full protocol answered on ANY path, and a typo'd
        // path surfaced as a misleading Accept/initialization error instead
        // of 404.
        const path = (req.url ?? "/").split("?")[0];

        // Health check endpoint (tolerate cache-busting query strings that
        // uptime monitors append). Deliberately reachable without a token —
        // uptime monitors need it — but a valid token unlocks the detailed
        // body, which is why the verdict above is passed through rather than
        // recomputed here.
        if (path === "/health" && req.method === "GET") {
          handleHealthRequest(req, res, { session: targets.default.session, deviceTypeCache: targets.default.deviceTypeCache }, headerValid);
          return;
        }

        // Auth gate for the MCP endpoints (health has already returned above).
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

        // Unknown paths are 404 — not the MCP endpoint.
        if (path !== "/" && path !== "/mcp") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        // Body size cap: the SDK transport buffers the whole JSON body with no
        // limit of its own, so an authenticated client could otherwise balloon
        // the heap with one multi-GB POST. Content-Length covers every normal
        // client; a chunked-encoding bypass requires a hostile valid-token
        // holder, which is outside the threat model.
        const contentLength = Number(req.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          return;
        }

        // Existing session: route to its transport (POST, GET/SSE, DELETE) and
        // mark it active so the idle sweep doesn't reclaim a session in use.
        const sessionId = req.headers["mcp-session-id"];
        const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (existing) {
          existing.lastSeen = Date.now();
          if (req.method === "GET") {
            // GET opens the long-lived SSE notification stream; hold the
            // session out of idle eviction until the connection closes.
            // TCP keep-alive makes the OS probe the peer so a half-open
            // stream (client died without FIN/RST) still fires 'close' and
            // releases the slot — otherwise a wedged stream would pin the
            // session forever and eventually 503 the server at capacity.
            req.socket.setKeepAlive(true, 60_000);
            existing.openStreams++;
            res.on("close", () => {
              existing.openStreams--;
              existing.lastSeen = Date.now();
            });
          }
          await existing.transport.handleRequest(req, res);
          return;
        }

        // A request that CARRIES a session id we don't know (idle-evicted or
        // pre-restart) must get 404 "Session not found" — the MCP spec's cue
        // for the client to re-initialize. Routing it into a fresh transport
        // would answer 400 "Server not initialized", which clients treat as a
        // hard error and never recover from (and would waste a McpServer
        // construction per request).
        if (typeof sessionId === "string") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }));
          return;
        }

        // No (known) session: a fresh transport + server pair is about to be
        // created. Enforce the cap first — try reclaiming idle sessions, and if
        // still full, refuse with 503 so a flood of initialize requests can't
        // grow the map without bound.
        if (sessions.size >= MAX_SESSIONS) {
          evictIdleSessions(Date.now() - SESSION_IDLE_MS);
          if (sessions.size >= MAX_SESSIONS) {
            logger.warn("mcp_sessions_at_capacity", { sessions: sessions.size, max: MAX_SESSIONS });
            res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "60" });
            res.end(JSON.stringify({ error: "Server at session capacity, retry later" }));
            return;
          }
        }

        // Create a fresh transport + server pair. The transport itself rejects
        // non-initialize requests without a session.
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
            sessions.set(sid, { server: sessionServer, transport, lastSeen: Date.now(), openStreams: 0 });
            logger.info("mcp_session_started", { sessions: sessions.size });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId && sessions.delete(transport.sessionId)) {
            logger.info("mcp_session_closed", { sessions: sessions.size });
          }
        };
        const sessionServer = createMcpServer(makeDeps());
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        // One bad request must not take down the process (unhandled rejection)
        logger.error("http_handler_error", { error: (err as Error).message });
        endWithInternalError(res);
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
      async (changedUris) => {
        await Promise.allSettled(
          [...sessions.values()].flatMap((s) => {
            const subs = serverSubscriptions.get(s.server);
            return changedUris
              .filter((uri) => subs?.has(uri))
              .map((uri) => s.server.server.sendResourceUpdated({ uri }));
          }),
        );
      },
      () => targets.default.session, rateLimiter, logger, config.resourcePollInterval,
    );
    poller.start();
    closeTransports = async () => {
      clearInterval(idleSweep);
      stopTokenRotation?.();
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

  // stdio: the client usually terminates by closing the pipe (stdin EOF),
  // not by signaling. Hook stdin DIRECTLY — StdioServerTransport registers
  // only 'data'/'error' listeners, so transport/server onclose never fires
  // on EOF and the process would exit via event-loop drain with no
  // Session.logout (leaking a CCU session toward "too many sessions") and
  // no cache save. shutdown() is re-entrancy-guarded.
  if (stdioServer) {
    process.stdin.on("end", () => {
      void shutdown("stdin-eof");
    });
    process.stdin.on("close", () => {
      void shutdown("stdin-closed");
    });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
