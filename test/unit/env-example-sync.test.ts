import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Guard: .env.example must document every environment variable the code reads,
// and must not list any that the code doesn't. Keeps the example exhaustive
// (and honest) as env vars come and go.

const SRC = join(__dirname, "../../src");
const ENV_EXAMPLE = join(__dirname, "../../.env.example");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function envKeysReferencedInCode(): Set<string> {
  const keys = new Set<string>();
  for (const file of collectTsFiles(SRC)) {
    const text = readFileSync(file, "utf-8");
    // process.env.FOO and process.env["FOO"]
    for (const m of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\["([A-Z][A-Z0-9_]*)"\])/g)) {
      keys.add(m[1] ?? m[2]);
    }
    // parseIntEnv("FOO", …) / parseDurationEnv("FOO", …) / parseBoolEnv("FOO")
    // — indirect reads. Keep this alternation in step with the helpers in
    // config.ts, or a var read only through a new helper looks undocumented.
    for (const m of text.matchAll(/parse(?:Int|Duration|Bool)Env\("([A-Z][A-Z0-9_]*)"/g)) {
      keys.add(m[1]);
    }
  }
  return keys;
}

function envKeysInExample(): Set<string> {
  const keys = new Set<string>();
  for (const line of readFileSync(ENV_EXAMPLE, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// server.json is the MCP REGISTRY manifest — what someone installing from the
// registry reads. It drifted to 10 of 30 variables because nothing checked it
// (issue #126). It is not a straight mirror of the code: the manifest declares
// the STDIO package, so the HTTP-transport variables genuinely do not apply.
// List those exemptions explicitly, so the exemption is a decision on the
// record rather than an omission.
const SERVER_JSON = join(__dirname, "../../server.json");
const HTTP_ONLY_VARS = new Set([
  "MCP_TRANSPORT", "MCP_PORT", "MCP_HOST",
  "MCP_AUTH_TOKEN", "MCP_AUTH_TOKEN_PREVIOUS", "MCP_AUTH_TOKEN_TTL_DAYS", "MCP_AUTH_TOKEN_GRACE_HOURS",
  "MCP_TLS_CERT", "MCP_TLS_KEY", "MCP_ALLOW_PLAINTEXT",
  "MCP_ALLOWED_ORIGINS", "MCP_ALLOWED_HOSTS",
]);

describe("server.json (MCP registry manifest)", () => {
  const manifest = () => JSON.parse(readFileSync(SERVER_JSON, "utf-8"));

  it("documents every env var that applies to the stdio package", () => {
    const declared = new Set<string>(
      (manifest().packages[0].environmentVariables ?? []).map((v: { name: string }) => v.name),
    );
    const missing = [...envKeysReferencedInCode()]
      .filter((k) => !HTTP_ONLY_VARS.has(k) && !declared.has(k))
      .sort();
    expect(missing, `env vars read in code but missing from server.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not declare env vars the code never reads", () => {
    const code = envKeysReferencedInCode();
    const stale = ((manifest().packages[0].environmentVariables ?? []) as Array<{ name: string }>)
      .map((v) => v.name)
      .filter((n) => !code.has(n))
      .sort();
    expect(stale, `env vars in server.json not read anywhere in code: ${stale.join(", ")}`).toEqual([]);
  });
});

describe(".env.example", () => {
  it("documents every env var the code reads", () => {
    const code = envKeysReferencedInCode();
    const example = envKeysInExample();
    const missing = [...code].filter((k) => !example.has(k)).sort();
    expect(missing, `env vars read in code but missing from .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not list env vars the code never reads", () => {
    const code = envKeysReferencedInCode();
    const example = envKeysInExample();
    const stale = [...example].filter((k) => !code.has(k)).sort();
    expect(stale, `env vars in .env.example not read anywhere in code: ${stale.join(", ")}`).toEqual([]);
  });
});

// README.md is the third surface, and the only one a user reads BEFORE
// installing — .env.example and server.json are both things you meet after
// you've already committed to the server. It was the one surface nothing
// checked.
const README = join(__dirname, "../../README.md");

// Documented in the "Multiple CCU targets (profiles)" section as a worked
// .env example rather than as table rows, because they are not standalone
// settings: CCU_PROFILES names the profiles, and every other profile variable
// is spelled CCU_<PROFILE>_* and so cannot be tabulated by a fixed name at all.
// Listed explicitly so the exemption is a decision on the record rather than an
// omission — same convention as HTTP_ONLY_VARS above.
const PROSE_DOCUMENTED_VARS = new Set(["CCU_PROFILES", "CCU_DEFAULT_PROFILE"]);

/**
 * Env vars appearing in a README markdown table's first cell. One cell may
 * carry several — `MCP_TLS_CERT` / `MCP_TLS_KEY` share a row, since setting
 * only one of them is a configuration error and they document as a pair.
 */
function envKeysInReadmeTables(): Set<string> {
  const keys = new Set<string>();
  for (const row of readFileSync(README, "utf-8").matchAll(/^\|([^|]+)\|/gm)) {
    for (const m of row[1].matchAll(/`([A-Z][A-Z0-9_]*)`/g)) keys.add(m[1]);
  }
  return keys;
}

describe("README.md", () => {
  it("documents every env var the code reads", () => {
    const documented = envKeysInReadmeTables();
    const missing = [...envKeysReferencedInCode()]
      .filter((k) => !documented.has(k) && !PROSE_DOCUMENTED_VARS.has(k))
      .sort();
    expect(missing, `env vars read in code but missing from README's tables: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not document env vars the code never reads", () => {
    const code = envKeysReferencedInCode();
    const stale = [...envKeysInReadmeTables()].filter((k) => !code.has(k)).sort();
    expect(stale, `env vars in README's tables not read anywhere in code: ${stale.join(", ")}`).toEqual([]);
  });

  // Without this, dropping a var from the code and from the README together
  // leaves a permanent exemption nobody revisits — the stale-allowlist problem
  // that .github/vuln-allowlist.txt's gate warns about for advisories.
  it("has no stale prose-documented exemptions", () => {
    const code = envKeysReferencedInCode();
    const stale = [...PROSE_DOCUMENTED_VARS].filter((k) => !code.has(k)).sort();
    expect(stale, `PROSE_DOCUMENTED_VARS entries no longer read in code: ${stale.join(", ")}`).toEqual([]);
  });
});
