import { resolve } from "node:path";
import { Prompter, type PromptIo } from "./prompt.js";
import { envFileArg, applyEnvVars, loadEnvFile, displayFingerprint } from "./common.js";
import { readEnvFile, replaceEnvKey, writeEnvFile } from "./env-writer.js";
import { probeApi, fetchCert, fingerprintMatches, testLogin } from "./probe.js";
import { loadConfig, envPrefix } from "../config.js";
import type { CcuProfile } from "../ccu/types.js";

interface Report {
  say: (text: string) => void;
  failures: number;
}

function pass(r: Report, text: string): void {
  r.say(`  ✓ ${text}`);
}

function fail(r: Report, text: string): void {
  r.failures++;
  r.say(`  ✗ ${text}`);
}

/** The env key holding this profile's pin, for the refresh offer. */
function fingerprintKey(p: CcuProfile): string {
  return p.isFlat ? "CCU_TLS_FINGERPRINT" : `CCU_${envPrefix(p.name)}_TLS_FINGERPRINT`;
}

/** Returns false when the login test can't succeed anyway (pin mismatch / cert unreadable). */
async function checkPin(
  r: Report,
  p: CcuProfile,
  envPath: string,
  ui: Prompter | undefined,
): Promise<boolean> {
  if (!p.ccu.https) return true;
  if (!p.ccu.tlsFingerprint) {
    r.say("  - no TLS fingerprint pinned (connection is encrypted but unverified)");
    return true;
  }
  let presented: string;
  try {
    presented = (await fetchCert(p.ccu.host, p.ccu.port)).fingerprint256;
  } catch (err) {
    fail(r, `could not read the TLS certificate: ${(err as Error).message}`);
    return false;
  }
  if (fingerprintMatches(p.ccu.tlsFingerprint, presented)) {
    pass(r, "pinned TLS fingerprint matches the presented certificate");
    return true;
  }
  fail(r, "pinned TLS fingerprint does NOT match the presented certificate");
  r.say(`      pinned:    ${displayFingerprint(p.ccu.tlsFingerprint)}`);
  r.say(`      presented: ${displayFingerprint(presented)}`);
  r.say("      If the CCU's certificate was legitimately renewed, refresh the pin;");
  r.say("      if not, this could be an interception attempt — investigate first.");
  if (ui && (await ui.askYesNo(`    Update ${fingerprintKey(p)} in ${envPath} to the presented one?`, false))) {
    const existing = readEnvFile(envPath);
    if (existing === undefined) {
      r.say(`    Could not re-read ${envPath} — pin left unchanged.`);
      return false;
    }
    writeEnvFile(envPath, replaceEnvKey(existing, fingerprintKey(p), presented));
    r.say("    Pin updated. Re-run doctor to verify.");
  }
  return false;
}

async function checkProfile(r: Report, p: CcuProfile, envPath: string, ui: Prompter | undefined): Promise<void> {
  r.say(`Target "${p.name}" — ${p.ccu.host}:${p.ccu.port} (${p.ccu.https ? "HTTPS" : "HTTP"})`);
  const outcome = await probeApi(p.ccu);
  if (outcome.kind !== "ccu") {
    fail(r, `CCU API not reachable: ${outcome.detail}`);
    return;
  }
  pass(r, "CCU API reachable");
  if (!(await checkPin(r, p, envPath, ui))) {
    r.say("  - skipping the login test until the certificate check passes");
    return;
  }
  const login = await testLogin(p.ccu);
  if (!login.ok) {
    fail(r, `login failed: ${login.error.message}`);
    if (login.error.hint) r.say(`      ${login.error.hint}`);
    return;
  }
  const version = login.version ? ` (CCU ${login.version})` : "";
  pass(r, `login OK as "${p.ccu.user}"${version} — privilege level ${login.role}`);
  if (login.role === "USER") {
    r.say("      Note: script-based tools (run_script, create_system_variable,");
    r.say("      acknowledge_service_messages) need an ADMIN-level CCU user.");
  }
}

/** Entry point for `ccu-mcp doctor`. Returns the process exit code. */
export async function run(argv: string[], io?: PromptIo): Promise<number> {
  const out = io?.output ?? process.stdout;
  const r: Report = { say: (text) => out.write(text + "\n"), failures: 0 };
  let envPath: string;
  try {
    envPath = envFileArg(argv);
    r.say(`ccu-mcp doctor — checking ${resolve(envPath)}`);
    applyEnvVars(loadEnvFile(envPath));
  } catch (err) {
    r.say(`  ✗ ${(err as Error).message}`);
    return 1;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    r.say(`  ✗ configuration invalid: ${(err as Error).message}`);
    r.say("    (See README → Configuration errors for what each message means.)");
    return 1;
  }
  r.say(
    `  ✓ configuration loads: ${config.profiles.length} target(s), default "${config.defaultProfile}"`,
  );

  // The interactive pin-refresh offer needs someone at a terminal; with piped
  // stdin (CI, scripts) doctor only reports. Tests opt in by stamping
  // isTTY=true on their injected input stream.
  const input = io?.input ?? process.stdin;
  const ui =
    input.isTTY === true ? new Prompter(io ?? { input: process.stdin, output: process.stdout }) : undefined;
  try {
    for (const p of config.profiles) {
      r.say("");
      await checkProfile(r, p, envPath, ui);
    }
  } finally {
    ui?.close();
  }

  r.say("");
  if (r.failures > 0) {
    r.say(`${r.failures} check(s) failed.`);
    return 1;
  }
  r.say("All checks passed.");
  return 0;
}
