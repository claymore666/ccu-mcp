import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { VERSION } from "../utils.js";

/** Quote a shell argument only when it needs it, so the common case stays readable. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A copy-pasteable command that runs THIS build — the one printing the hint.
 *
 * The guided setup used to print a bare `npx ccu-mcp …`, which resolves to
 * whatever npx finds in cwd or the global prefix. For anyone with an older
 * global install that is a DIFFERENT binary than the one giving the advice,
 * and the subcommand may not exist there at all: `secret`, `init` and
 * `doctor` all postdate the latest published tag, so `npx ccu-mcp secret`
 * reached a build that fell through to server startup and died with
 * "CCU_HOST environment variable is required" — a complaint about a variable
 * the user had just configured, from a file that binary never read.
 *
 * `process.argv[1]` is the entry point node actually loaded, so it always
 * names the running build. The npx form stays as a fallback for the case
 * where argv[1] is missing or no longer on disk, and is version-pinned so it
 * cannot silently resolve to something older.
 */
export function selfCommand(...args: string[]): string {
  const rendered = args.map(shellArg).join(" ");
  const entry = process.argv[1];
  if (entry && existsSync(entry)) return `node ${shellArg(entry)} ${rendered}`;
  return `npx ccu-mcp@${VERSION} ${rendered}`;
}

/**
 * Value of `--env <path>` in argv, defaulting to ./.env. Deliberately NOT
 * named `--env-file`: node's own CLI intercepts that flag even when it
 * appears after the script path and aborts when the file does not exist —
 * which is precisely the state `ccu-mcp init` starts from.
 */
export function envFileArg(argv: string[], def = ".env"): string {
  const i = argv.indexOf("--env");
  if (i !== -1) {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--env requires a path argument");
    }
    return value;
  }
  return def;
}

/** Parse a dotenv file into key/value pairs. Throws when unreadable. */
export function loadEnvFile(path: string): Record<string, string> {
  const content = readFileSync(path, "utf-8");
  return parseEnv(content) as Record<string, string>;
}

/**
 * Apply parsed env-file vars to process.env with the same precedence as
 * node's own `--env-file`: variables already present in the environment win.
 */
export function applyEnvVars(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Display form of a SHA-256 fingerprint: colon-separated uppercase pairs. */
export function displayFingerprint(fp: string): string {
  const bare = fp.replace(/:/g, "").toUpperCase();
  return bare.match(/.{1,2}/g)?.join(":") ?? bare;
}
