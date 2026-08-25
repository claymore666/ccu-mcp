import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { run } from "../../src/cli/secret.js";
import type { PromptIo } from "../../src/cli/prompt.js";

function makeIo(answers: string[]): { io: PromptIo; output: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (chunk) => (out += String(chunk)));
  if (answers.length > 0) input.end(answers.join("\n") + "\n");
  else input.end();
  return { io: { input, output }, output: () => out };
}

describe("ccu-mcp secret", () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-secret-"));
    envPath = join(dir, ".env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes CCU_PASSWORD into a flat file, 0600, everything else untouched", async () => {
    writeFileSync(envPath, "# note\nCCU_HOST=ccu.local\nCCU_USER=Admin\nCCU_PASSWORD=\"\"\nLOG_LEVEL=debug\n");
    const { io, output } = makeIo(["hunter2"]);
    expect(await run(["--env", envPath], io)).toBe(0);
    const content = readFileSync(envPath, "utf-8");
    expect(parseEnv(content).CCU_PASSWORD).toBe("hunter2");
    expect(content).toContain("# note");
    expect(content).toContain("LOG_LEVEL=debug");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(output()).toContain("Wrote CCU_PASSWORD");
    // The hidden prompt must not echo the password back.
    expect(output()).not.toContain("hunter2");
  });

  it("targets the named profile's key in a CCU_PROFILES file", async () => {
    writeFileSync(
      envPath,
      "CCU_PROFILES=prod,dev\nCCU_PROD_HOST=a\nCCU_PROD_PASSWORD=keepme\nCCU_DEV_HOST=b\nCCU_DEV_PASSWORD=\"\"\n",
    );
    const { io } = makeIo(["devpw"]);
    expect(await run(["dev", "--env", envPath], io)).toBe(0);
    const vars = parseEnv(readFileSync(envPath, "utf-8"));
    expect(vars.CCU_DEV_PASSWORD).toBe("devpw");
    expect(vars.CCU_PROD_PASSWORD).toBe("keepme");
  });

  it("quotes awkward passwords so they round-trip through parseEnv", async () => {
    writeFileSync(envPath, "CCU_HOST=ccu.local\n");
    const password = 'sp ace#ha"sh';
    const { io } = makeIo([password]);
    expect(await run(["--env", envPath], io)).toBe(0);
    expect(parseEnv(readFileSync(envPath, "utf-8")).CCU_PASSWORD).toBe(password);
  });

  it("accepts an empty password with a note", async () => {
    writeFileSync(envPath, "CCU_PROFILES=dev\nCCU_DEV_HOST=127.0.0.1\n");
    const { io, output } = makeIo([""]);
    expect(await run(["dev", "--env", envPath], io)).toBe(0);
    expect(output()).toContain("EMPTY password");
    expect(parseEnv(readFileSync(envPath, "utf-8")).CCU_DEV_PASSWORD).toBe("");
  });

  it("requires a profile name when the file defines profiles", async () => {
    writeFileSync(envPath, "CCU_PROFILES=prod,dev\nCCU_PROD_HOST=a\nCCU_DEV_HOST=b\n");
    const { io, output } = makeIo([]);
    expect(await run(["--env", envPath], io)).toBe(1);
    expect(output()).toContain("prod, dev");
  });

  it("rejects an unknown profile name", async () => {
    writeFileSync(envPath, "CCU_PROFILES=prod\nCCU_PROD_HOST=a\n");
    const { io, output } = makeIo(["x"]);
    expect(await run(["staging", "--env", envPath], io)).toBe(1);
    expect(output()).toContain('"staging" is not one of');
  });

  it("rejects a profile name against a flat file", async () => {
    writeFileSync(envPath, "CCU_HOST=a\n");
    const { io, output } = makeIo(["x"]);
    expect(await run(["prod", "--env", envPath], io)).toBe(1);
    expect(output()).toContain("single-CCU form");
  });

  it("fails cleanly when the env file does not exist", async () => {
    const { io, output } = makeIo([]);
    expect(await run(["--env", join(dir, "missing.env")], io)).toBe(1);
    expect(output()).toContain("does not exist");
  });

  it("exits 130 when input closes before an answer", async () => {
    writeFileSync(envPath, "CCU_HOST=a\n");
    const input = new PassThrough();
    const output = new PassThrough();
    output.on("data", () => {});
    input.end(); // EOF with no line at all
    expect(await run(["--env", envPath], { input, output })).toBe(130);
    // Nothing written.
    expect(readFileSync(envPath, "utf-8")).toBe("CCU_HOST=a\n");
  });
});
