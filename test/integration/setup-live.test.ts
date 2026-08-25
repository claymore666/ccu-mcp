import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSetupServer } from "../../src/setup-server.js";
import { probeApi, probeConfig, testLogin } from "../../src/cli/probe.js";
import { run as runSecret } from "../../src/cli/secret.js";
import { run as runDoctor } from "../../src/cli/doctor.js";
import { Logger } from "../../src/logger.js";
import { callTool, parseToolResult } from "../unit/_helpers.js";

// Live integration for the setup flow against the OpenCCU dev VM — a real
// ReGa, no radio hardware, Admin with (usually) an empty password. Gated on
// CCU_DEV_HOST, so `npm test` stays hermetic; run it with the VM up:
//
//   CCU_DEV_HOST=127.0.0.1 CCU_DEV_PORT=18080 npm test
//
// (CCU_DEV_USER / CCU_DEV_PASSWORD override the Admin/empty default.) These
// are the dev-profile variable names from .env, read directly by this suite —
// deliberately NOT via loadConfig, so the flat CCU_* vars can simultaneously
// point the tools-live suite at another box (or the same one).

const DEV_HOST = process.env.CCU_DEV_HOST;
const describeIf = DEV_HOST ? describe : describe.skip;

const DEV = {
  host: DEV_HOST ?? "",
  port: parseInt(process.env.CCU_DEV_PORT || "80", 10),
  https: process.env.CCU_DEV_HTTPS === "true",
  user: process.env.CCU_DEV_USER || "Admin",
  password: process.env.CCU_DEV_PASSWORD ?? "",
};

describeIf("setup flow against the live dev CCU", () => {
  let dir: string;
  let envPath: string;
  let server: McpServer;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "setup-live-"));
    envPath = join(dir, ".env");
    server = createSetupServer(envPath, "CCU_HOST environment variable is required", new Logger("error"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("probeApi classifies the real JSON-RPC endpoint as a CCU", async () => {
    const outcome = await probeApi(probeConfig(DEV.host, DEV.port, DEV.https));
    expect(outcome.kind).toBe("ccu");
  });

  it("testLogin detects the ADMIN role against the real ReGa", async () => {
    const result = await testLogin({
      host: DEV.host,
      port: DEV.port,
      https: DEV.https,
      tlsVerify: false,
      user: DEV.user,
      password: DEV.password,
      timeout: 10_000,
      scriptTimeout: 30_000,
    });
    expect(result).toMatchObject({ ok: true, role: "ADMIN" });
    if (result.ok) expect(result.version).toMatch(/^\d+\./);
  });

  it("walks probe → write → secret → setup_test green, then doctor agrees", async () => {
    const probe = parseToolResult(
      await callTool(server, "setup_probe", { host: DEV.host, port: DEV.port, https: DEV.https }),
    ) as any;
    expect(probe.reachable).toBe(true);

    const write = parseToolResult(
      await callTool(server, "setup_write_profile", {
        name: "dev",
        host: DEV.host,
        port: DEV.port,
        https: DEV.https,
        user: DEV.user,
      }),
    ) as any;
    expect(write.written).toBe(true);

    // The password hand-off, exactly as a user would run it (piped answer
    // standing in for the hidden prompt).
    const input = new PassThrough();
    const output = new PassThrough();
    output.on("data", () => {});
    input.end(DEV.password + "\n");
    expect(await runSecret(["dev", "--env", envPath], { input, output })).toBe(0);

    const test = parseToolResult(await callTool(server, "setup_test")) as any;
    expect(test.ok).toBe(true);
    expect(test.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profile: "dev", check: "login", ok: true }),
      ]),
    );

    // Independent second opinion: the doctor CLI on the same file. It loads
    // the env file into process.env, so scrub what it may set afterwards.
    const before = { ...process.env };
    try {
      const docOut = new PassThrough();
      let doc = "";
      docOut.on("data", (chunk) => (doc += String(chunk)));
      const docIn = new PassThrough();
      docIn.end();
      expect(await runDoctor(["--env", envPath], { input: docIn, output: docOut })).toBe(0);
      expect(doc).toContain("All checks passed");
      expect(doc).toContain("privilege level ADMIN");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in before)) delete process.env[key];
      }
      Object.assign(process.env, before);
    }

    // The file holds what the flow established — and nothing else leaked out.
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("CCU_PROFILES=dev");
    expect(content).toContain(`CCU_DEV_HOST=${DEV.host}`);
  });
});
