import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    // Reset to clean state
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    delete process.env.CCU_HOST;
    delete process.env.CCU_PASSWORD;
    delete process.env.CCU_PORT;
    delete process.env.CCU_HTTPS;
    delete process.env.CCU_USER;
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_PORT;
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.MCP_AUTH_TOKEN_PREVIOUS;
    delete process.env.MCP_AUTH_TOKEN_TTL_DAYS;
    delete process.env.MCP_AUTH_TOKEN_GRACE_HOURS;
    delete process.env.MCP_ALLOWED_ORIGINS;
    delete process.env.MCP_ALLOWED_HOSTS;
    delete process.env.CACHE_DIR;
    delete process.env.CACHE_TTL;
    delete process.env.CCU_RATE_LIMIT_BURST;
    delete process.env.CCU_RATE_LIMIT_RATE;
    delete process.env.RESOURCE_POLL_INTERVAL;
    delete process.env.CCU_TIMEOUT;
    delete process.env.CCU_SCRIPT_TIMEOUT;
    delete process.env.CCU_TLS_VERIFY;
    delete process.env.CCU_TLS_FINGERPRINT;
    delete process.env.CCU_CA_CERT;
    delete process.env.MCP_HOST;
    delete process.env.MCP_TLS_CERT;
    delete process.env.MCP_TLS_KEY;
    delete process.env.MCP_ALLOW_PLAINTEXT;
    delete process.env.LOG_LEVEL;
    delete process.env.CCU_PROFILES;
    delete process.env.CCU_DEFAULT_PROFILE;
    for (const k of Object.keys(process.env)) {
      if (/^CCU_(PROD|DEV|STAGING)_/.test(k)) delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  it("throws if CCU_HOST is missing", () => {
    process.env.CCU_PASSWORD = "test";
    expect(() => loadConfig()).toThrow("CCU_HOST");
  });

  it("throws if CCU_PASSWORD is missing", () => {
    process.env.CCU_HOST = "debmatic";
    expect(() => loadConfig()).toThrow("CCU_PASSWORD");
  });

  it("returns correct defaults", () => {
    process.env.CCU_HOST = "debmatic";
    process.env.CCU_PASSWORD = "secret";
    const config = loadConfig();

    expect(config.ccu.host).toBe("debmatic");
    expect(config.ccu.port).toBe(80);
    expect(config.ccu.https).toBe(false);
    expect(config.ccu.user).toBe("Admin");
    expect(config.ccu.password).toBe("secret");
    expect(config.ccu.timeout).toBe(10000);
    expect(config.ccu.scriptTimeout).toBe(30000);
    expect(config.mcp.transport).toBe("http");
    expect(config.mcp.port).toBe(3000);
    expect(config.cache.dir).toBe("/data");
    expect(config.cache.ttl).toBe(86400);
    expect(config.rateLimiter.burst).toBe(20);
    expect(config.rateLimiter.rate).toBe(10);
    expect(config.resourcePollInterval).toBe(60);
  });

  it("uses port 443 when CCU_HTTPS is true", () => {
    process.env.CCU_HOST = "debmatic";
    process.env.CCU_PASSWORD = "secret";
    process.env.CCU_HTTPS = "true";
    const config = loadConfig();

    expect(config.ccu.port).toBe(443);
    expect(config.ccu.https).toBe(true);
  });

  it("explicit CCU_PORT overrides HTTPS default", () => {
    process.env.CCU_HOST = "debmatic";
    process.env.CCU_PASSWORD = "secret";
    process.env.CCU_HTTPS = "true";
    process.env.CCU_PORT = "8443";
    const config = loadConfig();

    expect(config.ccu.port).toBe(8443);
  });

  it("--stdio CLI flag overrides MCP_TRANSPORT env", () => {
    process.env.CCU_HOST = "debmatic";
    process.env.CCU_PASSWORD = "secret";
    process.env.MCP_TRANSPORT = "http";
    process.argv = ["node", "index.js", "--stdio"];
    const config = loadConfig();

    expect(config.mcp.transport).toBe("stdio");
  });

  it("--http CLI flag overrides MCP_TRANSPORT env", () => {
    process.env.CCU_HOST = "debmatic";
    process.env.CCU_PASSWORD = "secret";
    process.env.MCP_TRANSPORT = "stdio";
    process.argv = ["node", "index.js", "--http"];
    const config = loadConfig();

    expect(config.mcp.transport).toBe("http");
  });

  it("reads all custom env vars", () => {
    process.env.CCU_HOST = "192.168.1.100";
    process.env.CCU_PASSWORD = "pw";
    process.env.CCU_PORT = "8181";
    process.env.CCU_USER = "testuser";
    process.env.MCP_PORT = "4000";
    process.env.MCP_AUTH_TOKEN = "mytoken";
    process.env.CACHE_DIR = "/tmp/cache";
    process.env.CACHE_TTL = "3600";
    process.env.CCU_RATE_LIMIT_BURST = "50";
    process.env.CCU_RATE_LIMIT_RATE = "25";
    process.env.RESOURCE_POLL_INTERVAL = "120";
    process.env.CCU_TIMEOUT = "5000";
    process.env.CCU_SCRIPT_TIMEOUT = "60000";
    const config = loadConfig();

    expect(config.ccu.host).toBe("192.168.1.100");
    expect(config.ccu.port).toBe(8181);
    expect(config.ccu.user).toBe("testuser");
    expect(config.mcp.port).toBe(4000);
    expect(config.mcp.authToken).toBe("mytoken");
    expect(config.cache.dir).toBe("/tmp/cache");
    expect(config.cache.ttl).toBe(3600);
    expect(config.rateLimiter.burst).toBe(50);
    expect(config.rateLimiter.rate).toBe(25);
    expect(config.resourcePollInterval).toBe(120);
    expect(config.ccu.timeout).toBe(5000);
    expect(config.ccu.scriptTimeout).toBe(60000);
  });

  // Regression: zero/negative values were accepted (issue #14)
  it("rejects zero and negative numeric env vars", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";

    process.env.CCU_TIMEOUT = "0";
    expect(() => loadConfig()).toThrow(/CCU_TIMEOUT must be a positive number/);

    process.env.CCU_TIMEOUT = "-5000";
    expect(() => loadConfig()).toThrow(/CCU_TIMEOUT must be a positive number/);
    delete process.env.CCU_TIMEOUT;

    process.env.RESOURCE_POLL_INTERVAL = "-60";
    expect(() => loadConfig()).toThrow(/RESOURCE_POLL_INTERVAL must be a positive number/);
  });

  // Issue #28 / #37: HTTP transport hardening
  it("origin allowlist is default-deny: allowedOrigins is empty unless configured", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    expect(loadConfig().mcp.allowedOrigins).toEqual([]);
  });

  it("MCP_ALLOWED_ORIGINS parses a comma-separated allowlist (trimmed, no blanks)", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.MCP_ALLOWED_ORIGINS = "https://app.example, , http://localhost:6274 ";
    expect(loadConfig().mcp.allowedOrigins).toEqual([
      "https://app.example",
      "http://localhost:6274",
    ]);
  });

  it("allowedHosts defaults to localhost/127.0.0.1 on the MCP port", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.MCP_PORT = "4567";
    expect(loadConfig().mcp.allowedHosts).toEqual(["127.0.0.1:4567", "localhost:4567"]);
  });

  it("MCP_ALLOWED_HOSTS extends the default host allowlist (trimmed, no blanks)", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.MCP_PORT = "3000";
    process.env.MCP_ALLOWED_HOSTS = "mcp.lan:3000, , proxy.example ";
    expect(loadConfig().mcp.allowedHosts).toEqual([
      "127.0.0.1:3000",
      "localhost:3000",
      "mcp.lan:3000",
      "proxy.example",
    ]);
  });

  it("parses CCU_TLS_VERIFY (default off)", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    expect(loadConfig().ccu.tlsVerify).toBe(false);

    process.env.CCU_TLS_VERIFY = "true";
    expect(loadConfig().ccu.tlsVerify).toBe(true);
  });

  // Issue #51: CCU TLS verification via fingerprint pin or CA cert
  it("CCU TLS pinning is off by default", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    const config = loadConfig();
    expect(config.ccu.tlsFingerprint).toBeUndefined();
    expect(config.ccu.caCert).toBeUndefined();
  });

  it("parses CCU_TLS_FINGERPRINT", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.CCU_TLS_FINGERPRINT = "AB:CD:EF:01";
    expect(loadConfig().ccu.tlsFingerprint).toBe("AB:CD:EF:01");
  });

  it("reads CCU_CA_CERT file contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccu-ca-"));
    const caPath = join(dir, "ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    try {
      process.env.CCU_HOST = "test";
      process.env.CCU_PASSWORD = "pw";
      process.env.CCU_CA_CERT = caPath;
      expect(loadConfig().ccu.caCert).toContain("BEGIN CERTIFICATE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws if CCU_CA_CERT points at a missing file", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.CCU_CA_CERT = "/no/such/ca.pem";
    expect(() => loadConfig()).toThrow(/CCU_CA_CERT could not be read/);
  });

  // Issue #50: native TLS for the HTTP transport (opt-in), bind host, plaintext ack
  it("TLS is off by default: no cert/key paths, plain HTTP", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    const config = loadConfig();
    expect(config.mcp.tlsCertPath).toBeUndefined();
    expect(config.mcp.tlsKeyPath).toBeUndefined();
    expect(config.mcp.host).toBeUndefined();
    expect(config.mcp.allowPlaintext).toBe(false);
  });

  it("reads MCP_TLS_CERT/MCP_TLS_KEY when both are set", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.MCP_TLS_CERT = "/data/cert.pem";
    process.env.MCP_TLS_KEY = "/data/key.pem";
    const config = loadConfig();
    expect(config.mcp.tlsCertPath).toBe("/data/cert.pem");
    expect(config.mcp.tlsKeyPath).toBe("/data/key.pem");
  });

  it("throws if only one of MCP_TLS_CERT / MCP_TLS_KEY is set", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";

    process.env.MCP_TLS_CERT = "/data/cert.pem";
    expect(() => loadConfig()).toThrow(/MCP_TLS_CERT and MCP_TLS_KEY must both be set/);

    delete process.env.MCP_TLS_CERT;
    process.env.MCP_TLS_KEY = "/data/key.pem";
    expect(() => loadConfig()).toThrow(/MCP_TLS_CERT and MCP_TLS_KEY must both be set/);
  });

  it("reads MCP_HOST and MCP_ALLOW_PLAINTEXT", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.MCP_HOST = "127.0.0.1";
    process.env.MCP_ALLOW_PLAINTEXT = "true";
    const config = loadConfig();
    expect(config.mcp.host).toBe("127.0.0.1");
    expect(config.mcp.allowPlaintext).toBe(true);
  });

  // Issue #52: token rotation + expiry
  it("token TTL/previous default to none; grace defaults to 24h", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    const config = loadConfig();
    expect(config.mcp.authTokenPrevious).toBeUndefined();
    expect(config.mcp.authTokenTtlMs).toBeUndefined();
    expect(config.mcp.authTokenGraceMs).toBe(24 * 3_600_000);
  });

  it("parses MCP_AUTH_TOKEN_TTL_DAYS / _GRACE_HOURS / _PREVIOUS (fractional ok)", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.MCP_AUTH_TOKEN_PREVIOUS = "old-token";
    process.env.MCP_AUTH_TOKEN_TTL_DAYS = "30";
    process.env.MCP_AUTH_TOKEN_GRACE_HOURS = "0.5";
    const config = loadConfig();
    expect(config.mcp.authTokenPrevious).toBe("old-token");
    expect(config.mcp.authTokenTtlMs).toBe(30 * 86_400_000);
    expect(config.mcp.authTokenGraceMs).toBe(Math.round(0.5 * 3_600_000));
  });

  it("throws on a non-positive / garbage MCP_AUTH_TOKEN_TTL_DAYS", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    process.env.MCP_AUTH_TOKEN_TTL_DAYS = "0";
    expect(() => loadConfig()).toThrow(/MCP_AUTH_TOKEN_TTL_DAYS must be a positive number/);
    process.env.MCP_AUTH_TOKEN_TTL_DAYS = "soon";
    expect(() => loadConfig()).toThrow(/MCP_AUTH_TOKEN_TTL_DAYS must be a positive number/);
  });

  // Issue #69: multiple named CCU targets (profiles)
  describe("CCU profiles", () => {
    it("flat config (no CCU_PROFILES) yields a single 'default' profile, ccu alias intact", () => {
      process.env.CCU_HOST = "debmatic";
      process.env.CCU_PASSWORD = "secret";
      const config = loadConfig();
      expect(config.profiles).toHaveLength(1);
      expect(config.profiles[0]!.name).toBe("default");
      expect(config.profiles[0]!.protected).toBe(false);
      expect(config.profiles[0]!.readonly).toBe(false);
      expect(config.defaultProfile).toBe("default");
      // ccu stays an alias of the default profile (back-compat)
      expect(config.ccu).toBe(config.profiles[0]!.ccu);
      expect(config.ccu.host).toBe("debmatic");
      expect(config.ccu.password).toBe("secret");
    });

    it("builds one profile per CCU_PROFILES entry from CCU_<NAME>_* vars", () => {
      process.env.CCU_PROFILES = "prod,dev";
      process.env.CCU_DEFAULT_PROFILE = "prod";
      process.env.CCU_PROD_HOST = "debmatic";
      process.env.CCU_PROD_USER = "claude";
      process.env.CCU_PROD_PASSWORD = "topsecret";
      process.env.CCU_PROD_HTTPS = "true";
      process.env.CCU_PROD_PROTECTED = "true";
      process.env.CCU_DEV_HOST = "127.0.0.1";
      process.env.CCU_DEV_PORT = "18080";
      // dev password intentionally unset (OpenCCU default empty)

      const config = loadConfig();
      expect(config.profiles.map((p) => p.name)).toEqual(["prod", "dev"]);
      expect(config.defaultProfile).toBe("prod");
      expect(config.ccu.host).toBe("debmatic"); // alias = default (prod)

      const prod = config.profiles[0]!;
      expect(prod.protected).toBe(true);
      expect(prod.ccu.user).toBe("claude");
      expect(prod.ccu.https).toBe(true);
      expect(prod.ccu.port).toBe(443); // https default

      const dev = config.profiles[1]!;
      expect(dev.protected).toBe(false);
      expect(dev.ccu.host).toBe("127.0.0.1");
      expect(dev.ccu.port).toBe(18080);
      expect(dev.ccu.user).toBe("Admin"); // default
      expect(dev.ccu.password).toBe(""); // empty allowed
      expect(dev.ccu.https).toBe(false);
    });

    it("defaults the active profile to the first listed when CCU_DEFAULT_PROFILE is unset", () => {
      process.env.CCU_PROFILES = "dev,prod";
      process.env.CCU_DEV_HOST = "127.0.0.1";
      process.env.CCU_PROD_HOST = "debmatic";
      expect(loadConfig().defaultProfile).toBe("dev");
    });

    it("throws if a profile is missing its HOST", () => {
      process.env.CCU_PROFILES = "prod";
      // no CCU_PROD_HOST
      expect(() => loadConfig()).toThrow(/profile "prod" is missing CCU_PROD_HOST/);
    });

    it("throws if CCU_DEFAULT_PROFILE names an unknown profile", () => {
      process.env.CCU_PROFILES = "prod";
      process.env.CCU_PROD_HOST = "debmatic";
      process.env.CCU_DEFAULT_PROFILE = "dev";
      expect(() => loadConfig()).toThrow(/CCU_DEFAULT_PROFILE="dev" is not one of CCU_PROFILES/);
    });

    it("rejects duplicate profile names", () => {
      process.env.CCU_PROFILES = "prod,Prod";
      process.env.CCU_PROD_HOST = "debmatic";
      expect(() => loadConfig()).toThrow(/lists "Prod" more than once/);
    });

    it("reads per-profile READONLY flag", () => {
      process.env.CCU_PROFILES = "prod";
      process.env.CCU_PROD_HOST = "debmatic";
      process.env.CCU_PROD_READONLY = "true";
      expect(loadConfig().profiles[0]!.readonly).toBe(true);
    });
  });
});
