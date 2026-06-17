import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CHECK = join(root, "scripts/check-version-sync.mjs");
const SYNC = join(root, "scripts/sync-server-version.mjs");

const PKG = (version: string, mcpName = "io.github.x/y") =>
  JSON.stringify({ name: "y", version, mcpName });

const SERVER = (version: string, pkgVersion = version, name = "io.github.x/y") =>
  JSON.stringify({
    $schema: "https://example/server.schema.json",
    name,
    version,
    packages: [{ registryType: "npm", identifier: "y", version: pkgVersion }],
  });

describe("check-version-sync gate", () => {
  let dir: string;
  let pkgFile: string;
  let serverFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vsync-"));
    pkgFile = join(dir, "package.json");
    serverFile = join(dir, "server.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (script: string) =>
    execFileSync("node", [script], {
      env: { ...process.env, PKG_FILE: pkgFile, SERVER_FILE: serverFile },
      encoding: "utf8",
    });

  const runCheck = (): { code: number; out: string } => {
    try {
      return { code: 0, out: run(CHECK) };
    } catch (e: any) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  it("passes (exit 0) when all three versions and identity agree", () => {
    writeFileSync(pkgFile, PKG("1.3.0"));
    writeFileSync(serverFile, SERVER("1.3.0"));
    const { code, out } = runCheck();
    expect(code).toBe(0);
    expect(out).toContain("Versions in sync.");
  });

  it("fails (exit 1) when server.json root version drifts", () => {
    writeFileSync(pkgFile, PKG("1.3.0"));
    writeFileSync(serverFile, SERVER("1.2.0", "1.3.0"));
    const { code, out } = runCheck();
    expect(code).toBe(1);
    expect(out).toContain("drift");
  });

  it("fails (exit 1) when packages[].version drifts", () => {
    writeFileSync(pkgFile, PKG("1.3.0"));
    writeFileSync(serverFile, SERVER("1.3.0", "1.2.0"));
    const { code } = runCheck();
    expect(code).toBe(1);
  });

  it("fails (exit 1) when mcpName != server name", () => {
    writeFileSync(pkgFile, PKG("1.3.0", "io.github.x/wrong"));
    writeFileSync(serverFile, SERVER("1.3.0"));
    const { code } = runCheck();
    expect(code).toBe(1);
  });

  it("sync-server-version brings a drifted server.json back into sync", () => {
    writeFileSync(pkgFile, PKG("1.3.0"));
    writeFileSync(serverFile, SERVER("1.2.0", "1.2.0"));
    run(SYNC);
    const synced = JSON.parse(readFileSync(serverFile, "utf8"));
    expect(synced.version).toBe("1.3.0");
    expect(synced.packages[0].version).toBe("1.3.0");
    expect(runCheck().code).toBe(0);
  });
});

describe("live repo manifest", () => {
  it("package.json and server.json are in sync (the gate, live)", () => {
    // Belt-and-suspenders: `npm test` itself goes red if the real files drift,
    // not just the dedicated CI step.
    const code = (() => {
      try {
        execFileSync("node", [CHECK], { cwd: root, encoding: "utf8" });
        return 0;
      } catch (e: any) {
        return e.status ?? 1;
      }
    })();
    expect(code).toBe(0);
  });
});
