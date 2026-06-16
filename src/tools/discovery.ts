import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import type { CcuDevice } from "../ccu/types.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { toolResult } from "../utils.js";

export function registerDiscoveryTools(server: McpServer, deps: ServerDeps): void {
  registerListDevices(server, deps);
  registerListInterfaces(server, deps);
  registerListRooms(server, deps);
  registerListFunctions(server, deps);
  registerListPrograms(server, deps);
  registerListSystemVariables(server, deps);
  registerDescribeDeviceType(server, deps);
}

function registerListDevices(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_devices",
    {
      title: "List Devices",
      description:
        "List all devices with their channels, types, and addresses. " +
        "Optional filters: room, function, type, name. " +
        "Use this first to discover device addresses for get_value/set_value.",
      inputSchema: {
        room: z.string().optional().describe("Filter by room name (exact match)"),
        function: z.string().optional().describe("Filter by function group name (exact match)"),
        type: z.string().optional().describe("Filter by device type (exact match, e.g. 'HmIP-eTRV-2')"),
        name: z.string().optional().describe("Filter by device/channel name (substring, case-insensitive)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        await rateLimiter.acquire();
        const result = await withRetry(
          () => session.call("Device.listAllDetail"),
          "Device.listAllDetail",
          logger,
        );

        let devices = result as CcuDevice[];

        // Update resolver's device list
        deps.resolver.updateDeviceList(devices);

        if (args.room || args.function) {
          const channelIds = new Set<string>();

          if (args.room) {
            await rateLimiter.acquire();
            const rooms = await withRetry(
              () => session.call("Room.getAll"),
              "Room.getAll",
              logger,
            ) as Array<{ id: string; name: string; channelIds: string[] }>;
            const room = rooms.find((r) => r.name === args.room);
            if (room) for (const id of room.channelIds) channelIds.add(id);
          }

          if (args.function) {
            await rateLimiter.acquire();
            const functions = await withRetry(
              () => session.call("Subsection.getAll"),
              "Subsection.getAll",
              logger,
            ) as Array<{ id: string; name: string; channelIds: string[] }>;
            const func = functions.find((f) => f.name === args.function);
            if (func) for (const id of func.channelIds) channelIds.add(id);
          }

          devices = channelIds.size > 0
            ? devices.filter((d) => d.channels.some((ch) => channelIds.has(ch.id)))
            : [];
        }

        if (args.type) devices = devices.filter((d) => d.type === args.type);

        if (args.name) {
          const needle = args.name.toLowerCase();
          devices = devices.filter(
            (d) =>
              d.name.toLowerCase().includes(needle) ||
              d.channels.some((ch) => ch.name.toLowerCase().includes(needle)),
          );
        }

        const hasFilter = args.room || args.function || args.type || args.name;

        // Compact format when unfiltered (summary only), full details when filtered
        // Hide 50-channel virtual receivers (HM-RCV-50, HmIP-RCV-50) in compact mode
        const HIDDEN_TYPES = new Set(["HM-RCV-50", "HmIP-RCV-50"]);
        const output = hasFilter
          ? devices
          : devices
            .filter((d) => !HIDDEN_TYPES.has(d.type))
            .map((d) => ({
              id: d.id,
              name: d.name,
              address: d.address,
              interface: d.interface,
              type: d.type,
              channelCount: d.channels.length,
              channels: d.channels.map((ch) => ({
                address: ch.address,
                name: ch.name,
                index: ch.index,
                channelType: ch.channelType,
              })),
            }));

        logger.info("tool_call", { tool: "list_devices", duration_ms: Date.now() - start, status: "ok", deviceCount: devices.length });
        return toolResult(output);
      } catch (err) {
        logger.info("tool_call", { tool: "list_devices", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerListInterfaces(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_interfaces",
    {
      title: "List Interfaces",
      description: "List available communication interfaces (BidCos-RF, HmIP-RF, VirtualDevices, etc.).",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();
      try {
        await rateLimiter.acquire();
        const result = await withRetry(() => session.call("Interface.listInterfaces"), "Interface.listInterfaces", logger);
        logger.info("tool_call", { tool: "list_interfaces", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(result);
      } catch (err) {
        logger.info("tool_call", { tool: "list_interfaces", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerListRooms(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_rooms",
    {
      title: "List Rooms",
      description: "List all rooms with their assigned channel IDs. Use with list_devices to find devices by room.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();
      try {
        await rateLimiter.acquire();
        const result = await withRetry(() => session.call("Room.getAll"), "Room.getAll", logger);
        logger.info("tool_call", { tool: "list_rooms", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(result);
      } catch (err) {
        logger.info("tool_call", { tool: "list_rooms", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerListFunctions(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_functions",
    {
      title: "List Functions",
      description: "List all function groups (Heating, Lighting, etc.) with their assigned channel IDs.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();
      try {
        await rateLimiter.acquire();
        const result = await withRetry(() => session.call("Subsection.getAll"), "Subsection.getAll", logger);
        logger.info("tool_call", { tool: "list_functions", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(result);
      } catch (err) {
        logger.info("tool_call", { tool: "list_functions", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerListPrograms(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_programs",
    {
      title: "List Programs",
      description: "List all automation programs. Use execute_program to trigger them.",
      inputSchema: {
        name: z.string().optional().describe("Filter by program name (substring, case-insensitive)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();
      try {
        await rateLimiter.acquire();
        let programs = await withRetry(() => session.call("Program.getAll"), "Program.getAll", logger) as Array<{ name: string }>;

        if (args.name) {
          const needle = args.name.toLowerCase();
          programs = programs.filter((p) => p.name.toLowerCase().includes(needle));
        }

        logger.info("tool_call", { tool: "list_programs", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(programs);
      } catch (err) {
        logger.info("tool_call", { tool: "list_programs", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerListSystemVariables(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_system_variables",
    {
      title: "List System Variables",
      description: "List all system variables with current values and metadata. Use set_system_variable to modify them.",
      inputSchema: {
        name: z.string().optional().describe("Filter by variable name (substring, case-insensitive)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();
      try {
        await rateLimiter.acquire();
        let sysvars = await withRetry(() => session.call("SysVar.getAll"), "SysVar.getAll", logger) as Array<{ name: string }>;

        if (args.name) {
          const needle = args.name.toLowerCase();
          sysvars = sysvars.filter((v) => v.name.toLowerCase().includes(needle));
        }

        logger.info("tool_call", { tool: "list_system_variables", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(sysvars);
      } catch (err) {
        logger.info("tool_call", { tool: "list_system_variables", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerDescribeDeviceType(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "describe_device_type",
    {
      title: "Describe Device Type",
      description:
        "Get the full channel/datapoint schema for a device type (e.g. 'HmIP-eTRV-2'). " +
        "Shows all channels, paramsets, datapoint names, types, ranges, and operations. " +
        "Served from cache (instant). Use list_devices first to find device types.",
      inputSchema: {
        deviceType: z.string().describe("Device type name (e.g. 'HmIP-eTRV-2', 'HmIP-SWDO-I'). Get from list_devices."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session, rateLimiter, logger, deviceTypeCache } = deps;
      const start = Date.now();

      let cached = deviceTypeCache.get(args.deviceType);

      if (cached) {
        logger.info("tool_call", { tool: "describe_device_type", duration_ms: Date.now() - start, status: "ok", cached: true });
        return toolResult({ deviceType: args.deviceType, ...cached });
      }

      // Cache miss — try live query if we can find a device instance
      const devices = deps.resolver.getDeviceList();
      if (devices) {
        const device = devices.find((d) => d.type === args.deviceType);
        if (device) {
          try {
            cached = await deviceTypeCache.queryAndCache(
              args.deviceType, device.address, device.interface,
              device.channels.map((ch) => ch.address),
              session, rateLimiter,
            );
            if (cached) {
              logger.info("tool_call", { tool: "describe_device_type", duration_ms: Date.now() - start, status: "ok", cached: false });
              return toolResult({ deviceType: args.deviceType, ...cached });
            }
          } catch {
            // Live query failed — fall through to cache-miss message
          }
        }
      }

      logger.info("tool_call", { tool: "describe_device_type", duration_ms: Date.now() - start, status: "ok", cached: false });
      return toolResult({
        deviceType: args.deviceType,
        message: "Device type not in cache. Cache may still be warming. Try again shortly or call list_devices first.",
        availableTypes: Object.keys(deviceTypeCache.getAll()),
      });
    },
  );
}
