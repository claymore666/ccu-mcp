import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import { CcuError } from "../middleware/error-mapper.js";
import { toolResult } from "../utils.js";

export function registerMetaTools(server: McpServer, deps: ServerDeps): void {
  registerHelp(server, deps);
  registerRunScript(server, deps);
}

const CONCEPTUAL_GUIDE = `# HomeMatic via ccu-mcp

## Object Hierarchy
CCU → Interfaces → Devices → Channels → Datapoints (paramsets)

## Interfaces
- **BidCos-RF** — Classic HomeMatic radio (868 MHz)
- **HmIP-RF** — HomeMatic IP radio
- **VirtualDevices** — Virtual/internal devices (e.g. heating groups)

## Addressing
- Devices have a serial address: \`000A1BE9A71F15\`
- Channels append \`:N\`: \`000A1BE9A71F15:1\`
- Channel 0 is usually MAINTENANCE (battery, signal, reachability)
- Channel 1+ are functional channels (switch, thermostat, sensor)

## Paramsets
- **VALUES** — Runtime state (temperature, switch state, valve position)
- **MASTER** — Device configuration (reporting interval, display settings)
- **LINK** — Direct peering configuration

## Typical Workflow
1. \`list_devices\` → find device types and channel addresses
2. \`describe_device_type\` → learn datapoints, types, ranges (from cache)
3. \`get_value\` / \`get_values\` / \`get_paramset\` → read current state
4. \`set_value\` / \`put_paramset\` → change state (returns previous value)

## Tips
- Use \`list_devices\` with room/function filters to reduce output
- Use \`get_values\` with room filter instead of multiple \`get_value\` calls
- \`set_value\` only needs address + valueKey + value (interface and type are auto-resolved)
- System variables are independent of devices — use \`list_system_variables\` / \`set_system_variable\`
- Programs are CCU-side automations — use \`list_programs\` / \`execute_program\`
- \`run_script\` executes arbitrary HomeMatic Script for anything tools don't cover

## Available Tools
**Discovery:** list_devices, list_interfaces, list_rooms, list_functions, list_programs, list_system_variables, list_links, describe_device_type
**Read:** get_value, get_values, get_paramset
**Control:** set_value, put_paramset, set_system_variable, create_system_variable, delete_system_variable, assign_channel, unassign_channel, execute_program
**Diagnostics:** get_service_messages, acknowledge_service_messages, get_rssi, get_system_info
**Meta:** help, run_script
`;

const TOOL_HELP: Record<string, string> = {
  list_devices: `List all devices with channels, types, and addresses.
Args: room? (string), function? (string), type? (string), name? (string)
Returns compact summary when unfiltered (address, name, type, channel names only).
Returns full details (all channel properties) when any filter is applied.
Related: describe_device_type, get_value`,

  list_interfaces: `List available communication interfaces.
Args: none
Returns: Array of {name, port, info}`,

  list_rooms: `List all rooms with assigned channel IDs.
Args: none
Returns: Array of rooms`,

  list_functions: `List all function groups with assigned channel IDs.
Args: none
Returns: Array of function groups`,

  list_programs: `List automation programs.
Args: name? (substring filter)
Returns: Array of programs with id, name, active state`,

  list_system_variables: `List system variables with current values.
Args: name? (substring filter)
Returns: Array of variables with id, name, value, type, min, max`,

  describe_device_type: `Get channel/datapoint schema for a device type (from cache).
Args: deviceType (string, e.g. "HmIP-eTRV-2")
Returns: Channels with paramsets, datapoint types, ranges, operations`,

  list_links: `List direct device links (Direktverknüpfungen) — sender→receiver channel pairings that work without the CCU.
Args: address? (device or channel address filter, e.g. "000A1BE9A71F15" or "000A1BE9A71F15:1")
Returns: Array of {sender, senderName, receiver, receiverName, name, description, flags, interface}
Read-only; answers "what directly controls this?". Link creation/removal is out of scope.`,

  get_value: `Read a single datapoint value.
Args: address (string), valueKey (string), interface? (auto-resolved)
Returns: {address, valueKey, value}
Idempotent: yes`,

  get_values: `Bulk read datapoints for multiple channels.
Args: channels? (string[]), room? (string), function? (string)
Returns: Array of {address, name, datapoints}
Idempotent: yes`,

  get_paramset: `Read all parameters for a channel.
Args: address (string), paramsetKey ("VALUES"|"MASTER"|"LINK"), interface? (auto-resolved)
Returns: {address, paramsetKey, params}
Idempotent: yes`,

  set_value: `Set a single datapoint value. Returns previous value for undo.
Args: address (string), valueKey (string), value (string|number|boolean), interface? (auto), type? (auto)
Returns: {previousValue, newValue, address, valueKey}
Idempotent: yes`,

  put_paramset: `Write multiple parameters at once.
Args: address (string), paramsetKey ("VALUES"|"MASTER"), set (object with key:value pairs, e.g. {"TEMPERATURE_WINDOW_OPEN": 5.0}), interface? (auto)
The set object uses simple key:value format — types are auto-resolved from the device type cache. Values are converted to strings internally.
Returns: {address, paramsetKey, written}
Idempotent: yes`,

  set_system_variable: `Set a system variable (type auto-detected).
Args: name (string), value (string|number|boolean)
Returns: {name, value, method}
Idempotent: yes`,

  create_system_variable: `Create a new system variable.
Args: name (string), type ("bool"|"float"|"enum"|"string"), description? (string),
  unit?/min?/max? (float only), values? (string[], required for enum)
Returns: {name, type, created: true}
INVALID_INPUT if the name already exists (or enum without values). Use set_system_variable to write it.`,

  delete_system_variable: `Delete a system variable by name.
Args: name (string, exact match)
Returns: {name, deleted: true}
NOT_FOUND if the name doesn't exist.`,

  assign_channel: `Assign a channel to a room and/or function group.
Args: channel (address), room? (name), function? (name) — at least one of room/function
Returns: {channel, assignedTo: [{kind, name}]}
NOT_FOUND (with valid names) for unknown channel/room/function.`,

  unassign_channel: `Remove a channel from a room and/or function group.
Args: channel (address), room? (name), function? (name) — at least one of room/function
Returns: {channel, removedFrom: [{kind, name}]}
NOT_FOUND (with valid names) for unknown channel/room/function.`,

  execute_program: `Trigger an automation program. NOT idempotent — never auto-retried.
Args: id (string)
Returns: {id, executed}`,

  get_service_messages: `Get active service messages (low battery, unreachable, etc.).
Args: none
Returns: Array of {id, name, address, channelName, timestamp}`,

  acknowledge_service_messages: `Confirm/dismiss active service messages (e.g. clear a low-battery warning).
Args: id (single alarm id from get_service_messages) OR address (all active messages on a channel) — at least one required
Returns: {confirmed: Array of {id, type, address}, count}
NOT_FOUND if no active message matches; the warning reappears if its condition persists.`,

  get_system_info: `Get CCU system info: firmware, serial, addresses, cache status.
Args: none
Returns: {version, serial, address, hmipAddress, cacheTypes, cacheWarming}`,

  get_rssi: `Radio link quality (RSSI, dBm) per device, plus BidCos interface health.
Args: name (optional substring filter on device name/address)
Returns: {devices: [{address, name, interface, links: [{peer, peerName, rssiDevice, rssiPeer}]}], interfaces}
rssiDevice/rssiPeer are dBm (higher = better); null means no measurement. Use to diagnose flaky devices.`,

  run_script: `Execute arbitrary HomeMatic Script. NOT idempotent — never auto-retried.
Args: script (string)
Returns: Script output`,

  help: `Context-aware help. No args = guide, tool name = tool docs, device type = schema.
Args: topic? (string)`,
};

function registerHelp(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "help",
    {
      title: "Help",
      description:
        "Context-aware help. No args: conceptual guide. " +
        "Tool name (e.g. 'set_value'): tool usage. " +
        "Device type (e.g. 'HmIP-eTRV-2'): capabilities from cache.",
      inputSchema: {
        topic: z.string().optional().describe("Tool name, device type, or omit for general guide"),
      },
      // Local-only: serves the static guide and the device-type cache; never reaches the CCU.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (!args.topic) {
        return toolResult(CONCEPTUAL_GUIDE);
      }

      // Check if it's a tool name
      if (args.topic in TOOL_HELP) {
        return toolResult(`# ${args.topic}\n\n${TOOL_HELP[args.topic]}`);
      }

      // Check if it's a device type in cache
      const cached = deps.deviceTypeCache.get(args.topic);
      if (cached) {
        return toolResult({ deviceType: args.topic, ...cached });
      }

      // Unknown topic
      const availableTools = Object.keys(TOOL_HELP).join(", ");
      const availableTypes = Object.keys(deps.deviceTypeCache.getAll()).join(", ");
      return toolResult(
        `Unknown topic: "${args.topic}"\n\nAvailable tools: ${availableTools}\nCached device types: ${availableTypes || "(cache still warming)"}`,
      );
    },
  );
}

function registerRunScript(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "run_script",
    {
      title: "Run HomeMatic Script",
      description:
        "Execute arbitrary HomeMatic Script on the CCU. " +
        "NOT idempotent — will not be auto-retried. " +
        "Use for anything the other tools don't cover.",
      inputSchema: {
        script: z.string().describe("HomeMatic Script to execute"),
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        await rateLimiter.acquire();
        // No retry — scripts are not idempotent
        const result = await session.call("ReGa.runScript", { script: args.script }, deps.config.ccu.scriptTimeout);

        logger.info("tool_call", { tool: "run_script", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(result);
      } catch (err) {
        logger.info("tool_call", { tool: "run_script", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}
