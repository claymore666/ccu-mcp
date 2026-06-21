import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt("check-windows", { description: "Check all window/door sensors and report which are open" }, async () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text:
      "Check all window and door sensors using list_devices (filter by type containing 'SWDO' or 'SCI') " +
      "and get_values. Report which are open and which are closed. Group by room if possible (use list_rooms)."
    }}],
  }));

  server.registerPrompt("room-status", {
    description: "Show current status of all devices in a room",
    argsSchema: { room: z.string().describe("Room name") },
  }, async ({ room }) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text:
      `Show the current status of all devices in the room "${room}". ` +
      `Use list_devices with room filter, then get_values to read all current values. ` +
      `Present the results organized by device with human-readable descriptions.`
    }}],
  }));

  server.registerPrompt("set-heating", {
    description: "Set heating temperature in a room",
    argsSchema: {
      room: z.string().describe("Room name"),
      temperature: z.string().describe("Target temperature in °C"),
    },
  }, async ({ room, temperature }) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text:
      `Set the heating in "${room}" to ${temperature}°C. ` +
      `Find thermostats using list_devices filtered by room. ` +
      `Use describe_device_type to confirm the correct valueKey (usually SET_POINT_TEMPERATURE). ` +
      `Then use set_value for each thermostat. Report current vs new temperature.`
    }}],
  }));

  server.registerPrompt("good-night", { description: "Prepare the house for night" }, async () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text:
      "Prepare the house for night:\n" +
      "1. Check all window/door sensors and report any that are open\n" +
      "2. Lower heating set points to night mode if applicable\n" +
      "3. Report the overall status\n" +
      "Use list_devices, get_values, list_rooms, and set_value as needed."
    }}],
  }));

  server.registerPrompt("diagnostics", { description: "Check for device issues" }, async () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text:
      "Run a diagnostic check on the HomeMatic system:\n" +
      "1. Use get_service_messages to find active issues (low battery, unreachable devices)\n" +
      "2. Use get_system_info to check firmware and cache status — it also reports the running " +
      "server's build identification (git branch/commit/tag and build time) under `build`, " +
      "useful for confirming which version is deployed\n" +
      "3. Summarize findings with recommended actions."
    }}],
  }));

  server.registerPrompt("device-info", {
    description: "Show detailed info about a device",
    argsSchema: { device: z.string().describe("Device name or address") },
  }, async ({ device }) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text:
      `Show detailed information about the device "${device}". ` +
      `Use list_devices to find it (by name or address), then describe_device_type for its capabilities, ` +
      `and get_paramset (VALUES) to show current state. Present all information clearly.`
    }}],
  }));
}
