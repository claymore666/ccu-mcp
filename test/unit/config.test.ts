import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    delete process.env.CACHE_DIR;
    delete process.env.CACHE_TTL;
    delete process.env.CCU_RATE_LIMIT_BURST;
    delete process.env.CCU_RATE_LIMIT_RATE;
    delete process.env.RESOURCE_POLL_INTERVAL;
    delete process.env.CCU_TIMEOUT;
    delete process.env.CCU_SCRIPT_TIMEOUT;
    delete process.env.CCU_TLS_VERIFY;
    delete process.env.LOG_LEVEL;
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

  it("parses CCU_TLS_VERIFY (default off)", () => {
    process.env.CCU_HOST = "test";
    process.env.CCU_PASSWORD = "pw";
    expect(loadConfig().ccu.tlsVerify).toBe(false);

    process.env.CCU_TLS_VERIFY = "true";
    expect(loadConfig().ccu.tlsVerify).toBe(true);
  });
});
