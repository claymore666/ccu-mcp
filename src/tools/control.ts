import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import type { CcuDevice } from "../ccu/types.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { runTool } from "../middleware/tool-handler.js";
import { assertWritable } from "../ccu/target-registry.js";
import { toolResult, parseValue, escapeHmScript } from "../utils.js";

// Optional `confirm` field for write tools: required (true) to authorize a write
// against a `protected` CCU target (e.g. prod). Harmless on unprotected targets.
const confirmField = z.boolean().optional()
  .describe("Set true to authorize this write against a protected CCU target (e.g. prod). Unlocks writes to that target for the rest of the session.");

export function registerControlTools(server: McpServer, deps: ServerDeps): void {
  registerSetValue(server, deps);
  registerPutParamset(server, deps);
  registerSetSystemVariable(server, deps);
  registerCreateSystemVariable(server, deps);
  registerDeleteSystemVariable(server, deps);
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
        confirm: confirmField,
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => runTool("set_value", deps.logger, async (log) => {
      const { session, rateLimiter, logger, deviceTypeCache } = deps;
      assertWritable(deps.selection, deps.selection.active, args.confirm);
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

      // Write new value. An ACTION datapoint (PRESS_SHORT, STOP, ...) is a
      // one-shot trigger: a timed-out request may still have been delivered,
      // so auto-retry could fire it twice — send those exactly once.
      const rawParamType = deps.resolver.resolveRawParamType(args.address, args.valueKey, deviceTypeCache);
      const doSetValue = () => session.call("Interface.setValue", {
        interface: iface,
        address: args.address,
        valueKey: args.valueKey,
        type: valueType,
        value: args.value,
      });
      await rateLimiter.acquire();
      if (rawParamType === "ACTION") {
        await doSetValue();
      } else {
        await withRetry(doSetValue, "Interface.setValue", logger);
      }

      log({ address: args.address });
      return toolResult({
        address: args.address,
        valueKey: args.valueKey,
        previousValue: parseValue(previousValue),
        newValue: args.value,
        interface: iface,
        type: valueType,
      });
    }),
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
        confirm: confirmField,
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => runTool("put_paramset", deps.logger, async () => {
      const { session, rateLimiter, logger, deviceTypeCache } = deps;
      assertWritable(deps.selection, deps.selection.active, args.confirm);
      const iface = args.interface ?? await deps.resolver.resolveInterface(args.address, session, rateLimiter, logger);

      // CCU expects set as array of {name, type, value} objects
      const paramArray = Object.entries(args.set).map(([name, value]) => {
        // Try to resolve type from device type cache
        let type = deps.resolver.resolveType(args.address, name, deviceTypeCache);
        if (!type) type = inferType(value);
        return { name, type, value: String(value) };
      });

      // If any written key is a one-shot ACTION trigger, the request must not
      // be auto-retried — a timeout after delivery would re-fire the trigger.
      const containsAction = Object.keys(args.set).some(
        (name) => deps.resolver.resolveRawParamType(args.address, name, deviceTypeCache) === "ACTION",
      );
      const doPutParamset = () => session.call("Interface.putParamset", {
        interface: iface,
        address: args.address,
        paramsetKey: args.paramsetKey,
        set: paramArray,
      });
      await rateLimiter.acquire();
      if (containsAction) {
        await doPutParamset();
      } else {
        await withRetry(doPutParamset, "Interface.putParamset", logger);
      }

      return toolResult({ address: args.address, paramsetKey: args.paramsetKey, written: args.set });
    }),
  );
}

const SYSVAR_TYPE_TTL_MS = 30_000;

function registerSetSystemVariable(server: McpServer, deps: ServerDeps): void {
  // Short-lived name→type cache (per active target): avoids fetching the full
  // sysvar list on every write. create/delete clear it so new/removed variables
  // are reflected immediately.

  server.registerTool(
    "set_system_variable",
    {
      title: "Set System Variable",
      description:
        "Set a system variable value. Type is auto-detected — use list_system_variables to see available variables.",
      inputSchema: {
        name: z.string().describe("Variable name (exact match)"),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to set"),
        confirm: confirmField,
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => runTool("set_system_variable", deps.logger, async () => {
      const { session, rateLimiter, logger } = deps;
      const typeCacheHolder = deps.selection.active.sysVarTypeCache;
      assertWritable(deps.selection, deps.selection.active, args.confirm);
      // Look up variable type (cached) to choose correct setter
      let method: string;
      let sysVar: { type: string; valueList?: string } | undefined;
      if (typeCacheHolder.entry && Date.now() - typeCacheHolder.entry.ts < SYSVAR_TYPE_TTL_MS) {
        sysVar = typeCacheHolder.entry.types.get(args.name);
      }
      if (sysVar === undefined) {
        await rateLimiter.acquire();
        const allVars = await withRetry(
          () => session.call("SysVar.getAll"),
          "SysVar.getAll",
          logger,
        ) as Array<{ name: string; type: string; valueList?: string }>;
        typeCacheHolder.entry = {
          ts: Date.now(),
          types: new Map(allVars.map((v) => [v.name, { type: v.type, valueList: v.valueList }])),
        };
        sysVar = typeCacheHolder.entry.types.get(args.name);
      }

      if (sysVar === undefined) {
        logger.warn("sysvar_not_found", { name: args.name });
        throw new CcuError({
          error: "NOT_FOUND",
          code: 0,
          message: `System variable not found: ${args.name}`,
          hint: "Call list_system_variables to see available variables (name must match exactly).",
        });
      }

      // SysVar.getAll reports exactly LOGIC / ALARM / LIST / NUMBER / STRING
      // (occu getall.tcl); the extra aliases keep any older/other firmware
      // spellings working.
      const varType = sysVar.type.toUpperCase();
      let rpcValue: string | number | boolean = args.value;
      if (varType.includes("LOGIC") || varType.includes("BOOL") || varType.includes("ALARM")) {
        method = "SysVar.setBool";
        // setbool.tcl compares non-0/1 values as STRINGS ("false" >= 1 is a
        // lexicographic compare that yields true), so a JSON boolean false
        // would be stored as 1. Normalize to numeric 0/1 and reject anything
        // that isn't clearly a boolean.
        if (args.value === true || args.value === "true" || args.value === 1 || args.value === "1") {
          rpcValue = 1;
        } else if (args.value === false || args.value === "false" || args.value === 0 || args.value === "0") {
          rpcValue = 0;
        } else {
          throw new CcuError({
            error: "INVALID_INPUT",
            code: 0,
            message: `System variable "${args.name}" is boolean; got: ${JSON.stringify(args.value)}`,
            hint: "Pass true/false (or 0/1).",
          });
        }
      } else if (varType.includes("FLOAT") || varType.includes("NUMBER") || varType.includes("INTEGER")) {
        method = "SysVar.setFloat";
      } else if (varType.includes("ENUM") || varType.includes("LIST")) {
        method = "SysVar.setFloat"; // Enums use numeric index
        // Accept either a 0-based index or one of the enum's labels; anything
        // else would be forwarded unchecked to sv.State() and store garbage
        // while the tool reports success.
        const labels = (sysVar.valueList ?? "").split(";");
        const asLabel = labels.indexOf(String(args.value));
        const index = asLabel >= 0
          ? asLabel
          : (typeof args.value === "number" || /^\d+$/.test(String(args.value)) ? Number(args.value) : NaN);
        if (!Number.isInteger(index) || index < 0 || index >= labels.length) {
          throw new CcuError({
            error: "INVALID_INPUT",
            code: 0,
            message: `Invalid value for enum variable "${args.name}": ${JSON.stringify(args.value)}`,
            hint: `Pass an index 0-${labels.length - 1} or one of: ${labels.join(", ")}`,
          });
        }
        rpcValue = index;
      } else if (varType.includes("STRING")) {
        // String variables: use ReGa.runScript as there's no SysVar.setString API.
        // Scope the lookup to the sysvar list (a global dom.GetObject name match
        // could hit a channel/program of the same name) and verify the script
        // actually ran — empty output means ReGa failed, not success.
        await rateLimiter.acquire();
        const escapedName = escapeHmScript(String(args.name));
        const escapedValue = escapeHmScript(String(args.value));
        const output = await withRetry(
          () => session.call("ReGa.runScript", {
            script:
              `object sv = dom.GetObject(ID_SYSTEM_VARIABLES).Get("${escapedName}");\n` +
              `if (sv) { sv.State("${escapedValue}"); WriteLine("OK"); } else { WriteLine("NOT_FOUND"); }`,
          }, deps.selection.active.profile.ccu.scriptTimeout),
          "ReGa.runScript",
          logger,
        );
        const outcome = typeof output === "string" ? output.trim() : "";
        if (outcome === "NOT_FOUND") {
          throw new CcuError({
            error: "NOT_FOUND",
            code: 0,
            message: `System variable not found: ${args.name}`,
            hint: "The variable disappeared between lookup and write. Call list_system_variables.",
          });
        }
        if (outcome !== "OK") {
          throw new CcuError({
            error: "CCU_ERROR",
            code: 0,
            message: `ReGa script produced no confirmation while setting "${args.name}" — the write may not have happened`,
            hint: "The CCU's script engine likely failed (busy or errored). Verify with get_value / list_system_variables and retry.",
          });
        }
        return toolResult({ name: args.name, value: args.value, method: "ReGa.runScript (string)" });
      } else {
        logger.warn("sysvar_unknown_type", { name: args.name, type: sysVar.type });
        throw new CcuError({
          error: "INVALID_INPUT",
          code: 0,
          message: `System variable "${args.name}" has unsupported type: ${sysVar.type}`,
          hint: "Supported types are logic/alarm, number, list, and string.",
        });
      }

      await rateLimiter.acquire();
      await withRetry(
        () => session.call(method, { name: args.name, value: rpcValue }),
        method,
        logger,
      );

      return toolResult({ name: args.name, value: rpcValue, method });
    }),
  );
}

function registerCreateSystemVariable(server: McpServer, deps: ServerDeps): void {
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
        confirm: confirmField,
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => runTool("create_system_variable", deps.logger, async (log) => {
      const { session, rateLimiter, logger } = deps;
      const typeCacheHolder = deps.selection.active.sysVarTypeCache;
      assertWritable(deps.selection, deps.selection.active, args.confirm);
      if (args.type === "enum" && (!args.values || args.values.length === 0)) {
        throw new CcuError({
          error: "INVALID_INPUT",
          code: 0,
          message: "An enum system variable requires a non-empty 'values' list.",
          hint: "Pass values, e.g. [\"off\", \"low\", \"high\"].",
        });
      }
      // ";" is the CCU's in-band ValueList separator: a label containing it
      // would silently split into extra enum states and shift every index
      // after it. escapeHmScript can't help — the separator is data, not syntax.
      for (const label of args.values ?? []) {
        if (label.includes(";")) {
          throw new CcuError({
            error: "INVALID_INPUT",
            code: 0,
            message: `Enum label ${JSON.stringify(label)} contains ";", the CCU's value-list separator.`,
            hint: "Rename the label without a semicolon — the CCU cannot represent one inside an enum state name.",
          });
        }
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
      // types on one code path). Ordering matters and was verified live: set
      // ValueType + Name + type-specifics, Add(sv.ID()), and only THEN set
      // ValueUnit/DPInfo — setting those *before* Add makes the CCU store the
      // variable under a deduplicated " N" name (silent rename). The script
      // returns the actual stored name so we never report a name we didn't get.
      const name = escapeHmScript(args.name);
      const info = escapeHmScript(args.description ?? "");
      const unit = escapeHmScript(args.unit ?? "");
      let typeSetup: string;
      switch (args.type) {
        case "bool":
          typeSetup =
            'sv.ValueType(ivtBinary);\n' +
            'sv.ValueSubType(istBool);\n' +
            `sv.Name("${name}");\n` +
            'sv.ValueName0("false");\n' +
            'sv.ValueName1("true");\n' +
            'sv.State(false);';
          break;
        case "float": {
          const min = hmNumberLiteral(Number.isFinite(args.min) ? args.min! : 0, "min");
          const max = hmNumberLiteral(Number.isFinite(args.max) ? args.max! : 100, "max");
          typeSetup =
            'sv.ValueType(ivtFloat);\n' +
            `sv.Name("${name}");\n` +
            `sv.ValueMin(${min});\n` +
            `sv.ValueMax(${max});\n` +
            'sv.State(0);';
          break;
        }
        case "enum": {
          const list = escapeHmScript((args.values ?? []).join(";"));
          typeSetup =
            'sv.ValueType(ivtInteger);\n' +
            'sv.ValueSubType(istEnum);\n' +
            `sv.Name("${name}");\n` +
            `sv.ValueList("${list}");\n` +
            'sv.State(0);';
          break;
        }
        case "string":
        default:
          typeSetup =
            'sv.ValueType(ivtString);\n' +
            `sv.Name("${name}");\n` +
            'sv.State("");';
          break;
      }

      // ValueUnit applies to float only; DPInfo (description) to all. Both go
      // AFTER Add (see comment above).
      const postAdd =
        (args.type === "float" ? `sv.ValueUnit("${unit}");\n` : "") +
        `sv.DPInfo("${info}");`;

      const script =
        `object oSysVars = dom.GetObject(ID_SYSTEM_VARIABLES);\n` +
        `object sv = dom.CreateObject(OT_VARDP);\n` +
        `${typeSetup}\n` +
        `sv.Internal(false);\n` +
        `oSysVars.Add(sv.ID());\n` +
        `${postAdd}\n` +
        `dom.RTUpdate(false);\n` +
        `WriteLine(sv.Name());`;

      await rateLimiter.acquire();
      const createResult = await withRetry(
        () => session.call("ReGa.runScript", { script }, deps.selection.active.profile.ccu.scriptTimeout),
        "ReGa.runScript",
        logger,
      );

      // The script echoes the ACTUAL stored name. Empty output means the ReGa
      // script itself failed (hmscript.tcl returns "" on any script error) —
      // treating that as "created" would report success for a create that
      // never happened.
      const actualName = typeof createResult === "string" ? createResult.trim() : "";
      if (!actualName) {
        throw new CcuError({
          error: "CCU_ERROR",
          code: 0,
          message: `Create script for "${args.name}" produced no output — the variable was most likely NOT created`,
          hint: "The CCU's script engine failed (busy or script error). Check with list_system_variables and retry.",
        });
      }
      // The CCU silently dedups a requested name against existing similar names
      // (e.g. "X" becomes "X 1" when an "X 2" already exists), which the
      // exact-match pre-check above can't see. If we didn't get the name we
      // asked for, undo it and report the collision rather than leaving a
      // surprise variable behind.
      if (actualName !== args.name) {
        try {
          await rateLimiter.acquire();
          await session.call("SysVar.deleteSysVarByName", { name: actualName });
        } catch { /* best-effort cleanup of the unintended object */ }
        throw new CcuError({
          error: "INVALID_INPUT",
          code: 0,
          message: `System variable name unavailable: "${args.name}" (the CCU would store it as "${actualName}")`,
          hint: "Pick a different name — the CCU deduplicates against existing similar names.",
        });
      }

      typeCacheHolder.entry = null; // new variable must be visible to the next set
      log({ type: args.type });
      return toolResult({ name: actualName, type: args.type, created: true });
    }),
  );
}

function registerDeleteSystemVariable(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "delete_system_variable",
    {
      title: "Delete System Variable",
      description: "Delete a system variable by name. Use list_system_variables to see existing names. " +
        "On a protected target, EVERY call needs confirm:true — the session unlock from other write tools does not apply.",
      inputSchema: {
        name: z.string().describe("Variable name (exact match)"),
        confirm: z.boolean().optional().describe("Required true on EVERY call against a protected CCU target (e.g. prod) — deletion never rides on the session unlock."),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => runTool("delete_system_variable", deps.logger, async () => {
      const { session, rateLimiter, logger } = deps;
      const typeCacheHolder = deps.selection.active.sysVarTypeCache;
      // Destructive and unrecoverable — per-call confirm (#72)
      assertWritable(deps.selection, deps.selection.active, args.confirm, { alwaysConfirm: true });
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
      return toolResult({ name: args.name, deleted: true });
    }),
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
        confirm: confirmField,
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => runTool(toolName, deps.logger, async () => {
      const { session, rateLimiter, logger } = deps;
      assertWritable(deps.selection, deps.selection.active, args.confirm);
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

      return toolResult({
        channel: args.channel,
        [mode === "add" ? "assignedTo" : "removedFrom"]: applied,
      });
    }),
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
        confirm: confirmField,
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => runTool("execute_program", deps.logger, async () => {
      const { session, rateLimiter, logger } = deps;
      assertWritable(deps.selection, deps.selection.active, args.confirm);
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

      return toolResult({ id: args.id, name: program.name, executed: true });
    }),
  );
}

/**
 * Render a number as a HomeMatic Script numeric literal. JS stringification
 * uses exponent notation for extreme magnitudes ("1e-7", "1e+21"), which ReGa
 * cannot parse — the whole script would fail. Reject those instead of emitting
 * a broken script.
 */
function hmNumberLiteral(n: number, field: string): string {
  const s = String(n);
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new CcuError({
      error: "INVALID_INPUT",
      code: 0,
      message: `Value for "${field}" (${s}) cannot be written as a HomeMatic Script number literal`,
      hint: "Use a plain decimal magnitude (no exponent notation).",
    });
  }
  return s;
}

export function inferType(value: unknown): string {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  return "string";
}
