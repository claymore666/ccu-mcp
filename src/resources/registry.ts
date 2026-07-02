import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import { withRetry } from "../middleware/retry.js";
import { VERSION } from "../utils.js";

export function registerResources(server: McpServer, deps: ServerDeps): void {
  const { rateLimiter, logger } = deps;

  // Read deps.session / deps.deviceTypeCache per-call (they're getters for the
  // ACTIVE target) so resources follow a use_ccu() switch instead of capturing
  // the startup target at registration time.
  const ccuRead = async (method: string) => {
    await rateLimiter.acquire();
    return withRetry(() => deps.session.call(method), method, logger);
  };

  server.registerResource("devices", "homematic://devices", { description: "All devices with channels" }, async () => ({
    contents: [{ uri: "homematic://devices", text: JSON.stringify(await ccuRead("Device.listAllDetail"), null, 2), mimeType: "application/json" }],
  }));

  server.registerResource("rooms", "homematic://rooms", { description: "All rooms with channel assignments" }, async () => ({
    contents: [{ uri: "homematic://rooms", text: JSON.stringify(await ccuRead("Room.getAll"), null, 2), mimeType: "application/json" }],
  }));

  server.registerResource("functions", "homematic://functions", { description: "All function groups" }, async () => ({
    contents: [{ uri: "homematic://functions", text: JSON.stringify(await ccuRead("Subsection.getAll"), null, 2), mimeType: "application/json" }],
  }));

  server.registerResource("programs", "homematic://programs", { description: "All automation programs" }, async () => ({
    contents: [{ uri: "homematic://programs", text: JSON.stringify(await ccuRead("Program.getAll"), null, 2), mimeType: "application/json" }],
  }));

  server.registerResource("sysvars", "homematic://sysvars", { description: "All system variables with values" }, async () => ({
    contents: [{ uri: "homematic://sysvars", text: JSON.stringify(await ccuRead("SysVar.getAll"), null, 2), mimeType: "application/json" }],
  }));

  server.registerResource("interfaces", "homematic://interfaces", { description: "Available communication interfaces" }, async () => ({
    contents: [{ uri: "homematic://interfaces", text: JSON.stringify(await ccuRead("Interface.listInterfaces"), null, 2), mimeType: "application/json" }],
  }));

  server.registerResource("device-types", "homematic://device-types", { description: "Cached device type schemas" }, async () => ({
    contents: [{ uri: "homematic://device-types", text: JSON.stringify(deps.deviceTypeCache.getAll(), null, 2), mimeType: "application/json" }],
  }));

  server.registerResource("system", "homematic://system", { description: "CCU system info" }, async () => {
    const info: Record<string, unknown> = { serverVersion: VERSION };
    for (const [key, method] of [["version", "CCU.getVersion"], ["serial", "CCU.getSerial"]] as const) {
      try { info[key] = await ccuRead(method); } catch { info[key] = null; }
    }
    return { contents: [{ uri: "homematic://system", text: JSON.stringify(info, null, 2), mimeType: "application/json" }] };
  });
}
