import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import type { CcuDevice } from "../ccu/types.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { toolResult, parseValue, escapeHmScript } from "../utils.js";

// Short-lived name→type cache (#9), shared so create/delete can invalidate it
// and a freshly created/removed variable is reflected on the next set.
interface SysVarTypeCacheHolder {
  entry: { ts: number; types: Map<string, string> } | null;
}

export function registerControlTools(server: McpServer, deps: ServerDeps): void {
  const sysVarTypeCache: SysVarTypeCacheHolder = { entry: null };
  registerSetValue(server, deps);
  registerPutParamset(server, deps);
  registerSetSystemVariable(server, deps, sysVarTypeCache);
  registerCreateSystemVariable(server, deps, sysVarTypeCache);
  registerDeleteSystemVariable(server, deps, sysVarTypeCache);
  registerExecuteProgram(server, deps);
  registerAssignChannel(server, deps, "add");
  registerAssignChannel(server, deps, "remove");
}

function registerSetValue(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "set_value",
    {
      title: "Set Value",
      description:
        "Set a single datapoint value on a device channel. " +
        "Only address, valueKey, and value are required — interface and type are auto-resolved. " +
        "Returns the previous value for undo. Use describe_device_type to find valid valueKeys and ranges.",
      inputSchema: {
        address: z.string().describe("Channel address (e.g. '000A1BE9A71F15:1')"),
        valueKey: z.string().describe("Datapoint name (e.g. 'STATE', 'LEVEL', 'SET_POINT_TEMPERATURE')"),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to set"),
        interface: z.string().optional().describe("Interface name override (auto-resolved if omitted)"),
        type: z.enum(["bool", "int", "double", "string"]).optional().describe("Value type override (auto-resolved if omitted)"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { session, rateLimiter, logger, deviceTypeCache } = deps;
      const start = Date.now();

      try {
        const iface = args.interface ?? await deps.resolver.resolveInterface(args.address, session, rateLimiter, logger);
        const valueType = args.type ?? deps.resolver.resolveType(args.address, args.valueKey, deviceTypeCache) ?? inferType(args.value);

        // Read previous value (best-effort)
        let previousValue: unknown = null;
        try {
          await rateLimiter.acquire();
          previousValue = await session.call("Interface.getValue", {
            interface: iface,
            address: args.address,
            valueKey: args.valueKey,
          });
        } catch {
          // Pre-read failed — continue with write
        }

        // Write new value
        await rateLimiter.acquire();
        await withRetry(
          () => session.call("Interface.setValue", {
            interface: iface,
            address: args.address,
            valueKey: args.valueKey,
            type: valueType,
            value: args.value,
          }),
          "Interface.setValue",
          logger,
        );

        logger.info("tool_call", { tool: "set_value", duration_ms: Date.now() - start, status: "ok", address: args.address });
        return toolResult({
          address: args.address,
          valueKey: args.valueKey,
          previousValue: parseValue(previousValue),
          newValue: args.value,
          interface: iface,
          type: valueType,
        });
      } catch (err) {
        logger.info("tool_call", { tool: "set_value", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerPutParamset(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "put_paramset",
    {
      title: "Put Paramset",
      description:
        "Write multiple parameters at once (e.g. thermostat weekly profile). " +
        "Interface is auto-resolved from address.",
      inputSchema: {
        address: z.string().describe("Channel address"),
        paramsetKey: z.enum(["VALUES", "MASTER"]).describe("Paramset to write"),
        set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .describe("Key-value pairs to write (e.g. {TEMPERATURE_WINDOW_OPEN: 5.0})"),
        interface: z.string().optional().describe("Interface name override"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { session, rateLimiter, logger, deviceTypeCache } = deps;
      const start = Date.now();

      try {
        const iface = args.interface ?? await deps.resolver.resolveInterface(args.address, session, rateLimiter, logger);

        // CCU expects set as array of {name, type, value} objects
        const paramArray = Object.entries(args.set).map(([name, value]) => {
          // Try to resolve type from device type cache
          let type = deps.resolver.resolveType(args.address, name, deviceTypeCache);
          if (!type) type = inferType(value);
          return { name, type, value: String(value) };
        });

        await rateLimiter.acquire();
        await withRetry(
          () => session.call("Interface.putParamset", {
            interface: iface,
            address: args.address,
            paramsetKey: args.paramsetKey,
            set: paramArray,
          }),
          "Interface.putParamset",
          logger,
        );

        logger.info("tool_call", { tool: "put_paramset", duration_ms: Date.now() - start, status: "ok" });
        return toolResult({ address: args.address, paramsetKey: args.paramsetKey, written: args.set });
      } catch (err) {
        logger.info("tool_call", { tool: "put_paramset", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

const SYSVAR_TYPE_TTL_MS = 30_000;

function registerSetSystemVariable(server: McpServer, deps: ServerDeps, typeCacheHolder: SysVarTypeCacheHolder): void {
  // Short-lived name→type cache (shared via the holder): avoids fetching the
  // full sysvar list on every write. create/delete clear it so new/removed
  // variables are reflected immediately.

  server.registerTool(
    "set_system_variable",
    {
      title: "Set System Variable",
      description:
        "Set a system variable value. Type is auto-detected — use list_system_variables to see available variables.",
      inputSchema: {
        name: z.string().describe("Variable name (exact match)"),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to set"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        // Look up variable type (cached) to choose correct setter
        let method: string;
        let sysVarType: string | undefined;
        if (typeCacheHolder.entry && Date.now() - typeCacheHolder.entry.ts < SYSVAR_TYPE_TTL_MS) {
          sysVarType = typeCacheHolder.entry.types.get(args.name);
        }
        if (sysVarType === undefined) {
          await rateLimiter.acquire();
          const allVars = await withRetry(
            () => session.call("SysVar.getAll"),
            "SysVar.getAll",
            logger,
          ) as Array<{ name: string; type: string }>;
          typeCacheHolder.entry = { ts: Date.now(), types: new Map(allVars.map((v) => [v.name, v.type])) };
          sysVarType = typeCacheHolder.entry.types.get(args.name);
        }

        if (sysVarType !== undefined) {
          const varType = sysVarType.toUpperCase();
          if (varType.includes("BOOL") || varType.includes("ALARM")) {
            method = "SysVar.setBool";
          } else if (varType.includes("FLOAT") || varType.includes("NUMBER") || varType.includes("INTEGER")) {
            method = "SysVar.setFloat";
          } else if (varType.includes("ENUM") || varType.includes("LIST")) {
            method = "SysVar.setFloat"; // Enums use numeric index
          } else if (varType.includes("STRING")) {
            // String variables: use ReGa.runScript as there's no SysVar.setString API
            await rateLimiter.acquire();
            const escapedName = escapeHmScript(String(args.name));
            const escapedValue = escapeHmScript(String(args.value));
            await withRetry(
              () => session.call("ReGa.runScript", {
                script: `var sv = dom.GetObject("${escapedName}"); if (sv) { sv.State("${escapedValue}"); }`,
              }, deps.config.ccu.scriptTimeout),
              "ReGa.runScript",
              logger,
            );
            logger.info("tool_call", { tool: "set_system_variable", duration_ms: Date.now() - start, status: "ok" });
            return toolResult({ name: args.name, value: args.value, method: "ReGa.runScript (string)" });
          } else {
            logger.warn("sysvar_unknown_type", { name: args.name, type: sysVarType });
            throw new CcuError({
              error: "INVALID_INPUT",
              code: 0,
              message: `System variable "${args.name}" has unsupported type: ${sysVarType}`,
              hint: "Supported types are bool/alarm, float/integer, enum/list, and string.",
            });
          }
        } else {
          logger.warn("sysvar_not_found", { name: args.name });
          throw new CcuError({
            error: "NOT_FOUND",
            code: 0,
            message: `System variable not found: ${args.name}`,
            hint: "Call list_system_variables to see available variables (name must match exactly).",
          });
        }

        await rateLimiter.acquire();
        await withRetry(
          () => session.call(method, { name: args.name, value: args.value }),
          method,
          logger,
        );

        logger.info("tool_call", { tool: "set_system_variable", duration_ms: Date.now() - start, status: "ok" });
        return toolResult({ name: args.name, value: args.value, method });
      } catch (err) {
        logger.info("tool_call", { tool: "set_system_variable", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerCreateSystemVariable(server: McpServer, deps: ServerDeps, typeCacheHolder: SysVarTypeCacheHolder): void {
  server.registerTool(
    "create_system_variable",
    {
      title: "Create System Variable",
      description:
        "Create a new system variable. Types: 'bool', 'float' (optional min/max/unit), " +
        "'enum' (requires values list), 'string'. Use set_system_variable to write it afterwards, " +
        "list_system_variables to see existing ones.",
      inputSchema: {
        name: z.string().describe("New variable name (must not already exist)"),
        type: z.enum(["bool", "float", "enum", "string"]).describe("Variable type"),
        description: z.string().optional().describe("Human-readable description shown in the WebUI"),
        unit: z.string().optional().describe("Unit label (float only, e.g. '°C')"),
        min: z.number().optional().describe("Minimum value (float only)"),
        max: z.number().optional().describe("Maximum value (float only)"),
        values: z.array(z.string()).optional().describe("Enum value labels in order (enum only, e.g. ['off','low','high'])"),
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
        if (args.type === "enum" && (!args.values || args.values.length === 0)) {
          throw new CcuError({
            error: "INVALID_INPUT",
            code: 0,
            message: "An enum system variable requires a non-empty 'values' list.",
            hint: "Pass values, e.g. [\"off\", \"low\", \"high\"].",
          });
        }

        // Reject duplicates up front (creating over an existing name corrupts it).
        await rateLimiter.acquire();
        const existing = await withRetry(
          () => session.call("SysVar.getAll"),
          "SysVar.getAll",
          logger,
        ) as Array<{ name: string }>;
        if (existing.some((v) => v.name === args.name)) {
          throw new CcuError({
            error: "INVALID_INPUT",
            code: 0,
            message: `System variable already exists: ${args.name}`,
            hint: "Pick a unique name, or use set_system_variable to change the existing one.",
          });
        }

        // Create via ReGa (no SysVar.createString exists, and this keeps all four
        // types on one code path). Modeled exactly on the CCU's own JSON-RPC
        // method scripts (occu WebUI/www/api/methods/sysvar/create*.tcl): set
        // ValueType + type-specifics, then oSysVars.Add(sv.ID()) LAST. We add
        // ValueUnit (float) and DPInfo (description), which those methods don't
        // expose as parameters. There is no createString method, hence ReGa.
        const name = escapeHmScript(args.name);
        const info = escapeHmScript(args.description ?? "");
        let typeSetup: string;
        switch (args.type) {
          case "bool":
            typeSetup =
              'sv.ValueType(ivtBinary);\n' +
              'sv.ValueSubType(istBool);\n' +
              'sv.ValueName0("false");\n' +
              'sv.ValueName1("true");\n' +
              'sv.State(false);';
            break;
          case "float": {
            const unit = escapeHmScript(args.unit ?? "");
            const min = Number.isFinite(args.min) ? args.min : 0;
            const max = Number.isFinite(args.max) ? args.max : 100;
            typeSetup =
              'sv.ValueType(ivtFloat);\n' +
              `sv.ValueMin(${min});\n` +
              `sv.ValueMax(${max});\n` +
              `sv.ValueUnit("${unit}");\n` +
              'sv.State(0);';
            break;
          }
          case "enum": {
            const list = escapeHmScript((args.values ?? []).join(";"));
            typeSetup =
              'sv.ValueType(ivtInteger);\n' +
              'sv.ValueSubType(istEnum);\n' +
              `sv.ValueList("${list}");\n` +
              'sv.State(0);';
            break;
          }
          case "string":
          default:
            typeSetup =
              'sv.ValueType(ivtString);\n' +
              'sv.State("");';
            break;
        }

        const script =
          `object oSysVars = dom.GetObject(ID_SYSTEM_VARIABLES);\n` +
          `object sv = dom.CreateObject(OT_VARDP);\n` +
          `sv.Name("${name}");\n` +
          `${typeSetup}\n` +
          `sv.DPInfo("${info}");\n` +
          `sv.Internal(false);\n` +
          `oSysVars.Add(sv.ID());`;

        await rateLimiter.acquire();
        await withRetry(
          () => session.call("ReGa.runScript", { script }, deps.config.ccu.scriptTimeout),
          "ReGa.runScript",
          logger,
        );

        typeCacheHolder.entry = null; // new variable must be visible to the next set
        logger.info("tool_call", { tool: "create_system_variable", duration_ms: Date.now() - start, status: "ok", type: args.type });
        return toolResult({ name: args.name, type: args.type, created: true });
      } catch (err) {
        logger.info("tool_call", { tool: "create_system_variable", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerDeleteSystemVariable(server: McpServer, deps: ServerDeps, typeCacheHolder: SysVarTypeCacheHolder): void {
  server.registerTool(
    "delete_system_variable",
    {
      title: "Delete System Variable",
      description: "Delete a system variable by name. Use list_system_variables to see existing names.",
      inputSchema: {
        name: z.string().describe("Variable name (exact match)"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        // Validate existence so an unknown name is a clean NOT_FOUND rather than
        // a silent no-op (deleteSysVarByName doesn't report a missing name).
        await rateLimiter.acquire();
        const existing = await withRetry(
          () => session.call("SysVar.getAll"),
          "SysVar.getAll",
          logger,
        ) as Array<{ name: string }>;
        if (!existing.some((v) => v.name === args.name)) {
          throw new CcuError({
            error: "NOT_FOUND",
            code: 0,
            message: `System variable not found: ${args.name}`,
            hint: "Call list_system_variables to see available variables (name must match exactly).",
          });
        }

        await rateLimiter.acquire();
        await withRetry(
          () => session.call("SysVar.deleteSysVarByName", { name: args.name }),
          "SysVar.deleteSysVarByName",
          logger,
        );

        typeCacheHolder.entry = null; // removed variable must not linger in the cache
        logger.info("tool_call", { tool: "delete_system_variable", duration_ms: Date.now() - start, status: "ok" });
        return toolResult({ name: args.name, deleted: true });
      } catch (err) {
        logger.info("tool_call", { tool: "delete_system_variable", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerAssignChannel(server: McpServer, deps: ServerDeps, mode: "add" | "remove"): void {
  const toolName = mode === "add" ? "assign_channel" : "unassign_channel";
  const verb = mode === "add" ? "Assign" : "Remove";
  const prep = mode === "add" ? "to" : "from";

  server.registerTool(
    toolName,
    {
      title: `${verb} Channel ${mode === "add" ? "to" : "from"} Room/Function`,
      description:
        `${verb} a channel ${prep} a room and/or a function group. Identify the channel by address ` +
        "and the room/function by name (use list_rooms / list_functions to see names). " +
        "At least one of room or function is required.",
      inputSchema: {
        channel: z.string().describe("Channel address (e.g. '000A1BE9A71F15:1')"),
        room: z.string().optional().describe("Room name (exact match)"),
        function: z.string().optional().describe("Function group name (exact match)"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        if (!args.room && !args.function) {
          throw new CcuError({
            error: "INVALID_INPUT",
            code: 0,
            message: "Provide a room and/or a function to assign the channel to.",
            hint: "Pass room and/or function by name (see list_rooms / list_functions).",
          });
        }

        // Resolve the channel address → channel ID (the membership APIs take IDs).
        await rateLimiter.acquire();
        const devices = await withRetry(
          () => session.call("Device.listAllDetail"),
          "Device.listAllDetail",
          logger,
        ) as CcuDevice[];
        deps.resolver.updateDeviceList(devices);
        let channelId: string | undefined;
        for (const d of devices) {
          const ch = d.channels.find((c) => c.address === args.channel);
          if (ch) { channelId = ch.id; break; }
        }
        if (!channelId) {
          throw new CcuError({
            error: "NOT_FOUND",
            code: 0,
            message: `Channel not found: ${args.channel}`,
            hint: "Call list_devices to find valid channel addresses.",
          });
        }

        const applied: Array<{ kind: "room" | "function"; name: string }> = [];

        if (args.room) {
          await rateLimiter.acquire();
          const rooms = await withRetry(
            () => session.call("Room.getAll"),
            "Room.getAll",
            logger,
          ) as Array<{ id: string; name: string }>;
          const room = rooms.find((r) => r.name === args.room);
          if (!room) {
            throw new CcuError({
              error: "NOT_FOUND",
              code: 0,
              message: `Room not found: ${args.room}`,
              hint: `Valid rooms: ${rooms.map((r) => r.name).join(", ")}`,
            });
          }
          await rateLimiter.acquire();
          await withRetry(
            () => session.call(mode === "add" ? "Room.addChannel" : "Room.removeChannel", { id: room.id, channelId }),
            "Room.modifyChannel",
            logger,
          );
          applied.push({ kind: "room", name: room.name });
        }

        if (args.function) {
          await rateLimiter.acquire();
          const functions = await withRetry(
            () => session.call("Subsection.getAll"),
            "Subsection.getAll",
            logger,
          ) as Array<{ id: string; name: string }>;
          const fn = functions.find((f) => f.name === args.function);
          if (!fn) {
            throw new CcuError({
              error: "NOT_FOUND",
              code: 0,
              message: `Function not found: ${args.function}`,
              hint: `Valid functions: ${functions.map((f) => f.name).join(", ")}`,
            });
          }
          await rateLimiter.acquire();
          await withRetry(
            () => session.call(mode === "add" ? "Subsection.addChannel" : "Subsection.removeChannel", { id: fn.id, channelId }),
            "Subsection.modifyChannel",
            logger,
          );
          applied.push({ kind: "function", name: fn.name });
        }

        logger.info("tool_call", { tool: toolName, duration_ms: Date.now() - start, status: "ok" });
        return toolResult({
          channel: args.channel,
          [mode === "add" ? "assignedTo" : "removedFrom"]: applied,
        });
      } catch (err) {
        logger.info("tool_call", { tool: toolName, duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerExecuteProgram(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "execute_program",
    {
      title: "Execute Program",
      description:
        "Trigger an automation program on the CCU. NOT idempotent — will not be auto-retried. " +
        "Use list_programs to find program IDs.",
      inputSchema: {
        id: z.string().describe("Program ID. Get from list_programs."),
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
        // The CCU's Program.execute reports success even for nonexistent IDs
        // (issue #18) — validate against the program list first.
        await rateLimiter.acquire();
        const programs = await withRetry(
          () => session.call("Program.getAll"),
          "Program.getAll",
          logger,
        ) as Array<{ id: string; name: string }>;

        const program = programs.find((p) => String(p.id) === args.id);
        if (!program) {
          throw new CcuError({
            error: "NOT_FOUND",
            code: 0,
            message: `Program not found: ${args.id}`,
            hint: "Call list_programs to see available programs and their IDs.",
          });
        }

        await rateLimiter.acquire();
        // No retry — Program.execute is not idempotent
        await session.call("Program.execute", { id: args.id });

        logger.info("tool_call", { tool: "execute_program", duration_ms: Date.now() - start, status: "ok" });
        return toolResult({ id: args.id, name: program.name, executed: true });
      } catch (err) {
        logger.info("tool_call", { tool: "execute_program", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

export function inferType(value: unknown): string {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  return "string";
}
