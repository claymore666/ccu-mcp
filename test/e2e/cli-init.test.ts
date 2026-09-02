import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { DIST, distMissing } from "./_dist.js";

// The wizard subcommands run against the BUILT dist like every e2e suite:
// piped answers drive `ccu-mcp init` against a mock CCU, and `ccu-mcp doctor`
// then validates the file init wrote. This proves the whole chain — argv
// dispatch, prompting over a pipe, probing, login, env writing — not just the
// units.

function startMockCcu(): Promise<{ server: Server; port: number }> {
  const results: Record<string, unknown> = {
    "Session.login": "mock-session-id",
    "Session.logout": true,
    "Session.renew": true,
    "CCU.getVersion": "3.85.7-mock",
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let method = "";
      try {
        method = (JSON.parse(body) as { method: string }).method;
      } catch {
        // fall through
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (Object.hasOwn(results, method)) {
        res.end(JSON.stringify({ version: "2.0", result: results[method], error: null }));
      } else {
        res.end(
          JSON.stringify({
            version: "2.0",
            result: null,
            error: { name: "JSONRPCError", code: 501, message: `unknown method ${method}` },
          }),
        );
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    ),
  );
}

/** Run the built CLI with a scrubbed env and the given stdin (no mock needed). */
function runCli(args: string[], input = "") {
  return spawnSync(process.execPath, [DIST, ...args], {
    env: { PATH: process.env.PATH ?? "" },
    input,
    encoding: "utf-8",
    timeout: 60_000,
  });
}

/**
 * Async variant for tests whose child talks to the mock CCU hosted in THIS
 * process: spawnSync would block the event loop, the mock could never answer,
 * and every probe would time out.
 */
function runCliAsync(
  args: string[],
  input = "",
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST, ...args], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI run timed out\nstdout so far:\n${stdout}`));
    }, 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.end(input);
  });
}

describe.skipIf(distMissing)("CLI wizard (built dist)", () => {
  let dir: string;
  let envPath: string;
  let mock: { server: Server; port: number };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "e2e-cli-init-"));
    envPath = join(dir, ".env");
    mock = await startMockCcu();
  });

  afterAll(() => {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("--help documents the subcommands and the --env flag", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("init");
    expect(res.stdout).toContain("doctor");
    expect(res.stdout).toContain("--env");
  });

  it("init writes a working .env from piped answers", async () => {
    const answers = ["n", "127.0.0.1", "n", String(mock.port), "", "e2e-secret", ""].join("\n");
    const res = await runCliAsync(["init", "--env", envPath], answers);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("privilege level ADMIN");
    expect(res.stdout).not.toContain("e2e-secret");
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("CCU_HOST=127.0.0.1");
    expect(content).toContain("CCU_PASSWORD=e2e-secret");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("doctor passes on the file init wrote", async () => {
    const res = await runCliAsync(["doctor", "--env", envPath]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("All checks passed");
  });

  it("doctor fails on a broken configuration", () => {
    const brokenPath = join(dir, "broken.env");
    writeFileSync(brokenPath, "CCU_HOST=127.0.0.1\n"); // password missing
    const res = runCli(["doctor", "--env", brokenPath]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("configuration invalid");
  });

  it("the server itself accepts --env (file is loaded before config validation)", () => {
    // CCU_HOST comes from the file, CCU_PASSWORD is still missing — the error
    // proves the env file WAS applied (otherwise it would complain about
    // CCU_HOST first) without having to boot a whole server.
    const hostOnly = join(dir, "host-only.env");
    writeFileSync(hostOnly, "CCU_HOST=127.0.0.1\n");
    const res = runCli(["--http", "--env", hostOnly]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("CCU_PASSWORD");
    expect(res.stderr).not.toContain("CCU_HOST environment variable");
  });

  it("init without answers exits 130 and writes nothing", () => {
    const emptyPath = join(dir, "never.env");
    const res = runCli(["init", "--env", emptyPath]);
    expect(res.status).toBe(130);
    expect(() => statSync(emptyPath)).toThrow();
  });
});
