import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import type { CcuDevice } from "../ccu/types.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { toolResult, structuredResult } from "../utils.js";

export function registerDiscoveryTools(server: McpServer, deps: ServerDeps): void {
  registerListDevices(server, deps);
  registerListInterfaces(server, deps);
  registerListRooms(server, deps);
  registerListFunctions(server, deps);
  registerListPrograms(server, deps);
  registerListSystemVariables(server, deps);
  registerDescribeDeviceType(server, deps);
  registerListLinks(server, deps);
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
      outputSchema: { devices: z.array(z.unknown()) },
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
        return structuredResult({ devices: Array.isArray(output) ? output : [] }, output);
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
      outputSchema: { interfaces: z.array(z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();
      try {
        await rateLimiter.acquire();
        const result = await withRetry(() => session.call("Interface.listInterfaces"), "Interface.listInterfaces", logger);
        logger.info("tool_call", { tool: "list_interfaces", duration_ms: Date.now() - start, status: "ok" });
        return structuredResult({ interfaces: Array.isArray(result) ? result : [] }, result);
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
      outputSchema: { rooms: z.array(z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();
      try {
        await rateLimiter.acquire();
        const result = await withRetry(() => session.call("Room.getAll"), "Room.getAll", logger);
        logger.info("tool_call", { tool: "list_rooms", duration_ms: Date.now() - start, status: "ok" });
        return structuredResult({ rooms: Array.isArray(result) ? result : [] }, result);
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
      outputSchema: { functions: z.array(z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();
      try {
        await rateLimiter.acquire();
        const result = await withRetry(() => session.call("Subsection.getAll"), "Subsection.getAll", logger);
        logger.info("tool_call", { tool: "list_functions", duration_ms: Date.now() - start, status: "ok" });
        return structuredResult({ functions: Array.isArray(result) ? result : [] }, result);
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
      outputSchema: { programs: z.array(z.unknown()) },
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
        return structuredResult({ programs: Array.isArray(programs) ? programs : [] }, programs);
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
      outputSchema: { systemVariables: z.array(z.unknown()) },
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
        return structuredResult({ systemVariables: Array.isArray(sysvars) ? sysvars : [] }, sysvars);
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
      outputSchema: { deviceType: z.string().optional().describe("Echoed device type; other keys hold the channel/datapoint schema or a not-found hint") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session, rateLimiter, logger, deviceTypeCache } = deps;
      const start = Date.now();

      let cached = deviceTypeCache.get(args.deviceType);

      if (cached) {
        logger.info("tool_call", { tool: "describe_device_type", duration_ms: Date.now() - start, status: "ok", cached: true });
        return structuredResult({ deviceType: args.deviceType, ...cached });
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
              return structuredResult({ deviceType: args.deviceType, ...cached });
            }
          } catch {
            // Live query failed — fall through to cache-miss message
          }
        }
      }

      logger.info("tool_call", { tool: "describe_device_type", duration_ms: Date.now() - start, status: "ok", cached: false });
      return structuredResult({
        deviceType: args.deviceType,
        message: "Device type not in cache. Cache may still be warming. Try again shortly or call list_devices first.",
        availableTypes: Object.keys(deviceTypeCache.getAll()),
      });
    },
  );
}

function registerListLinks(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_links",
    {
      title: "List Direct Device Links",
      description:
        "List direct device links (Direktverknüpfungen) — sender→receiver channel pairings that operate " +
        "independently of the CCU (e.g. a wall switch directly driving a lamp, or thermostats linked to a " +
        "FALMOT). Read-only. Optionally filter to links involving a specific device or channel address.",
      inputSchema: {
        address: z.string().optional().describe("Device or channel address to filter by (e.g. '000A1BE9A71F15' or '000A1BE9A71F15:1')"),
      },
      outputSchema: { links: z.array(z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        // Channel address → name map; SENDER/RECEIVER from getLinks are channel addresses.
        await rateLimiter.acquire();
        const devices = await withRetry(
          () => session.call("Device.listAllDetail"),
          "Device.listAllDetail",
          logger,
        ) as CcuDevice[];
        deps.resolver.updateDeviceList(devices);
        const channelName = new Map<string, string>();
        for (const d of devices) for (const ch of d.channels) channelName.set(ch.address, ch.name);

        // Auto-iterate all interfaces (BidCos-RF, HmIP-RF, …) like the cache warmer.
        await rateLimiter.acquire();
        const interfaces = await withRetry(
          () => session.call("Interface.listInterfaces"),
          "Interface.listInterfaces",
          logger,
        ) as Array<{ name: string }>;

        // Match a channel address against the filter: exact channel, or any
        // channel of the given device address (so a device-level filter works).
        const matchesAddr = (chAddr: string): boolean => {
          if (!args.address) return true;
          return chAddr === args.address || chAddr.split(":")[0] === args.address;
        };

        const links: Array<Record<string, unknown>> = [];
        for (const iface of interfaces) {
          let raw: unknown;
          try {
            await rateLimiter.acquire();
            raw = await withRetry(
              () => session.call("Interface.getLinks", { interface: iface.name, address: args.address ?? "", flags: 0 }),
              "Interface.getLinks",
              logger,
            );
          } catch {
            continue; // interface doesn't expose getLinks
          }
          if (!Array.isArray(raw)) continue;

          for (const l of raw as Array<Record<string, unknown>>) {
            // JSON-RPC getLinks returns lowercase fields (see occu
            // .../interface/getlinks.tcl): sender, receiver, name, description, flags.
            const sender = String(l.sender ?? "");
            const receiver = String(l.receiver ?? "");
            // Re-filter client-side in case the interface ignores the address arg.
            if (!matchesAddr(sender) && !matchesAddr(receiver)) continue;
            links.push({
              sender,
              senderName: channelName.get(sender) ?? "",
              receiver,
              receiverName: channelName.get(receiver) ?? "",
              name: l.name ?? "",
              description: l.description ?? "",
              flags: l.flags ?? 0,
              interface: iface.name,
            });
          }
        }

        logger.info("tool_call", { tool: "list_links", duration_ms: Date.now() - start, status: "ok", links: links.length });
        return structuredResult({ links }, links);
      } catch (err) {
        logger.info("tool_call", { tool: "list_links", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}
