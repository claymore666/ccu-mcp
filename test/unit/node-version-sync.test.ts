import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CHECK = join(root, "scripts/check-node-version.mjs");

const PKG = (engines = ">=24", types = "^24.1.0") =>
  JSON.stringify({ name: "y", version: "1.0.0", engines: { node: engines }, devDependencies: { "@types/node": types } });

const DOCKERFILE = (builder = 24, runtime = builder) =>
  `FROM node:${builder}-alpine AS builder\nRUN npm ci\n\nFROM node:${runtime}-alpine\nCMD ["node", "dist/index.js"]\n`;

const WORKFLOW = (version = 24) =>
  `name: CI\njobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v6\n        with:\n          node-version: "${version}"\n`;

describe("check-node-version gate", () => {
  let dir: string;
  let pkgFile: string;
  let dockerfile: string;
  let workflowDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nodever-"));
    pkgFile = join(dir, "package.json");
    dockerfile = join(dir, "Dockerfile");
    workflowDir = join(dir, "workflows");
    mkdirSync(workflowDir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runCheck = (): { code: number; out: string } => {
    try {
      const out = execFileSync("node", [CHECK], {
        env: { ...process.env, PKG_FILE: pkgFile, DOCKERFILE: dockerfile, WORKFLOW_DIR: workflowDir },
        encoding: "utf8",
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  const write = ({ pkg = PKG(), docker = DOCKERFILE(), workflow = WORKFLOW() } = {}) => {
    writeFileSync(pkgFile, pkg);
    writeFileSync(dockerfile, docker);
    writeFileSync(join(workflowDir, "ci.yml"), workflow);
  };

  it("passes (exit 0) when all four places name the same major", () => {
    write();
    const { code, out } = runCheck();
    expect(code).toBe(0);
    expect(out).toContain("Node 24 everywhere.");
  });

  // The exact failure this gate was written for: Dependabot bumping the base
  // image alone (#169), with every other check still green.
  it("fails (exit 1) when the base image is ahead of engines", () => {
    write({ docker: DOCKERFILE(26) });
    const { code, out } = runCheck();
    expect(code).toBe(1);
    expect(out).toContain("Node version drift");
  });

  it("fails (exit 1) when only one build stage moved", () => {
    write({ docker: DOCKERFILE(26, 24) });
    expect(runCheck().code).toBe(1);
  });

  it("fails (exit 1) when a workflow runs a different major than the image", () => {
    write({ workflow: WORKFLOW(26) });
    expect(runCheck().code).toBe(1);
  });

  it("fails (exit 1) when @types/node is a major ahead of the supported Node", () => {
    write({ pkg: PKG(">=24", "^26.1.0") });
    const { code, out } = runCheck();
    expect(code).toBe(1);
    expect(out).toContain("@types/node");
  });

  // A gate that silently checks nothing is worse than no gate: it reports
  // success for a file it never found.
  it("fails (exit 1) when the Dockerfile has no FROM node: line", () => {
    write({ docker: "FROM alpine:3.20\nCMD [\"true\"]\n" });
    const { code, out } = runCheck();
    expect(code).toBe(1);
    expect(out).toContain("nothing to check");
  });

  it("fails (exit 1) when no workflow declares a node-version", () => {
    write({ workflow: "name: CI\njobs:\n  build:\n    steps:\n      - run: true\n" });
    const { code, out } = runCheck();
    expect(code).toBe(1);
    expect(out).toContain("nothing to check");
  });

  it("accepts an unquoted node-version, as YAML allows", () => {
    write({ workflow: "name: CI\njobs:\n  build:\n    steps:\n      - with:\n          node-version: 24\n" });
    expect(runCheck().code).toBe(0);
  });
});

describe("live repo", () => {
  it("Dockerfile, workflows, engines and @types/node all name one Node major", () => {
    // Belt-and-suspenders, as with the version-sync gate: `npm test` goes red
    // on real drift, not only the dedicated CI step.
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
