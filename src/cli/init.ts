import { resolve } from "node:path";
import { Prompter, type PromptIo } from "./prompt.js";
import { envFileArg, displayFingerprint } from "./common.js";
import {
  buildEnvContent,
  mergeEnvContent,
  readEnvFile,
  writeEnvFile,
  type WizardProfile,
} from "./env-writer.js";
import { probeApi, probeConfig, fetchCert, testLogin, type CertInfo } from "./probe.js";
import { envPrefix } from "../config.js";
import type { CcuConfig } from "../ccu/types.js";

const DETECT_TIMEOUT = 3_000;

interface Detected {
  port: number;
  https: boolean;
}

/** Try the two stock CCU ports to pre-fill defaults. Never asks anything. */
async function detectEndpoint(host: string): Promise<Detected | undefined> {
  for (const candidate of [
    { port: 443, https: true },
    { port: 80, https: false },
  ]) {
    const outcome = await probeApi(probeConfig(host, candidate.port, candidate.https, DETECT_TIMEOUT));
    if (outcome.kind === "ccu") return candidate;
  }
  return undefined;
}

function toCcuConfig(p: WizardProfile): CcuConfig {
  return {
    host: p.host,
    port: p.port,
    https: p.https,
    tlsVerify: false,
    tlsFingerprint: p.tlsFingerprint,
    user: p.user,
    password: p.password,
    timeout: 10_000,
    scriptTimeout: 30_000,
  };
}

function describeCert(cert: CertInfo): string[] {
  const lines: string[] = [];
  if (cert.subjectCN) lines.push(`  Subject: ${cert.subjectCN}`);
  if (cert.issuerCN) lines.push(`  Issuer:  ${cert.issuerCN}`);
  if (cert.validFrom && cert.validTo) lines.push(`  Valid:   ${cert.validFrom} — ${cert.validTo}`);
  lines.push(`  SHA-256: ${displayFingerprint(cert.fingerprint256)}`);
  return lines;
}

/** Host/port/HTTPS for one target, looping until reachable or accepted as-is. */
async function askEndpoint(ui: Prompter): Promise<{ host: string; port: number; https: boolean }> {
  for (;;) {
    const host = await ui.ask("CCU hostname or IP", {
      validate: (v) => (v === "" ? "A hostname or IP is required." : null),
    });
    ui.say(`Probing ${host} ...`);
    const detected = await detectEndpoint(host);
    if (detected) {
      ui.say(`  Found the CCU API on port ${detected.port} (${detected.https ? "HTTPS" : "HTTP"}).`);
    } else {
      ui.say("  No CCU API on the standard ports (443/80) — enter the port manually.");
    }
    const https = await ui.askYesNo("Use HTTPS?", detected ? detected.https : true);
    const port = Number(
      await ui.ask("Port", {
        def: detected && detected.https === https ? String(detected.port) : https ? "443" : "80",
        validate: (v) =>
          /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : "Port must be 1-65535.",
      }),
    );
    if (detected && detected.port === port && detected.https === https) {
      return { host, port, https };
    }
    const outcome = await probeApi(probeConfig(host, port, https, DETECT_TIMEOUT));
    if (outcome.kind === "ccu") {
      ui.say("  CCU API found.");
      return { host, port, https };
    }
    ui.say(`  No CCU API there: ${outcome.detail}`);
    if (await ui.askYesNo("Continue with these settings anyway?", false)) {
      return { host, port, https };
    }
  }
}

/** Credentials + test-login loop for one target. Returns null on abort. */
async function askCredentials(
  ui: Prompter,
  base: Omit<WizardProfile, "user" | "password">,
): Promise<{ user: string; password: string } | null> {
  for (;;) {
    const user = await ui.ask("CCU user", { def: "Admin" });
    const password = await ui.askHidden("CCU password (input hidden)");
    ui.say("Testing login ...");
    const result = await testLogin(toCcuConfig({ ...base, user, password }));
    if (result.ok) {
      const version = result.version ? ` (CCU ${result.version})` : "";
      if (result.role === "ADMIN") {
        ui.say(`  Login OK${version} — privilege level ADMIN: all tools available.`);
      } else if (result.role === "USER") {
        ui.say(`  Login OK${version} — privilege level USER.`);
        ui.say(
          "  Note: script-based tools (run_script, create_system_variable, " +
            "acknowledge_service_messages) need an ADMIN-level CCU user and will fail for this one.",
        );
      } else {
        ui.say(`  Login OK${version} — privilege level could not be determined.`);
      }
      return { user, password };
    }
    ui.say(`  Login failed: ${result.error.message}`);
    if (result.error.hint) ui.say(`  ${result.error.hint}`);
    if (await ui.askYesNo("Re-enter user/password?", true)) continue;
    if (await ui.askYesNo("Save this target with untested credentials anyway?", false)) {
      return { user, password };
    }
    return null;
  }
}

async function runWizard(ui: Prompter, envPath: string): Promise<number> {
  ui.say("ccu-mcp setup — probes your CCU, pins its TLS certificate, tests the");
  ui.say(`login, and writes the result to ${envPath}.`);
  ui.say("");

  const multi = await ui.askYesNo("Set up multiple CCU targets (e.g. prod/dev)?", false);
  const profiles: WizardProfile[] = [];

  for (;;) {
    let name = "default";
    if (multi) {
      name = await ui.ask("Profile name", {
        def: profiles.length === 0 ? "prod" : undefined,
        validate: (v) => {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) {
            return "Use letters, digits, dot, dash or underscore.";
          }
          if (profiles.some((p) => envPrefix(p.name) === envPrefix(v))) {
            return `Collides with already-configured "${profiles.find((p) => envPrefix(p.name) === envPrefix(v))?.name}".`;
          }
          return null;
        },
      });
    }

    const endpoint = await askEndpoint(ui);

    let tlsFingerprint: string | undefined;
    if (endpoint.https) {
      try {
        const cert = await fetchCert(endpoint.host, endpoint.port);
        ui.say("The CCU presents this TLS certificate:");
        for (const line of describeCert(cert)) ui.say(line);
        if (await ui.askYesNo("Pin this certificate's fingerprint (recommended)?", true)) {
          tlsFingerprint = cert.fingerprint256;
        } else {
          ui.say("  Not pinned — the connection will be encrypted but UNVERIFIED (MITM-exposed).");
        }
      } catch (err) {
        ui.say(`  Could not read the certificate: ${(err as Error).message}`);
        ui.say("  Continuing without a pin — the connection will be unverified.");
      }
    }

    const base: Omit<WizardProfile, "user" | "password"> = {
      name,
      host: endpoint.host,
      port: endpoint.port,
      https: endpoint.https,
      tlsFingerprint,
      protected: false,
      readonly: false,
    };
    const creds = await askCredentials(ui, base);
    if (creds === null) {
      ui.say("Aborted — nothing written.");
      return 1;
    }

    let prot = false;
    let ro = false;
    if (multi) {
      prot = await ui.askYesNo("Protect this target (write tools then require confirm:true)?", false);
      ro = await ui.askYesNo("Make this target read-only (write tools refused entirely)?", false);
    }
    profiles.push({ ...base, ...creds, protected: prot, readonly: ro });

    if (!multi || !(await ui.askYesNo("Add another CCU target?", false))) break;
  }

  let defaultProfile = profiles[0].name;
  if (profiles.length > 1) {
    const names = profiles.map((p) => p.name);
    defaultProfile = await ui.askChoice("Default target", names, names[0]);
  }

  const managed = buildEnvContent(profiles, defaultProfile);
  const existing = readEnvFile(envPath);
  let content = managed;
  if (existing !== undefined) {
    const merged = mergeEnvContent(existing, managed);
    if (merged.replaced.length > 0) {
      ui.say(`${envPath} already configures a CCU (${[...new Set(merged.replaced)].join(", ")}).`);
      if (!(await ui.askYesNo("Replace those settings? Everything else in the file is kept.", true))) {
        ui.say("Nothing written.");
        return 1;
      }
    }
    content = merged.content;
  }
  writeEnvFile(envPath, content);
  const absPath = resolve(envPath);
  ui.say("");
  ui.say(`Wrote ${absPath} (mode 0600).`);

  ui.say("");
  ui.say("Add the server to an MCP client — .mcp.json (Claude Code) or");
  ui.say("claude_desktop_config.json (Claude Desktop):");
  ui.say("");
  ui.say(
    JSON.stringify(
      {
        mcpServers: {
          "ccu-mcp": { command: "npx", args: ["ccu-mcp", "--stdio", "--env", absPath] },
        },
      },
      null,
      2,
    ),
  );
  ui.say("");
  ui.say("Or via the Claude Code CLI:");
  ui.say(`  claude mcp add ccu-mcp -- npx ccu-mcp --stdio --env ${absPath}`);
  ui.say("");
  ui.say(`Re-check this configuration anytime with: ccu-mcp doctor --env ${absPath}`);
  return 0;
}

/** Entry point for `ccu-mcp init`. Returns the process exit code. */
export async function run(argv: string[], io?: PromptIo): Promise<number> {
  const envPath = envFileArg(argv);
  const ui = new Prompter(io ?? { input: process.stdin, output: process.stdout });
  try {
    return await runWizard(ui, envPath);
  } catch (err) {
    if ((err as Error).message === "input closed") {
      process.stderr.write("ccu-mcp init: input closed — nothing written.\n");
      return 130;
    }
    process.stderr.write(`ccu-mcp init: ${(err as Error).message}\n`);
    return 1;
  } finally {
    ui.close();
  }
}
