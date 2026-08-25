import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger.js";
import { loadConfig, envPrefix, type AppConfig } from "../config.js";
import { loadEnvFile, displayFingerprint } from "../cli/common.js";
import {
  buildEnvContent,
  mergeEnvContent,
  readEnvFile,
  writeEnvFile,
  type WizardProfile,
} from "../cli/env-writer.js";
import {
  probeApi,
  probeConfig,
  fetchCert,
  fingerprintMatches,
  testLogin,
  type CertInfo,
} from "../cli/probe.js";
import { runTool } from "../middleware/tool-handler.js";
import { structuredResult } from "../utils.js";

/**
 * Dependencies of the setup-mode toolset. Deliberately tiny: setup mode exists
 * BECAUSE there is no valid config, so none of the usual ServerDeps
 * (targets/session/resolver) can exist yet. The env-file path comes from the
 * server's own --env flag, never from a tool argument — the model must not be
 * able to point the writer at an arbitrary file.
 */
export interface SetupDeps {
  /** Absolute path of the env file named by --env. */
  envPath: string;
  /** Why loadConfig() rejected the current state, verbatim. */
  configError: string;
  logger: Logger;
}

const PROBE_TIMEOUT = 5_000;

/** True-ish dotenv boolean; garbage reads as false (status is advisory only). */
function boolVar(v: string | undefined): boolean {
  return v?.trim().toLowerCase() === "true";
}

/**
 * Read the wizard-managed profiles back OUT of a dotenv key/value map, so
 * setup_write_profile can upsert one profile while preserving the others
 * (including their already-secret-stored passwords, which never surface in
 * any tool result).
 */
export function profilesFromVars(vars: Record<string, string>): {
  profiles: WizardProfile[];
  defaultProfile?: string;
} {
  const fromKeys = (prefix: string, name: string): WizardProfile => {
    const g = (suffix: string): string | undefined => vars[`CCU_${prefix}${suffix}`];
    const https = boolVar(g("HTTPS"));
    return {
      name,
      host: g("HOST")?.trim() ?? "",
      port: /^\d+$/.test(g("PORT")?.trim() ?? "") ? Number(g("PORT")!.trim()) : https ? 443 : 80,
      https,
      tlsFingerprint: g("TLS_FINGERPRINT")?.trim() || undefined,
      user: g("USER")?.trim() || "Admin",
      password: g("PASSWORD") ?? "",
      protected: boolVar(g("PROTECTED")),
      readonly: boolVar(g("READONLY")),
    };
  };
  const names = vars.CCU_PROFILES?.split(",").map((s) => s.trim()).filter(Boolean);
  if (names && names.length > 0) {
    return {
      profiles: names.map((n) => fromKeys(`${envPrefix(n)}_`, n)),
      defaultProfile: vars.CCU_DEFAULT_PROFILE?.trim() || undefined,
    };
  }
  if (vars.CCU_HOST) return { profiles: [fromKeys("", "default")] };
  return { profiles: [] };
}

/**
 * Evaluate the env FILE with the real loadConfig(), which reads process.env.
 * Snapshot the environment, make the file the sole source of truth for every
 * variable the config owns, load, restore. Synchronous throughout (no await
 * between swap and restore), so nothing else can observe the altered env.
 */
export function configFromEnvFile(path: string): AppConfig {
  const vars = loadEnvFile(path);
  const saved: Record<string, string | undefined> = {};
  const owned = /^(CCU_|MCP_|CACHE_|RESOURCE_POLL_INTERVAL$|LOG_LEVEL$)/;
  for (const key of Object.keys(process.env)) {
    if (owned.test(key)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = saved[key] ?? process.env[key];
    process.env[key] = value;
  }
  try {
    return loadConfig();
  } finally {
    for (const key of Object.keys(vars)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const certShape = {
  fingerprint256: z.string(),
  subjectCN: z.string().optional(),
  issuerCN: z.string().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
};

function certResult(cert: CertInfo): Record<string, unknown> {
  return {
    fingerprint256: displayFingerprint(cert.fingerprint256),
    subjectCN: cert.subjectCN,
    issuerCN: cert.issuerCN,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
  };
}

function secretCommand(deps: SetupDeps, profileName: string): string {
  const profileArg = profileName === "default" ? "" : ` ${profileName}`;
  return `npx ccu-mcp secret${profileArg} --env ${deps.envPath}`;
}

function registerStatus(server: McpServer, deps: SetupDeps): void {
  server.registerTool(
    "setup_status",
    {
      title: "Setup: current state",
      description:
        "Report why the server is in setup mode, which env file it will write, and what that " +
        "file already contains: each configured CCU target with host/port/HTTPS/user, whether a " +
        "TLS fingerprint is pinned, and whether a password has been stored (as a boolean — the " +
        "password itself is never readable through any setup tool).",
      inputSchema: {},
      outputSchema: {
        envPath: z.string(),
        fileExists: z.boolean(),
        configError: z.string(),
        defaultProfile: z.string().optional(),
        profiles: z.array(
          z.object({
            name: z.string(),
            host: z.string(),
            port: z.number(),
            https: z.boolean(),
            user: z.string(),
            tlsFingerprintPinned: z.boolean(),
            passwordStored: z.boolean(),
            protected: z.boolean(),
            readonly: z.boolean(),
          }),
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async () =>
      runTool("setup_status", deps.logger, async () => {
        const content = readEnvFile(deps.envPath);
        const vars = content === undefined ? {} : loadEnvFile(deps.envPath);
        const { profiles, defaultProfile } = profilesFromVars(vars);
        return structuredResult({
          envPath: deps.envPath,
          fileExists: content !== undefined,
          configError: deps.configError,
          defaultProfile,
          profiles: profiles.map((p) => ({
            name: p.name,
            host: p.host,
            port: p.port,
            https: p.https,
            user: p.user,
            tlsFingerprintPinned: p.tlsFingerprint !== undefined,
            // Key present in the file — an empty password is legal for named
            // profiles (OpenCCU dev boxes), so presence is what matters here;
            // setup_test gives the real verdict.
            passwordStored: `CCU_${p.name === "default" && !vars.CCU_PROFILES ? "" : `${envPrefix(p.name)}_`}PASSWORD` in vars,
            protected: p.protected,
            readonly: p.readonly,
          })),
        });
      }),
  );
}

function registerProbe(server: McpServer, deps: SetupDeps): void {
  server.registerTool(
    "setup_probe",
    {
      title: "Setup: probe a CCU",
      description:
        "Check whether a CCU JSON-RPC API answers at a host. Without port/https the two stock " +
        "endpoints are tried (443 HTTPS, then 80 HTTP). Over HTTPS the presented TLS certificate " +
        "is fetched (unverified, for display) so the user can decide to pin its fingerprint in " +
        "setup_write_profile — recommend pinning.",
      inputSchema: {
        host: z.string().describe("CCU hostname or IP"),
        port: z.number().int().min(1).max(65535).optional()
          .describe("Probe exactly this port (default: auto-detect 443/80)"),
        https: z.boolean().optional().describe("Probe with HTTPS (required when port is given)"),
      },
      outputSchema: {
        reachable: z.boolean(),
        detail: z.string(),
        port: z.number().optional(),
        https: z.boolean().optional(),
        cert: z.object(certShape).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool("setup_probe", deps.logger, async (log) => {
        log({ host: args.host });
        const candidates =
          args.port !== undefined
            ? [{ port: args.port, https: args.https ?? args.port === 443 }]
            : [
                { port: 443, https: true },
                { port: 80, https: false },
              ];
        let lastDetail = "";
        for (const c of candidates) {
          const outcome = await probeApi(probeConfig(args.host, c.port, c.https, PROBE_TIMEOUT));
          lastDetail = `${c.https ? "https" : "http"}://${args.host}:${c.port} — ${outcome.detail}`;
          if (outcome.kind !== "ccu") continue;
          let cert: CertInfo | undefined;
          if (c.https) {
            try {
              cert = await fetchCert(args.host, c.port);
            } catch {
              // Reachability is established; an unreadable cert only means no
              // pin can be offered.
            }
          }
          return structuredResult({
            reachable: true,
            detail: `CCU API found on port ${c.port} (${c.https ? "HTTPS" : "HTTP"})`,
            port: c.port,
            https: c.https,
            ...(cert ? { cert: certResult(cert) } : {}),
          });
        }
        return structuredResult({ reachable: false, detail: `No CCU API found: ${lastDetail}` });
      }),
  );
}

function registerWriteProfile(server: McpServer, deps: SetupDeps): void {
  server.registerTool(
    "setup_write_profile",
    {
      title: "Setup: write a CCU target",
      description:
        "Add or update one CCU target in the env file (connection settings only). There is " +
        "deliberately NO password parameter: the password must never travel through the model " +
        "or the chat — after writing, have the user run the printed `ccu-mcp secret` command in " +
        "a terminal (hidden prompt), then call setup_test. Other targets and unmanaged variables " +
        "in the file are preserved.",
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).default("default")
          .describe('Target name (e.g. "prod", "dev"); "default" writes the flat single-CCU form'),
        host: z.string().describe("CCU hostname or IP"),
        port: z.number().int().min(1).max(65535),
        https: z.boolean(),
        tlsFingerprint: z.string().optional()
          .describe("SHA-256 fingerprint from setup_probe to pin (HTTPS only, recommended)"),
        user: z.string().default("Admin").describe("CCU username"),
        protected: z.boolean().optional()
          .describe("Write tools on this target then require confirm:true"),
        readonly: z.boolean().optional().describe("Refuse write tools on this target entirely"),
        makeDefault: z.boolean().optional().describe("Make this the startup-default target"),
      },
      outputSchema: {
        written: z.boolean(),
        envPath: z.string(),
        profiles: z.array(z.string()),
        defaultProfile: z.string(),
        nextStep: z.string(),
      },
    },
    async (args) =>
      runTool("setup_write_profile", deps.logger, async (log) => {
        // The SDK applies the zod defaults on the wire; direct handler calls
        // (unit tests) may omit them.
        const name = args.name ?? "default";
        const user = args.user ?? "Admin";
        log({ profile: name, host: args.host });
        if (!args.https && args.tlsFingerprint) {
          throw new Error("tlsFingerprint only applies over HTTPS — drop it or set https: true");
        }
        const existing = readEnvFile(deps.envPath);
        const vars = existing === undefined ? {} : loadEnvFile(deps.envPath);
        const parsed = profilesFromVars(vars);
        const profiles = parsed.profiles;
        const idx = profiles.findIndex((p) => envPrefix(p.name) === envPrefix(name));
        const previous = idx >= 0 ? profiles[idx] : undefined;
        const updated: WizardProfile = {
          name,
          host: args.host,
          port: args.port,
          https: args.https,
          tlsFingerprint: args.tlsFingerprint,
          user,
          // Same endpoint: a stored password stays valid, keep it. New or
          // moved target: never carry a secret over to a different box.
          password:
            previous && previous.host === args.host && previous.port === args.port
              ? previous.password
              : "",
          protected: args.protected ?? previous?.protected ?? false,
          readonly: args.readonly ?? previous?.readonly ?? false,
        };
        if (idx >= 0) profiles[idx] = updated;
        else profiles.push(updated);

        let defaultProfile = parsed.defaultProfile ?? profiles[0].name;
        if (args.makeDefault) defaultProfile = updated.name;
        if (!profiles.some((p) => p.name === defaultProfile)) defaultProfile = profiles[0].name;

        // A single target genuinely named "default" is the flat form (same as
        // init); any real name keeps the CCU_PROFILES form so it survives.
        const forceProfileForm = !(profiles.length === 1 && profiles[0].name === "default");
        const managed = buildEnvContent(profiles, defaultProfile, forceProfileForm);
        const content = existing === undefined ? managed : mergeEnvContent(existing, managed).content;
        writeEnvFile(deps.envPath, content);

        const nextStep = updated.password === ""
          ? `Ask the user to run this in a terminal (the password is typed there, hidden — never in this chat):\n  ${secretCommand(deps, updated.name)}\nThen call setup_test.`
          : "The stored password was kept. Call setup_test to verify the target.";
        return structuredResult({
          written: true,
          envPath: deps.envPath,
          profiles: profiles.map((p) => p.name),
          defaultProfile,
          nextStep,
        });
      }),
  );
}

function registerTest(server: McpServer, deps: SetupDeps): void {
  server.registerTool(
    "setup_test",
    {
      title: "Setup: verify the configuration",
      description:
        "Validate the env file end-to-end, like `ccu-mcp doctor`: configuration loads, each " +
        "target's CCU API is reachable, a pinned TLS fingerprint matches the presented " +
        "certificate, and the login works (reporting the ADMIN/USER privilege level). When " +
        "everything passes, tell the user to reconnect this MCP server — it will restart fully " +
        "configured with the normal tool set.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        findings: z.array(
          z.object({
            profile: z.string(),
            check: z.string(),
            ok: z.boolean(),
            detail: z.string(),
          }),
        ),
        nextStep: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      runTool("setup_test", deps.logger, async () => {
        const findings: { profile: string; check: string; ok: boolean; detail: string }[] = [];
        let config: AppConfig;
        try {
          config = configFromEnvFile(deps.envPath);
        } catch (err) {
          findings.push({
            profile: "-",
            check: "config",
            ok: false,
            detail: `configuration invalid: ${(err as Error).message}`,
          });
          return structuredResult({
            ok: false,
            findings,
            nextStep:
              "Fix the reported problem (setup_write_profile for connection settings; " +
              "`ccu-mcp secret` for the password), then call setup_test again.",
          });
        }
        findings.push({
          profile: "-",
          check: "config",
          ok: true,
          detail: `configuration loads: ${config.profiles.length} target(s), default "${config.defaultProfile}"`,
        });

        for (const p of config.profiles) {
          const outcome = await probeApi(p.ccu);
          if (outcome.kind !== "ccu") {
            findings.push({
              profile: p.name,
              check: "reachability",
              ok: false,
              detail: `CCU API not reachable: ${outcome.detail}`,
            });
            continue;
          }
          findings.push({ profile: p.name, check: "reachability", ok: true, detail: "CCU API reachable" });

          if (p.ccu.https && p.ccu.tlsFingerprint) {
            let presented: string;
            try {
              presented = (await fetchCert(p.ccu.host, p.ccu.port)).fingerprint256;
            } catch (err) {
              findings.push({
                profile: p.name,
                check: "tls-pin",
                ok: false,
                detail: `could not read the TLS certificate: ${(err as Error).message}`,
              });
              continue;
            }
            if (!fingerprintMatches(p.ccu.tlsFingerprint, presented)) {
              findings.push({
                profile: p.name,
                check: "tls-pin",
                ok: false,
                detail:
                  `pinned fingerprint does NOT match the presented certificate ` +
                  `(pinned ${displayFingerprint(p.ccu.tlsFingerprint)}, presented ${displayFingerprint(presented)}). ` +
                  "If the certificate was legitimately renewed, re-pin via setup_write_profile; " +
                  "if not, this could be an interception attempt — investigate before continuing.",
              });
              continue;
            }
            findings.push({
              profile: p.name,
              check: "tls-pin",
              ok: true,
              detail: "pinned TLS fingerprint matches the presented certificate",
            });
          }

          const login = await testLogin(p.ccu);
          if (!login.ok) {
            findings.push({
              profile: p.name,
              check: "login",
              ok: false,
              detail: `login failed: ${login.error.message}${login.error.hint ? ` — ${login.error.hint}` : ""}`,
            });
            continue;
          }
          const version = login.version ? ` (CCU ${login.version})` : "";
          const roleNote =
            login.role === "USER"
              ? " — note: script-based tools (run_script, create_system_variable, acknowledge_service_messages) need an ADMIN-level CCU user"
              : "";
          findings.push({
            profile: p.name,
            check: "login",
            ok: true,
            detail: `login OK as "${p.ccu.user}"${version} — privilege level ${login.role}${roleNote}`,
          });
        }

        const ok = findings.every((f) => f.ok);
        return structuredResult({
          ok,
          findings,
          nextStep: ok
            ? "All checks passed. Tell the user to reconnect this MCP server (restart the client " +
              "or its MCP connection) — it will start fully configured with the normal tool set."
            : "Fix the failing check (setup_write_profile for connection settings; `ccu-mcp secret` " +
              "for the password), then call setup_test again.",
        });
      }),
  );
}

export function registerSetupTools(server: McpServer, deps: SetupDeps): void {
  registerStatus(server, deps);
  registerProbe(server, deps);
  registerWriteProfile(server, deps);
  registerTest(server, deps);
}
