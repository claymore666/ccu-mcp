import type { CcuConfig } from "./ccu/types.js";

export interface AppConfig {
  ccu: CcuConfig;
  mcp: {
    transport: "http" | "stdio";
    port: number;
    authToken?: string;
    /**
     * Value echoed in `Access-Control-Allow-Origin`. Unset ⇒ no CORS header is
     * sent (browsers are blocked by default). Set `MCP_CORS_ALLOW_ORIGIN=*` for
     * local dev / MCP Inspector, or a single trusted origin.
     */
    corsAllowOrigin?: string;
    /**
     * Host-header allowlist for the StreamableHTTP transport's DNS-rebinding
     * protection. Defaults to localhost/127.0.0.1 on the MCP port; extend via
     * `MCP_ALLOWED_HOSTS` when the server is reached under another hostname.
     */
    allowedHosts: string[];
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

  return {
    ccu: {
      host,
      port: parseIntEnv("CCU_PORT", process.env.CCU_HTTPS === "true" ? "443" : "80"),
      https: process.env.CCU_HTTPS === "true",
      tlsVerify: process.env.CCU_TLS_VERIFY === "true",
      user: process.env.CCU_USER || "Admin",
      password,
      timeout: parseIntEnv("CCU_TIMEOUT", "10000"),
      scriptTimeout: parseIntEnv("CCU_SCRIPT_TIMEOUT", "30000"),
    },
    mcp: {
      transport,
      port: mcpPort,
      authToken: process.env.MCP_AUTH_TOKEN,
      corsAllowOrigin: process.env.MCP_CORS_ALLOW_ORIGIN || undefined,
      allowedHosts,
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
