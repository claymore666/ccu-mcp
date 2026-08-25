import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { run } from "../../src/cli/init.js";
import type { PromptIo } from "../../src/cli/prompt.js";
import { startMockCcu, startMockCcuTls, adminResults, type MockCcu } from "./_mock-ccu.js";

const HAVE_OPENSSL = spawnSync("openssl", ["version"]).status === 0;

function makeIo(answers: string[]): { io: PromptIo; output: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (chunk) => (out += String(chunk)));
  input.end(answers.join("\n") + "\n");
  return { io: { input, output }, output: () => out };
}

describe("ccu-mcp init", () => {
  let dir: string;
  let envPath: string;
  let mock: MockCcu | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-init-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await mock?.close();
    mock = undefined;
  });

  it("writes a flat .env for a single target (happy path)", async () => {
    mock = await startMockCcu(adminResults());
    const { io, output } = makeIo([
      "n", // multiple targets?
      "127.0.0.1", // host
      "n", // HTTPS?
      String(mock.port), // port
      "", // user -> Admin
      "s3cret", // password
    ]);
    const code = await run(["--env", envPath], io);
    expect(code).toBe(0);
    expect(output()).toContain("privilege level ADMIN");
    expect(output()).toContain("--env");
    expect(output()).not.toContain("s3cret"); // never echo the password
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("CCU_HOST=127.0.0.1");
    expect(content).toContain(`CCU_PORT=${mock.port}`);
    expect(content).toContain("CCU_HTTPS=false");
    expect(content).toContain("CCU_USER=Admin");
    expect(content).toContain("CCU_PASSWORD=s3cret");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("writes CCU_PROFILES for a multi-target setup", async () => {
    mock = await startMockCcu(adminResults());
    const p = String(mock.port);
    const { io } = makeIo([
      "y", // multiple targets
      "", // name -> prod
      "127.0.0.1", "n", p, "", "pw1", // endpoint + creds
      "y", // protected
      "", // readonly -> n
      "y", // add another
      "dev", // name
      "127.0.0.1", "n", p, "", "pw2",
      "", "", // protected/readonly -> n
      "", // add another -> n
      "dev", // default target
    ]);
    const code = await run(["--env", envPath], io);
    expect(code).toBe(0);
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("CCU_PROFILES=prod,dev");
    expect(content).toContain("CCU_DEFAULT_PROFILE=dev");
    expect(content).toContain("CCU_PROD_PROTECTED=true");
    expect(content).toContain("CCU_DEV_HOST=127.0.0.1");
    expect(content).not.toContain("CCU_DEV_PROTECTED");
  });

  it("warns about USER-level accounts", async () => {
    mock = await startMockCcu({
      ...adminResults(),
      "CCU.getVersion": { __error: { code: 400, message: "access denied" } },
    });
    const { io, output } = makeIo(["n", "127.0.0.1", "n", String(mock.port), "claude", "pw"]);
    expect(await run(["--env", envPath], io)).toBe(0);
    expect(output()).toContain("privilege level USER");
    expect(output()).toContain("need an ADMIN-level CCU user");
  });

  it("aborts without writing when credentials fail and the user gives up", async () => {
    mock = await startMockCcu({
      ...adminResults(),
      "Session.login": { __error: { code: 400, message: "access denied" } },
    });
    const { io, output } = makeIo([
      "n", "127.0.0.1", "n", String(mock.port), "", "wrongpw",
      "n", // re-enter?
      "n", // save anyway?
    ]);
    expect(await run(["--env", envPath], io)).toBe(1);
    expect(output()).toContain("Login failed");
    expect(existsSync(envPath)).toBe(false);
  });

  it("can save untested credentials on explicit request", async () => {
    mock = await startMockCcu({
      ...adminResults(),
      "Session.login": { __error: { code: 400, message: "access denied" } },
    });
    const { io } = makeIo([
      "n", "127.0.0.1", "n", String(mock.port), "", "maybe-right",
      "n", // re-enter?
      "y", // save anyway
    ]);
    expect(await run(["--env", envPath], io)).toBe(0);
    expect(readFileSync(envPath, "utf-8")).toContain("CCU_PASSWORD=maybe-right");
  });

  it("preserves foreign lines and asks before replacing managed keys", async () => {
    mock = await startMockCcu(adminResults());
    writeFileSync(envPath, "MCP_AUTH_TOKEN=tok\nCCU_HOST=old.local\n");
    const { io, output } = makeIo([
      "n", "127.0.0.1", "n", String(mock.port), "", "pw",
      "y", // replace existing CCU settings
    ]);
    expect(await run(["--env", envPath], io)).toBe(0);
    expect(output()).toContain("already configures a CCU");
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("MCP_AUTH_TOKEN=tok");
    expect(content).toContain("CCU_HOST=127.0.0.1");
    expect(content).not.toContain("old.local");
  });

  it("leaves an existing file untouched when the user declines", async () => {
    mock = await startMockCcu(adminResults());
    const before = "CCU_HOST=old.local\nCCU_PASSWORD=oldpw\n";
    writeFileSync(envPath, before);
    const { io } = makeIo([
      "n", "127.0.0.1", "n", String(mock.port), "", "pw",
      "n", // do NOT replace
    ]);
    expect(await run(["--env", envPath], io)).toBe(1);
    expect(readFileSync(envPath, "utf-8")).toBe(before);
  });

  it("returns 130 when the input closes mid-wizard", async () => {
    const { io } = makeIo(["n"]); // only the first answer, then EOF
    expect(await run(["--env", envPath], io)).toBe(130);
    expect(existsSync(envPath)).toBe(false);
  });
});

describe.skipIf(!HAVE_OPENSSL)("ccu-mcp init over HTTPS", () => {
  let dir: string;
  let tlsDir: string;
  let mock: MockCcu;
  let fingerprint: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cli-init-tls-"));
    tlsDir = mkdtempSync(join(tmpdir(), "cli-init-cert-"));
    const certPath = join(tlsDir, "cert.pem");
    const keyPath = join(tlsDir, "key.pem");
    spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=ccu-init",
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

  it("shows the certificate and pins its fingerprint", async () => {
    const envPath = join(dir, ".env");
    const { io, output } = makeIo([
      "n", "127.0.0.1",
      "y", // HTTPS
      String(mock.port),
      "y", // pin fingerprint
      "", "pw",
    ]);
    expect(await run(["--env", envPath], io)).toBe(0);
    expect(output()).toContain("ccu-init"); // subject CN shown
    expect(readFileSync(envPath, "utf-8")).toContain(`CCU_TLS_FINGERPRINT=${fingerprint}`);
  });
});
