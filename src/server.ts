import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import type { SessionManager } from "./ccu/session.js";
import type { RateLimiter } from "./middleware/rate-limiter.js";
import type { Logger } from "./logger.js";
import type { DeviceTypeCache } from "./cache/device-type-cache.js";
import type { Resolver } from "./middleware/resolver.js";
import type { TargetRegistry, TargetSelection } from "./ccu/target-registry.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerReadTools } from "./tools/read.js";
import { registerControlTools } from "./tools/control.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerTargetTools } from "./tools/targets.js";
import { registerResources, RESOURCE_URIS } from "./resources/registry.js";
import { registerPrompts } from "./prompts/registry.js";
import { VERSION } from "./utils.js";

export interface ServerDeps {
  config: AppConfig;
  /** All configured CCU targets (shared across MCP sessions). */
  targets: TargetRegistry;
  /**
   * THIS MCP session's active-target pointer + protected-target unlocks.
   * One per McpServer instance so concurrent HTTP clients can't retarget or
   * de-gate each other.
   */
  selection: TargetSelection;
  /**
   * The session-active target's session/resolver/device-type cache. These are
   * getters (see index.ts / _helpers.ts) that resolve to `selection.active.*`
   * on each access, so a use_ccu() switch is picked up by the next tool call
   * without touching any tool that reads `deps.session` etc.
   */
  readonly session: SessionManager;
  readonly resolver: Resolver;
  readonly deviceTypeCache: DeviceTypeCache;
  rateLimiter: RateLimiter;
  logger: Logger;
}

/**
 * Per-server resource subscriptions (URIs a client subscribed to via
 * resources/subscribe). The poller consults this to send
 * notifications/resources/updated only where they were asked for. WeakMap so
 * an evicted/closed server's entry is collectable with the server itself.
 */
export const serverSubscriptions = new WeakMap<McpServer, Set<string>>();

/**
 * The server's `Implementation` identity, shared between the configured server
 * and the setup-mode server (setup-server.ts) so a client listing either shows
 * the same name/title. `description` mirrors server.json's, so the registry
 * entry and the live handshake say the same thing.
 */
export const SERVER_IDENTITY = {
  name: "ccu-mcp",
  // title/description/websiteUrl are the human-facing half of
  // `Implementation`: a client listing servers shows these rather than the
  // package name.
  title: "HomeMatic CCU",
  description: "MCP server for controlling HomeMatic smart home devices via the CCU JSON-RPC API",
  websiteUrl: "https://github.com/claymore666/ccu-mcp",
  version: VERSION,
};

/**
 * Sent to the client in the `initialize` result and, in most clients, put in
 * front of the model before it calls anything. It is the one piece of guidance
 * that arrives without the model choosing to ask for it — `help` only helps a
 * client that decides to call it — so it carries the two things that change
 * whether a first call succeeds: names are resolved for you, and writes to a
 * protected CCU need `confirm: true`.
 */
const INSTRUCTIONS = `Controls a HomeMatic CCU (debmatic, CCU3 or OpenCCU) over its JSON-RPC API.

Start with list_devices / list_rooms to discover what exists; addresses look like \
"000EDBE9A1B4F4:1" (device:channel). Most tools accept a device or channel NAME as \
well as an address and resolve it for you, so there is no need to look an address up \
first unless the name is ambiguous.

Reads (get_*, list_*) are always safe. Writes (set_*, put_paramset, execute_program, \
create/delete system variable, assign/unassign channel, run_script) reach real \
hardware — heating, locks, sockets. A CCU configured as protected refuses them unless \
called with confirm: true, and run_script plus delete_system_variable require it on \
every single call.

Call help for the full tool list, the argument conventions and worked examples. With \
several CCUs configured, list_ccu_targets shows them, get_connection_info reports the \
active one, use_ccu switches it, and read tools take an optional target for a \
single-call read elsewhere.`;

/**
 * `new McpError(code, msg)` builds its `message` as "MCP error <code>: <msg>",
 * and that whole string is what goes on the wire — where the client prefixes it
 * a second time, so the user reads
 * "MCP error -32602: MCP error -32602: Unknown resource…". Reset `message` to
 * the bare text after construction: `code` still travels in the JSON-RPC error
 * object, so nothing is lost and the client renders one prefix.
 */
function invalidParams(message: string): McpError {
  const err = new McpError(ErrorCode.InvalidParams, message);
  err.message = message;
  return err;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    SERVER_IDENTITY,
    {
      instructions: INSTRUCTIONS,
      capabilities: {
        tools: {},
        // subscribe is backed by the handlers registered below; the poller
        // sends notifications/resources/updated for changed URIs to
        // subscribers (list_changed would be wrong — the list is static).
        resources: { listChanged: true, subscribe: true },
        prompts: {},
        logging: {},
      },
    },
  );

  registerDiscoveryTools(server, deps);
  registerReadTools(server, deps);
  registerControlTools(server, deps);
  registerDiagnosticsTools(server, deps);
  registerMetaTools(server, deps);
  registerTargetTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);

  // resources/subscribe support: the SDK's McpServer registers no handler for
  // it, so back the advertised capability ourselves.
  const subscriptions = new Set<string>();
  serverSubscriptions.set(server, subscriptions);
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    // Reject unknown URIs: silently accepting a typo would leave the client
    // waiting forever for notifications that can never come.
    if (!RESOURCE_URIS.includes(req.params.uri)) {
      throw invalidParams(
        `Unknown resource: ${req.params.uri}. Valid URIs: ${RESOURCE_URIS.join(", ")}`,
      );
    }
    subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscriptions.delete(req.params.uri);
    return {};
  });

  return server;
}
