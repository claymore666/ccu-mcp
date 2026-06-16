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
    // parseIntEnv("FOO", ...) — indirect numeric reads
    for (const m of text.matchAll(/parseIntEnv\("([A-Z][A-Z0-9_]*)"/g)) {
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
