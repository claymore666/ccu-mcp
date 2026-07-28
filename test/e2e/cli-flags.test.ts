import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #112: --version and --help must work with NO environment at all.
// main() used to call loadConfig() before looking at argv, so both flags died
// with "CCU_HOST environment variable is required" — leaving no way to ask an
// installed copy which version it is without a configured, reachable CCU.
//
// Running with a scrubbed env is the whole point of these tests: the bug was
// precisely that these paths depended on the environment.

const DIST = join(__dirname, "../../dist/index.js");
const PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf-8"),
) as { version: string };

/** Run the built CLI with an empty environment (plus the PATH node needs). */
function runBare(...args: string[]) {
  return spawnSync(process.execPath, [DIST, ...args], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf-8",
    timeout: 20_000,
  });
}

describe.skipIf(!existsSync(DIST))("CLI info flags (no environment)", () => {
  it("--version prints the package version and exits 0", () => {
    const res = runBare("--version");
    expect(res.status).toBe(0);
    expect(res.stdout.trim().split(/\s/)[0]).toBe(PKG_VERSION.version);
    expect(res.stderr).toBe("");
  });

  it("-v is accepted as the short form", () => {
    const res = runBare("-v");
    expect(res.status).toBe(0);
    expect(res.stdout.trim().split(/\s/)[0]).toBe(PKG_VERSION.version);
  });

  it("never prints a doubled dirty marker", () => {
    // `git describe --dirty` already carries the suffix; the commit fallback
    // does not. Appending unconditionally produced "...-dirty-dirty".
    expect(runBare("--version").stdout).not.toMatch(/-dirty-dirty/);
  });

  it("--help prints usage on stdout and exits 0", () => {
    const res = runBare("--help");
    expect(res.status).toBe(0);
    // stdout, not stderr, so `ccu-mcp --help | less` works.
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("Usage:");
    expect(res.stdout).toContain("--stdio");
    expect(res.stdout).toContain("CCU_HOST");
  });

  it("-h is accepted as the short form", () => {
    const res = runBare("-h");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage:");
  });

  it("neither flag trips config loading", () => {
    // The regression itself. Asserting on the error text, not on "CCU_HOST" —
    // the help output documents that variable on purpose.
    for (const flag of ["--version", "--help"]) {
      const res = runBare(flag);
      const output = `${res.stdout}${res.stderr}`;
      expect(output).not.toContain("Fatal error");
      expect(output).not.toContain("environment variable is required");
    }
  });

  it("still fails loudly without a flag and without configuration", () => {
    // The guard must not have turned a misconfigured start into a silent exit 0.
    const res = runBare();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("CCU_HOST");
  });
});
