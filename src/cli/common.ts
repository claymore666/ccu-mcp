import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

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
