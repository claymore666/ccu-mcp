import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { run } from "../../src/cli/doctor.js";
import type { PromptIo } from "../../src/cli/prompt.js";
import { startMockCcu, startMockCcuTls, adminResults, type MockCcu } from "./_mock-ccu.js";

const HAVE_OPENSSL = spawnSync("openssl", ["version"]).status === 0;

// doctor loads the env file into process.env (same precedence as the server's
// --env flag), so every test must start from a scrubbed environment and leave
// no residue for the next one.
const savedEnv = { ...process.env };
function scrubEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (/^(CCU_|MCP_|CACHE_)/.test(key)) delete process.env[key];
  }
}
function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
}

function makeIo(answers: string[], tty = false): { io: PromptIo; output: () => string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (tty) input.isTTY = true;
  const output = new PassThrough();
  let out = "";
  output.on("data", (chunk) => (out += String(chunk)));
  input.end(answers.join("\n") + "\n");
  return { io: { input, output }, output: () => out };
}

describe("ccu-mcp doctor", () => {
  let dir: string;
  let envPath: string;
  let mock: MockCcu | undefined;

  beforeEach(() => {
    scrubEnv();
    dir = mkdtempSync(join(tmpdir(), "cli-doctor-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
    await mock?.close();
    mock = undefined;
  });

  it("passes on a valid flat configuration", async () => {
    mock = await startMockCcu(adminResults());
    writeFileSync(envPath, `CCU_HOST=127.0.0.1\nCCU_PORT=${mock.port}\nCCU_PASSWORD=pw\n`);
    const { io, output } = makeIo([]);
    expect(await run(["--env", envPath], io)).toBe(0);
    expect(output()).toContain("All checks passed");
    expect(output()).toContain("privilege level ADMIN");
  });

  it("fails when the env file does not exist", async () => {
    const { io, output } = makeIo([]);
    expect(await run(["--env", join(dir, "missing.env")], io)).toBe(1);
    expect(output()).toContain("✗");
  });

  it("reports configuration errors as findings", async () => {
    writeFileSync(envPath, "CCU_HOST=127.0.0.1\n"); // no password
    const { io, output } = makeIo([]);
    expect(await run(["--env", envPath], io)).toBe(1);
    expect(output()).toContain("configuration invalid");
    expect(output()).toContain("CCU_PASSWORD");
  });

  it("fails on an unreachable CCU", async () => {
    // Reserve a port and free it again so nothing answers there.
    mock = await startMockCcu();
    const port = mock.port;
    await mock.close();
    mock = undefined;
    writeFileSync(envPath, `CCU_HOST=127.0.0.1\nCCU_PORT=${port}\nCCU_PASSWORD=pw\n`);
    const { io, output } = makeIo([]);
    expect(await run(["--env", envPath], io)).toBe(1);
    expect(output()).toContain("not reachable");
  });

  it("checks every profile of a multi-target file", async () => {
    mock = await startMockCcu(adminResults());
    writeFileSync(
      envPath,
      [
        "CCU_PROFILES=prod,dev",
        "CCU_DEFAULT_PROFILE=prod",
        `CCU_PROD_HOST=127.0.0.1`,
        `CCU_PROD_PORT=${mock.port}`,
        "CCU_PROD_PASSWORD=pw",
        `CCU_DEV_HOST=127.0.0.1`,
        `CCU_DEV_PORT=${mock.port}`,
        "CCU_DEV_PASSWORD=pw",
        "",
      ].join("\n"),
    );
    const { io, output } = makeIo([]);
    expect(await run(["--env", envPath], io)).toBe(0);
    expect(output()).toContain('Target "prod"');
    expect(output()).toContain('Target "dev"');
  });
});

describe.skipIf(!HAVE_OPENSSL)("ccu-mcp doctor TLS pin checks", () => {
  let dir: string;
  let tlsDir: string;
  let envPath: string;
  let mock: MockCcu;
  let fingerprint: string;

  beforeEach(async () => {
    scrubEnv();
    dir = mkdtempSync(join(tmpdir(), "cli-doctor-tls-"));
    tlsDir = mkdtempSync(join(tmpdir(), "cli-doctor-cert-"));
    envPath = join(dir, ".env");
    const certPath = join(tlsDir, "cert.pem");
    const keyPath = join(tlsDir, "key.pem");
    spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=ccu-doctor",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
    const certPem = readFileSync(certPath, "utf-8");
    fingerprint = new X509Certificate(certPem).fingerprint256;
    mock = await startMockCcuTls({ cert: certPem, key: readFileSync(keyPath, "utf-8") }, adminResults());
  });

  afterEach(async () => {
    restoreEnv();
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

  it("passes when the pinned fingerprint matches", async () => {
    writeEnv(fingerprint);
    const { io, output } = makeIo([]);
    expect(await run(["--env", envPath], io)).toBe(0);
    expect(output()).toContain("fingerprint matches");
  });

  it("reports a mismatch and skips the login test (non-interactive)", async () => {
    writeEnv("00".repeat(32));
    const { io, output } = makeIo([]);
    expect(await run(["--env", envPath], io)).toBe(1);
    expect(output()).toContain("does NOT match");
    expect(output()).toContain("skipping the login test");
    // Non-interactive: the file must not have been touched.
    expect(readFileSync(envPath, "utf-8")).toContain("00".repeat(32));
  });

  it("offers to refresh the pin when interactive, then a re-run passes", async () => {
    writeEnv("00".repeat(32));
    const first = makeIo(["y"], true);
    expect(await run(["--env", envPath], first.io)).toBe(1);
    expect(first.output()).toContain("Pin updated");
    expect(readFileSync(envPath, "utf-8")).toContain(`CCU_TLS_FINGERPRINT=${fingerprint}`);

    // Doctor's env application skips already-set keys; scrub between runs so
    // the second run reads the refreshed file, not the first run's residue.
    scrubEnv();
    const second = makeIo([]);
    expect(await run(["--env", envPath], second.io)).toBe(0);
    expect(second.output()).toContain("All checks passed");
  });

  it("leaves the pin alone when the user declines", async () => {
    writeEnv("00".repeat(32));
    const { io } = makeIo(["n"], true);
    expect(await run(["--env", envPath], io)).toBe(1);
    expect(readFileSync(envPath, "utf-8")).toContain("00".repeat(32));
  });
});
