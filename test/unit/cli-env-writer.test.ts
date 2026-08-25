import { describe, it, expect } from "vitest";
import { parseEnv } from "node:util";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MANAGED_KEY_RE,
  quoteEnvValue,
  buildEnvContent,
  mergeEnvContent,
  replaceEnvKey,
  writeEnvFile,
  type WizardProfile,
} from "../../src/cli/env-writer.js";

function profile(overrides: Partial<WizardProfile> = {}): WizardProfile {
  return {
    name: "default",
    host: "ccu.local",
    port: 443,
    https: true,
    user: "Admin",
    password: "pw",
    protected: false,
    readonly: false,
    ...overrides,
  };
}

describe("quoteEnvValue", () => {
  // Round-trip through the same parser doctor and the server's --env flag
  // use: whatever the writer quotes, parseEnv must read back verbatim.
  it("round-trips awkward values through util.parseEnv", () => {
    const values = ["plain", "with space", "pa#ss", 'quo"te', "s'ngle", "back`tick", 'mi"x\'ed', "", "tra1l1ng!"];
    for (const value of values) {
      const parsed = parseEnv(`KEY=${quoteEnvValue(value)}`) as Record<string, string>;
      expect(parsed.KEY, JSON.stringify(value)).toBe(value);
    }
  });

  it("rejects a value containing all three quote characters", () => {
    expect(() => quoteEnvValue("a\"b'c`d")).toThrow(/quote characters/);
  });
});

describe("buildEnvContent", () => {
  it("writes flat vars for a single target", () => {
    const content = buildEnvContent([profile({ tlsFingerprint: "AB:CD" })], "default");
    expect(content).toContain("CCU_HOST=ccu.local");
    expect(content).toContain("CCU_PORT=443");
    expect(content).toContain("CCU_HTTPS=true");
    expect(content).toContain("CCU_USER=Admin");
    expect(content).toContain("CCU_PASSWORD=pw");
    expect(content).toContain("CCU_TLS_FINGERPRINT=AB:CD");
    expect(content).not.toContain("CCU_PROFILES");
    expect(content).not.toContain("PROTECTED");
  });

  it("writes CCU_PROFILES form for multiple targets", () => {
    const content = buildEnvContent(
      [
        profile({ name: "prod", protected: true }),
        profile({ name: "dev", host: "dev.local", https: false, port: 80, readonly: true }),
      ],
      "prod",
    );
    expect(content).toContain("CCU_PROFILES=prod,dev");
    expect(content).toContain("CCU_DEFAULT_PROFILE=prod");
    expect(content).toContain("CCU_PROD_HOST=ccu.local");
    expect(content).toContain("CCU_PROD_PROTECTED=true");
    expect(content).toContain("CCU_DEV_HOST=dev.local");
    expect(content).toContain("CCU_DEV_READONLY=true");
    expect(content).not.toContain("CCU_DEV_PROTECTED");
    expect(content).not.toContain("\nCCU_HOST=");
  });
});

describe("mergeEnvContent", () => {
  const existing = [
    "# operator notes",
    "MCP_AUTH_TOKEN=tok123",
    "CCU_HOST=old.local",
    "CCU_PASSWORD=oldpw",
    "CCU_OLDPROF_HOST=stale.local",
    "CCU_RATE_LIMIT_BURST=50",
    "CCU_TIMEOUT=20000",
    "LOG_LEVEL=debug",
  ].join("\n");

  it("replaces managed keys (any profile prefix) and preserves the rest", () => {
    const managed = buildEnvContent([profile()], "default");
    const { content, replaced } = mergeEnvContent(existing, managed);
    expect(replaced).toEqual(["CCU_HOST", "CCU_PASSWORD", "CCU_OLDPROF_HOST"]);
    expect(content).toContain("CCU_HOST=ccu.local");
    expect(content).not.toContain("old.local");
    expect(content).not.toContain("stale.local");
    // Operator-owned lines survive: token, comments, tuning knobs.
    expect(content).toContain("MCP_AUTH_TOKEN=tok123");
    expect(content).toContain("# operator notes");
    expect(content).toContain("CCU_RATE_LIMIT_BURST=50");
    expect(content).toContain("CCU_TIMEOUT=20000");
    expect(content).toContain("LOG_LEVEL=debug");
  });

  it("managed-key regex owns the roster keys but not tuning knobs", () => {
    for (const line of ["CCU_PROFILES=a,b", "CCU_DEFAULT_PROFILE=a", "CCU_PROD_TLS_FINGERPRINT=x"]) {
      expect(MANAGED_KEY_RE.test(line), line).toBe(true);
    }
    for (const line of ["CCU_RATE_LIMIT_BURST=1", "CCU_RATE_LIMIT_RATE=1", "CCU_TIMEOUT=1", "CCU_PROD_SCRIPT_TIMEOUT=1", "MCP_PORT=3000"]) {
      expect(MANAGED_KEY_RE.test(line), line).toBe(false);
    }
  });
});

describe("replaceEnvKey", () => {
  it("replaces an existing key in place", () => {
    const content = "CCU_HOST=x\nCCU_TLS_FINGERPRINT=old\nLOG_LEVEL=info\n";
    const out = replaceEnvKey(content, "CCU_TLS_FINGERPRINT", "new");
    expect(out).toContain("CCU_TLS_FINGERPRINT=new");
    expect(out).not.toContain("old");
    expect(out).toContain("LOG_LEVEL=info");
  });

  it("appends when the key is missing", () => {
    const out = replaceEnvKey("CCU_HOST=x\n", "CCU_TLS_FINGERPRINT", "new");
    expect(out).toContain("CCU_HOST=x");
    expect(out.trimEnd().endsWith("CCU_TLS_FINGERPRINT=new")).toBe(true);
  });
});

describe("writeEnvFile", () => {
  it("writes mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-env-"));
    try {
      const path = join(dir, ".env");
      writeEnvFile(path, "CCU_HOST=x\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf-8")).toBe("CCU_HOST=x\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
