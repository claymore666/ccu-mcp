import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import type { Target } from "../ccu/target-registry.js";
import { CcuError } from "../middleware/error-mapper.js";
import { structuredResult } from "../utils.js";

export function registerTargetTools(server: McpServer, deps: ServerDeps): void {
  registerListTargets(server, deps);
  registerGetConnectionInfo(server, deps);
  registerUseCcu(server, deps);
}

// Identity view of a target — NEVER includes the password.
function targetInfo(t: Target, activeName: string) {
  return {
    name: t.profile.name,
    host: t.profile.ccu.host,
    port: t.profile.ccu.port,
    user: t.profile.ccu.user,
    https: t.profile.ccu.https,
    protected: t.profile.protected,
    readonly: t.profile.readonly,
    active: t.profile.name === activeName,
    loggedIn: t.session.isLoggedIn(),
    writesUnlocked: t.unlocked,
  };
}

function registerListTargets(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_ccu_targets",
    {
      title: "List CCU Targets",
      description:
        "List all configured CCU targets (profiles) you can switch between with use_ccu — name, host, " +
        "user, whether protected/read-only, which is active, and login state. Never exposes passwords.",
      outputSchema: {
        targets: z.array(z.unknown()).describe("Configured targets: {name, host, port, user, https, protected, readonly, active, loggedIn}"),
        active: z.string().describe("Name of the currently active target"),
      },
      // Local-only: reads in-memory config; never reaches a CCU.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const activeName = deps.targets.active.profile.name;
      const targets = deps.targets.list().map((t) => targetInfo(t, activeName));
      return structuredResult({ targets, active: activeName }, { targets, active: activeName });
    },
  );
}

function registerGetConnectionInfo(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_connection_info",
    {
      title: "Get Connection Info",
      description:
        "Report which CCU target is currently active — host, user, https, protected/read-only flags, and " +
        "login state. Use this to confirm WHERE a command will run (especially before a write). No password.",
      outputSchema: {
        name: z.string(),
        host: z.string(),
        port: z.number(),
        user: z.string(),
        https: z.boolean(),
        protected: z.boolean(),
        readonly: z.boolean(),
        active: z.boolean(),
        loggedIn: z.boolean(),
        writesUnlocked: z.boolean(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const active = deps.targets.active;
      return structuredResult(targetInfo(active, active.profile.name));
    },
  );
}

function registerUseCcu(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "use_ccu",
    {
      title: "Switch CCU Target",
      description:
        "Switch the active CCU target. All subsequent tool calls go to this target until switched again " +
        "(use the per-call `target` arg on read tools for a one-off without switching). Returns the new " +
        "active connection info. Login happens lazily on the first call.",
      inputSchema: {
        profile: z.string().describe("Target name (see list_ccu_targets)"),
      },
      outputSchema: {
        name: z.string(),
        host: z.string(),
        port: z.number(),
        user: z.string(),
        https: z.boolean(),
        protected: z.boolean(),
        readonly: z.boolean(),
        active: z.boolean(),
        loggedIn: z.boolean(),
        writesUnlocked: z.boolean(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const t = deps.targets.use(args.profile);
        deps.logger.info("ccu_target_switched", { target: t.profile.name });
        return structuredResult(targetInfo(t, t.profile.name));
      } catch (err) {
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}
