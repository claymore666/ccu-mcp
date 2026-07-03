import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import { withRetry } from "../middleware/retry.js";
import { VERSION, expectArray } from "../utils.js";

// CCU-backed list resources: one JSON-RPC method each; polled for change
// notifications (see poller.ts POLLABLE).
const CCU_LIST_RESOURCES = [
  { name: "devices", uri: "homematic://devices", description: "All devices with channels", method: "Device.listAllDetail" },
  { name: "rooms", uri: "homematic://rooms", description: "All rooms with channel assignments", method: "Room.getAll" },
  { name: "functions", uri: "homematic://functions", description: "All function groups", method: "Subsection.getAll" },
  { name: "programs", uri: "homematic://programs", description: "All automation programs", method: "Program.getAll" },
  { name: "sysvars", uri: "homematic://sysvars", description: "All system variables with values", method: "SysVar.getAll" },
  { name: "interfaces", uri: "homematic://interfaces", description: "Available communication interfaces", method: "Interface.listInterfaces" },
] as const;

const DEVICE_TYPES_URI = "homematic://device-types";
const SYSTEM_URI = "homematic://system";

/**
 * Every registered resource URI, DERIVED from the registrations below so the
 * subscribe validation in server.ts can't drift from what is actually served.
 */
export const RESOURCE_URIS: readonly string[] = [
  ...CCU_LIST_RESOURCES.map((r) => r.uri),
  DEVICE_TYPES_URI,
  SYSTEM_URI,
];

export function registerResources(server: McpServer, deps: ServerDeps): void {
  const { rateLimiter, logger } = deps;

  // Read deps.session / deps.deviceTypeCache per-call (they're getters for the
  // ACTIVE target) so resources follow a use_ccu() switch instead of capturing
  // the startup target at registration time.
  const ccuRead = async (method: string) => {
    await rateLimiter.acquire();
    return withRetry(() => deps.session.call(method), method, logger, { rateLimiter });
  };

  for (const r of CCU_LIST_RESOURCES) {
    server.registerResource(r.name, r.uri, { description: r.description }, async () => {
      // Guard like the sibling list_* tools: a malformed CCU/proxy result
      // (result:null) must surface as an error, not be handed to a subscriber
      // as the literal text "null" indistinguishable from an empty payload.
      const list = expectArray(await ccuRead(r.method), r.method);
      return { contents: [{ uri: r.uri, text: JSON.stringify(list, null, 2), mimeType: "application/json" }] };
    });
  }

  // The two non-polled resources: subscriptions are accepted but change
  // notifications are not emitted for them (locally-derived / near-static).
  server.registerResource("device-types", DEVICE_TYPES_URI, { description: "Cached device type schemas (not change-notified)" }, async () => ({
    contents: [{ uri: DEVICE_TYPES_URI, text: JSON.stringify(deps.deviceTypeCache.getAll(), null, 2), mimeType: "application/json" }],
  }));

  server.registerResource("system", SYSTEM_URI, { description: "CCU system info (not change-notified)" }, async () => {
    const info: Record<string, unknown> = { serverVersion: VERSION };
    for (const [key, method] of [["version", "CCU.getVersion"], ["serial", "CCU.getSerial"]] as const) {
      try { info[key] = await ccuRead(method); } catch { info[key] = null; }
    }
    return { contents: [{ uri: SYSTEM_URI, text: JSON.stringify(info, null, 2), mimeType: "application/json" }] };
  });
}
