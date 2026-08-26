import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSetupServer } from "../../src/setup-server.js";
import { configFromEnvFile, profilesFromVars } from "../../src/tools/setup.js";
import { Logger } from "../../src/logger.js";
import { callTool, parseToolResult } from "./_helpers.js";
import { startMockCcu, startMockCcuTls, adminResults, type MockCcu } from "./_mock-ccu.js";

const HAVE_OPENSSL = spawnSync("openssl", ["version"]).status === 0;
const CONFIG_ERROR = "CCU_HOST environment variable is required";

function makeServer(envPath: string): McpServer {
  return createSetupServer(envPath, CONFIG_ERROR, new Logger("error"));
}

function registeredTools(server: McpServer): string[] {
  return Object.keys((server as any)._registeredTools).sort();
}

describe("setup-mode server", () => {
  let dir: string;
  let envPath: string;
  let server: McpServer;
  let mock: MockCcu | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "setup-tools-"));
    envPath = join(dir, ".env");
    server = makeServer(envPath);
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await mock?.close();
    mock = undefined;
  });

  it("registers exactly the four setup tools — nothing CCU-backed", () => {
    expect(registeredTools(server)).toEqual([
      "setup_probe",
      "setup_status",
      "setup_test",
      "setup_write_profile",
    ]);
    expect((server as any)._registeredResources ?? {}).toEqual({});
    expect((server as any)._registeredPrompts ?? {}).toEqual({});
  });

  it("carries the flow and the password rule in its instructions", () => {
    const instructions = (server.server as any)._instructions as string;
    expect(instructions).toContain(envPath);
    expect(instructions).toContain(CONFIG_ERROR);
    expect(instructions).toContain("NEVER travel through this conversation");
    expect(instructions).toContain("ccu-mcp secret");
  });

  it("setup_write_profile exposes no password parameter", () => {
    const tool = (server as any)._registeredTools.setup_write_profile;
    expect(Object.keys(tool.inputSchema.shape)).not.toContain("password");
  });

  describe("setup_status", () => {
    it("reports a missing file with the config error", async () => {
      const res = parseToolResult(await callTool(server, "setup_status")) as any;
      expect(res.fileExists).toBe(false);
      expect(res.configError).toBe(CONFIG_ERROR);
      expect(res.profiles).toEqual([]);
    });

    it("reads a flat file back, reporting the password only as a boolean", async () => {
      writeFileSync(envPath, "CCU_HOST=ccu.local\nCCU_PORT=8080\nCCU_PASSWORD=hunter2\n");
      const raw = await callTool(server, "setup_status");
      const res = parseToolResult(raw) as any;
      expect(res.profiles).toEqual([
        expect.objectContaining({
          name: "default",
          host: "ccu.local",
          port: 8080,
          https: false,
          user: "Admin",
          passwordStored: true,
          tlsFingerprintPinned: false,
        }),
      ]);
      expect(JSON.stringify(raw)).not.toContain("hunter2");
    });

    it("reads a multi-profile file back", async () => {
      writeFileSync(
        envPath,
        [
          "CCU_PROFILES=prod,dev",
          "CCU_DEFAULT_PROFILE=prod",
          "CCU_PROD_HOST=ccu.local",
          "CCU_PROD_HTTPS=true",
          "CCU_PROD_PORT=443",
          "CCU_PROD_TLS_FINGERPRINT=AA:BB",
          "CCU_PROD_PASSWORD=secret",
          "CCU_PROD_PROTECTED=true",
          "CCU_DEV_HOST=127.0.0.1",
          "CCU_DEV_PORT=18080",
          "",
        ].join("\n"),
      );
      const res = parseToolResult(await callTool(server, "setup_status")) as any;
      expect(res.defaultProfile).toBe("prod");
      expect(res.profiles).toHaveLength(2);
      expect(res.profiles[0]).toMatchObject({
        name: "prod",
        https: true,
        tlsFingerprintPinned: true,
        passwordStored: true,
        protected: true,
      });
      expect(res.profiles[1]).toMatchObject({ name: "dev", port: 18080, passwordStored: false });
    });
  });

  describe("setup_probe", () => {
    it("finds a CCU on an explicit port", async () => {
      mock = await startMockCcu();
      const res = parseToolResult(
        await callTool(server, "setup_probe", { host: "127.0.0.1", port: mock.port, https: false }),
      ) as any;
      expect(res.reachable).toBe(true);
      expect(res.port).toBe(mock.port);
      expect(res.https).toBe(false);
      expect(res.cert).toBeUndefined();
    });

    it("reports an unreachable endpoint", async () => {
      mock = await startMockCcu();
      const port = mock.port;
      await mock.close();
      mock = undefined;
      const res = parseToolResult(
        await callTool(server, "setup_probe", { host: "127.0.0.1", port, https: false }),
      ) as any;
      expect(res.reachable).toBe(false);
      expect(res.detail).toContain("No CCU API found");
    });
  });

  describe("setup_write_profile", () => {
    it("writes the flat form for a single default target, without a password", async () => {
      const res = parseToolResult(
        await callTool(server, "setup_write_profile", {
          name: "default",
          host: "ccu.local",
          port: 80,
          https: false,
          user: "Admin",
        }),
      ) as any;
      expect(res.written).toBe(true);
      expect(res.nextStep).toContain("ccu-mcp secret");
      expect(res.nextStep).toContain(envPath);
      const content = readFileSync(envPath, "utf-8");
      expect(content).toContain("CCU_HOST=ccu.local");
      expect(content).not.toContain("CCU_PROFILES");
      // No placeholder: an absent key is what tells loadConfig the password has
      // not been chosen yet, so the server stays in setup mode. `CCU_PASSWORD=""`
      // would read as a deliberately empty one and start the server unconfigured.
      expect(content).not.toContain("CCU_PASSWORD");
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    });

    it("keeps the CCU_PROFILES form for a named single target", async () => {
      await callTool(server, "setup_write_profile", {
        name: "dev",
        host: "127.0.0.1",
        port: 18080,
        https: false,
        user: "Admin",
      });
      const content = readFileSync(envPath, "utf-8");
      expect(content).toContain("CCU_PROFILES=dev");
      expect(content).toContain("CCU_DEV_HOST=127.0.0.1");
    });

    it("upserts a second target, preserving the first one's stored password", async () => {
      writeFileSync(
        envPath,
        "CCU_PROFILES=prod\nCCU_DEFAULT_PROFILE=prod\nCCU_PROD_HOST=ccu.local\nCCU_PROD_PORT=443\nCCU_PROD_HTTPS=true\nCCU_PROD_USER=Admin\nCCU_PROD_PASSWORD=hunter2\n# operator note\nLOG_LEVEL=debug\n",
      );
      const raw = await callTool(server, "setup_write_profile", {
        name: "dev",
        host: "127.0.0.1",
        port: 18080,
        https: false,
        user: "Admin",
      });
      const res = parseToolResult(raw) as any;
      expect(res.profiles).toEqual(["prod", "dev"]);
      expect(res.defaultProfile).toBe("prod");
      expect(JSON.stringify(raw)).not.toContain("hunter2");
      const content = readFileSync(envPath, "utf-8");
      expect(content).toContain("CCU_PROD_PASSWORD=hunter2");
      expect(content).toContain("CCU_DEV_HOST=127.0.0.1");
      expect(content).toContain("LOG_LEVEL=debug");
      expect(content).toContain("# operator note");
    });

    it("keeps a stored password when rewriting the same endpoint, drops it when the host moves", async () => {
      writeFileSync(envPath, "CCU_HOST=ccu.local\nCCU_PORT=80\nCCU_PASSWORD=hunter2\n");
      await callTool(server, "setup_write_profile", {
        name: "default",
        host: "ccu.local",
        port: 80,
        https: false,
        user: "Other",
      });
      expect(readFileSync(envPath, "utf-8")).toContain("CCU_PASSWORD=hunter2");

      await callTool(server, "setup_write_profile", {
        name: "default",
        host: "elsewhere.local",
        port: 80,
        https: false,
        user: "Other",
      });
      const content = readFileSync(envPath, "utf-8");
      expect(content).not.toContain("hunter2");
      expect(content).not.toContain("CCU_PASSWORD");
    });

    it("preserves a deliberately empty password across a rewrite of the same endpoint", async () => {
      writeFileSync(envPath, 'CCU_HOST=ccu.local\nCCU_PORT=80\nCCU_PASSWORD=""\n');
      const res = parseToolResult(
        await callTool(server, "setup_write_profile", {
          name: "default", host: "ccu.local", port: 80, https: false, user: "Admin",
        }),
      ) as any;
      // An empty password the user chose is a decision, not a missing value:
      // it survives the rewrite and must not send them back to `ccu-mcp secret`.
      expect(readFileSync(envPath, "utf-8")).toContain('CCU_PASSWORD=""');
      expect(res.nextStep).not.toContain("ccu-mcp secret");
    });

    it("honors makeDefault", async () => {
      await callTool(server, "setup_write_profile", {
        name: "prod", host: "ccu.local", port: 80, https: false, user: "Admin",
      });
      const res = parseToolResult(
        await callTool(server, "setup_write_profile", {
          name: "dev", host: "127.0.0.1", port: 18080, https: false, user: "Admin", makeDefault: true,
        }),
      ) as any;
      expect(res.defaultProfile).toBe("dev");
      expect(readFileSync(envPath, "utf-8")).toContain("CCU_DEFAULT_PROFILE=dev");
    });

    it("rejects a fingerprint on a plain-HTTP target", async () => {
      const res = callTool(server, "setup_write_profile", {
        name: "default", host: "ccu.local", port: 80, https: false, user: "Admin",
        tlsFingerprint: "AA:BB",
      });
      await expect(res).rejects.toThrow(/HTTPS/);
    });
  });

  describe("setup_test", () => {
    it("reports an invalid configuration as a failing finding", async () => {
      writeFileSync(envPath, "CCU_HOST=ccu.local\n"); // flat form, no password
      const res = parseToolResult(await callTool(server, "setup_test")) as any;
      expect(res.ok).toBe(false);
      expect(res.findings[0]).toMatchObject({ check: "config", ok: false });
      expect(res.findings[0].detail).toContain("CCU_PASSWORD");
    });

    it("passes end-to-end against a mock CCU and points at reconnecting", async () => {
      mock = await startMockCcu(adminResults());
      writeFileSync(envPath, `CCU_HOST=127.0.0.1\nCCU_PORT=${mock.port}\nCCU_PASSWORD=hunter2\n`);
      const raw = await callTool(server, "setup_test");
      const res = parseToolResult(raw) as any;
      expect(res.ok).toBe(true);
      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ check: "reachability", ok: true }),
          expect.objectContaining({ check: "login", ok: true }),
        ]),
      );
      expect(res.findings.find((f: any) => f.check === "login").detail).toContain("ADMIN");
      expect(res.nextStep).toContain("reconnect");
      expect(JSON.stringify(raw)).not.toContain("hunter2");
    });

    it("fails on an unreachable CCU without aborting other profiles", async () => {
      mock = await startMockCcu(adminResults());
      // Reserve a port and free it again so nothing answers there.
      const dead = await startMockCcu();
      const deadPort = dead.port;
      await dead.close();
      writeFileSync(
        envPath,
        [
          "CCU_PROFILES=up,down",
          "CCU_UP_HOST=127.0.0.1",
          `CCU_UP_PORT=${mock.port}`,
          "CCU_UP_PASSWORD=pw",
          "CCU_DOWN_HOST=127.0.0.1",
          `CCU_DOWN_PORT=${deadPort}`,
          "CCU_DOWN_PASSWORD=pw",
          "",
        ].join("\n"),
      );
      const res = parseToolResult(await callTool(server, "setup_test")) as any;
      expect(res.ok).toBe(false);
      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ profile: "up", check: "login", ok: true }),
          expect.objectContaining({ profile: "down", check: "reachability", ok: false }),
        ]),
      );
    });
  });
});

describe("configFromEnvFile", () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "setup-cfg-"));
    envPath = join(dir, ".env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CCU_HOST;
    delete process.env.CCU_PASSWORD;
  });

  it("evaluates the FILE, not the process environment", () => {
    process.env.CCU_HOST = "process-sentinel";
    process.env.CCU_PASSWORD = "process-pw";
    writeFileSync(envPath, "CCU_HOST=file.local\nCCU_PASSWORD=file-pw\n");
    const config = configFromEnvFile(envPath);
    expect(config.ccu.host).toBe("file.local");
    // …and restores the environment afterwards.
    expect(process.env.CCU_HOST).toBe("process-sentinel");
    expect(process.env.CCU_PASSWORD).toBe("process-pw");
  });

  it("restores the environment even when loadConfig throws", () => {
    process.env.CCU_HOST = "process-sentinel";
    writeFileSync(envPath, "CCU_HOST=file.local\n"); // missing password → throws
    expect(() => configFromEnvFile(envPath)).toThrow(/CCU_PASSWORD/);
    expect(process.env.CCU_HOST).toBe("process-sentinel");
  });
});

describe("profilesFromVars", () => {
  it("returns nothing for an empty map", () => {
    expect(profilesFromVars({})).toEqual({ profiles: [] });
  });

  it("defaults port from the HTTPS flag when PORT is missing or garbage", () => {
    const { profiles } = profilesFromVars({ CCU_HOST: "a", CCU_HTTPS: "true", CCU_PORT: "x" });
    expect(profiles[0].port).toBe(443);
  });
});

describe.skipIf(!HAVE_OPENSSL)("setup_test TLS pin checks", () => {
  let dir: string;
  let tlsDir: string;
  let envPath: string;
  let server: McpServer;
  let mock: MockCcu;
  let fingerprint: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "setup-tls-"));
    tlsDir = mkdtempSync(join(tmpdir(), "setup-cert-"));
    envPath = join(dir, ".env");
    server = makeServer(envPath);
    const certPath = join(tlsDir, "cert.pem");
    const keyPath = join(tlsDir, "key.pem");
    spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=ccu-setup",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
    const certPem = readFileSync(certPath, "utf-8");
    fingerprint = new X509Certificate(certPem).fingerprint256;
    mock = await startMockCcuTls({ cert: certPem, key: readFileSync(keyPath, "utf-8") }, adminResults());
  });

  afterEach(async () => {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(tlsDir, { recursive: true, force: true });
  });

  function writeEnv(pin: string): void {
    writeFileSync(
      envPath,
      `CCU_HOST=127.0.0.1\nCCU_PORT=${mock.port}\nCCU_HTTPS=true\nCCU_TLS_FINGERPRINT=${pin}\nCCU_PASSWORD=pw\n`,
    );
  }

  it("setup_probe returns the presented certificate for pinning", async () => {
    const res = parseToolResult(
      await callTool(server, "setup_probe", { host: "127.0.0.1", port: mock.port, https: true }),
    ) as any;
    expect(res.reachable).toBe(true);
    expect(res.cert.fingerprint256.replace(/:/g, "")).toBe(fingerprint.replace(/:/g, ""));
    expect(res.cert.subjectCN).toBe("ccu-setup");
  });

  it("setup_test passes with the right pin", async () => {
    writeEnv(fingerprint);
    const res = parseToolResult(await callTool(server, "setup_test")) as any;
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "tls-pin", ok: true })]),
    );
  });

  it("setup_test flags a mismatch and skips that profile's login", async () => {
    writeEnv("00".repeat(32));
    const res = parseToolResult(await callTool(server, "setup_test")) as any;
    expect(res.ok).toBe(false);
    const pin = res.findings.find((f: any) => f.check === "tls-pin");
    expect(pin.ok).toBe(false);
    expect(pin.detail).toContain("does NOT match");
    expect(res.findings.some((f: any) => f.check === "login")).toBe(false);
  });
});
