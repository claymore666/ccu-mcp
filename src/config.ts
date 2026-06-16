import { readFileSync } from "node:fs";
import type { CcuConfig } from "./ccu/types.js";

export interface AppConfig {
  ccu: CcuConfig;
  mcp: {
    transport: "http" | "stdio";
    port: number;
    authToken?: string;
    /**
     * Default-deny origin allowlist for browser-based MCP clients. Empty ⇒ no
     * cross-origin browser access (the secure default). A request whose `Origin`
     * is on this list gets that exact origin reflected in
     * `Access-Control-Allow-Origin` (never `*`); the same list drives the
     * transport's DNS-rebinding `allowedOrigins` so CORS and rebinding
     * protection can't drift apart. Set via `MCP_ALLOWED_ORIGINS`
     * (comma-separated, e.g. `https://app.example,http://localhost:6274`).
     */
    allowedOrigins: string[];
    /**
     * Host-header allowlist for the StreamableHTTP transport's DNS-rebinding
     * protection. Defaults to localhost/127.0.0.1 on the MCP port; extend via
     * `MCP_ALLOWED_HOSTS` when the server is reached under another hostname.
     */
    allowedHosts: string[];
    /**
     * Optional bind address for the HTTP listener (`MCP_HOST`). Unset ⇒ bind
     * all interfaces (the unchanged default). Set to `127.0.0.1`/`::1` to
     * restrict the server to loopback (e.g. when a reverse proxy terminates TLS
     * in front), which also suppresses the plaintext warning.
     */
    host?: string;
    /**
     * Optional TLS cert/key paths (`MCP_TLS_CERT` / `MCP_TLS_KEY`). When BOTH
     * are set the server listens over HTTPS natively; otherwise it serves plain
     * HTTP (the zero-config default). Setting only one is a configuration error.
     */
    tlsCertPath?: string;
    tlsKeyPath?: string;
    /**
     * Acknowledge that serving over plain HTTP is intended
     * (`MCP_ALLOW_PLAINTEXT=true`). Silences the non-loopback plaintext warning
     * for operators who deliberately run without TLS (e.g. a trusted LAN).
     */
    allowPlaintext: boolean;
  };
  cache: {
    dir: string;
    ttl: number;
  };
  rateLimiter: {
    burst: number;
    rate: number;
  };
  resourcePollInterval: number;
}

export function loadConfig(): AppConfig {
  const host = process.env.CCU_HOST;
  if (!host) {
    throw new Error("CCU_HOST environment variable is required");
  }

  const password = process.env.CCU_PASSWORD;
  if (!password) {
    throw new Error("CCU_PASSWORD environment variable is required");
  }

  // CLI flags override env vars for transport
  const args = process.argv.slice(2);
  let transport: "http" | "stdio" = (process.env.MCP_TRANSPORT as "http" | "stdio") || "http";
  if (args.includes("--stdio")) transport = "stdio";
  if (args.includes("--http")) transport = "http";

  const parseIntEnv = (name: string, fallback: string): number => {
    const val = parseInt(process.env[name] || fallback, 10);
    if (isNaN(val) || val <= 0) {
      throw new Error(`${name} must be a positive number, got: "${process.env[name]}"`);
    }
    return val;
  };

  const mcpPort = parseIntEnv("MCP_PORT", "3000");
  // DNS-rebinding defense: the transport rejects any Host header not on this
  // list. localhost/127.0.0.1 on the bound port covers local use; deployments
  // reached under another hostname (reverse proxy, container DNS name) add it
  // via MCP_ALLOWED_HOSTS (comma-separated, "host:port").
  const allowedHosts = [
    `127.0.0.1:${mcpPort}`,
    `localhost:${mcpPort}`,
    ...(process.env.MCP_ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  ];

  // Default-deny browser origin allowlist. Empty unless MCP_ALLOWED_ORIGINS is
  // set; it feeds both the reflective CORS headers and the transport's
  // DNS-rebinding Origin check (single source of truth).
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // Native TLS for the HTTP transport is opt-in: set BOTH cert and key. Plain
  // HTTP stays the zero-config default (issue #50). Setting only one is almost
  // certainly a mistake, so fail loudly rather than silently serving plaintext.
  const tlsCertPath = process.env.MCP_TLS_CERT?.trim() || undefined;
  const tlsKeyPath = process.env.MCP_TLS_KEY?.trim() || undefined;
  if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
    throw new Error("MCP_TLS_CERT and MCP_TLS_KEY must both be set (or both unset)");
  }

  // CCU TLS verification (issue #51). A CCU ships a self-signed cert, so verify
  // it either by pinning the leaf fingerprint (CCU_TLS_FINGERPRINT) or by
  // trusting a CA/self-signed PEM (CCU_CA_CERT). Fingerprint takes precedence.
  const tlsFingerprint = process.env.CCU_TLS_FINGERPRINT?.trim() || undefined;
  const caCertPath = process.env.CCU_CA_CERT?.trim() || undefined;
  let caCert: string | undefined;
  if (caCertPath) {
    try {
      caCert = readFileSync(caCertPath, "utf-8");
    } catch (err) {
      throw new Error(`CCU_CA_CERT could not be read at "${caCertPath}": ${(err as Error).message}`);
    }
  }

  return {
    ccu: {
      host,
      port: parseIntEnv("CCU_PORT", process.env.CCU_HTTPS === "true" ? "443" : "80"),
      https: process.env.CCU_HTTPS === "true",
      tlsVerify: process.env.CCU_TLS_VERIFY === "true",
      tlsFingerprint,
      caCert,
      user: process.env.CCU_USER || "Admin",
      password,
      timeout: parseIntEnv("CCU_TIMEOUT", "10000"),
      scriptTimeout: parseIntEnv("CCU_SCRIPT_TIMEOUT", "30000"),
    },
    mcp: {
      transport,
      port: mcpPort,
      authToken: process.env.MCP_AUTH_TOKEN,
      allowedOrigins,
      allowedHosts,
      host: process.env.MCP_HOST?.trim() || undefined,
      tlsCertPath,
      tlsKeyPath,
      allowPlaintext: process.env.MCP_ALLOW_PLAINTEXT === "true",
    },
    cache: {
      dir: process.env.CACHE_DIR || "/data",
      ttl: parseIntEnv("CACHE_TTL", "86400"),
    },
    rateLimiter: {
      burst: parseIntEnv("CCU_RATE_LIMIT_BURST", "20"),
      rate: parseIntEnv("CCU_RATE_LIMIT_RATE", "10"),
    },
    resourcePollInterval: parseIntEnv("RESOURCE_POLL_INTERVAL", "60"),
  };
}
