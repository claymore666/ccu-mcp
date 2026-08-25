import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { envPrefix } from "../config.js";

/** What the wizard collects per CCU target. */
export interface WizardProfile {
  name: string;
  host: string;
  port: number;
  https: boolean;
  tlsFingerprint?: string;
  user: string;
  password: string;
  protected: boolean;
  readonly: boolean;
}

// The connection-defining keys the wizard owns inside the .env file — flat,
// profile-scoped (ANY prefix, so a removed profile's leftovers don't linger and
// break the next load), plus the profile roster itself. Everything else in the
// file (MCP_*, LOG_LEVEL, rate limits, timeouts) belongs to the operator and
// survives a rewrite — same contract as the auth-token persistence.
const MANAGED_SUFFIXES = "HOST|PORT|HTTPS|USER|PASSWORD|TLS_FINGERPRINT|TLS_VERIFY|CA_CERT|PROTECTED|READONLY";
export const MANAGED_KEY_RE = new RegExp(
  `^CCU_(PROFILES|DEFAULT_PROFILE|(${MANAGED_SUFFIXES})|[A-Z0-9_]+_(${MANAGED_SUFFIXES}))=`,
);

/**
 * Quote a value if the dotenv format needs it. Node's env-file parser (and
 * util.parseEnv, which doctor uses to read the file back) treats an unquoted
 * `#` as a comment start and trims whitespace — and it does NOT process
 * escape sequences inside quotes, so the only way to represent a value is to
 * pick a quote character (", ', or `) that the value itself doesn't contain.
 */
export function quoteEnvValue(value: string): string {
  if (value !== "" && !/[\s#"'`]/.test(value)) return value;
  for (const q of ['"', "'", "`"]) {
    if (!value.includes(q)) return `${q}${value}${q}`;
  }
  throw new Error(
    'value contains all three quote characters (", \' and `) and cannot be stored in a dotenv file',
  );
}

/** Render the managed block: flat vars for one target, CCU_PROFILES for more. */
export function buildEnvContent(profiles: WizardProfile[], defaultProfile: string): string {
  const lines: string[] = [
    "# Written by `ccu-mcp init` — https://github.com/claymore666/ccu-mcp#configuration",
  ];
  const emit = (prefix: string, p: WizardProfile): void => {
    lines.push(`CCU_${prefix}HOST=${quoteEnvValue(p.host)}`);
    lines.push(`CCU_${prefix}PORT=${p.port}`);
    lines.push(`CCU_${prefix}HTTPS=${p.https}`);
    lines.push(`CCU_${prefix}USER=${quoteEnvValue(p.user)}`);
    lines.push(`CCU_${prefix}PASSWORD=${quoteEnvValue(p.password)}`);
    if (p.tlsFingerprint) lines.push(`CCU_${prefix}TLS_FINGERPRINT=${p.tlsFingerprint}`);
    if (p.protected) lines.push(`CCU_${prefix}PROTECTED=true`);
    if (p.readonly) lines.push(`CCU_${prefix}READONLY=true`);
  };
  if (profiles.length === 1) {
    emit("", profiles[0]);
  } else {
    lines.push(`CCU_PROFILES=${profiles.map((p) => p.name).join(",")}`);
    lines.push(`CCU_DEFAULT_PROFILE=${defaultProfile}`);
    for (const p of profiles) {
      lines.push("");
      lines.push(`# --- target: ${p.name} ---`);
      emit(`${envPrefix(p.name)}_`, p);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Merge the managed block into an existing file's content: managed keys are
 * replaced, everything else (operator vars, comments) is preserved verbatim.
 * Returns the keys that were replaced so the wizard can ask before clobbering.
 */
export function mergeEnvContent(existing: string, managed: string): { content: string; replaced: string[] } {
  const foreign: string[] = [];
  const replaced: string[] = [];
  for (const line of existing.split(/\r?\n/)) {
    if (MANAGED_KEY_RE.test(line)) {
      replaced.push(line.slice(0, line.indexOf("=")));
      continue;
    }
    if (line.trim() === "") continue;
    foreign.push(line);
  }
  const content = managed + (foreign.length > 0 ? "\n" + foreign.join("\n") + "\n" : "");
  return { content, replaced };
}

/** Replace (or append) one KEY=value line in existing file content. */
export function replaceEnvKey(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  let done = false;
  const out = lines.map((line) => {
    if (!done && line.startsWith(`${key}=`)) {
      done = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!done) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`, "");
  }
  return out.join("\n");
}

/** Read an existing env file; undefined when it doesn't exist. */
export function readEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Write mode 0600 via tmp+rename: the file holds the CCU password. */
export function writeEnvFile(path: string, content: string): void {
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, path);
}
