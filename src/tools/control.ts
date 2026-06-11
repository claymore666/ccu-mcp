import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { toolResult, parseValue, escapeHmScript } from "../utils.js";

export function registerControlTools(server: McpServer, deps: ServerDeps): void {
  registerSetValue(server, deps);
  registerPutParamset(server, deps);
  registerSetSystemVariable(server, deps);
  registerExecuteProgram(server, deps);
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
        title: "Set Value",
        destructiveHint: true,
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
        title: "Put Paramset",
        destructiveHint: true,
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

function registerSetSystemVariable(server: McpServer, deps: ServerDeps): void {
  // Short-lived name→type cache: avoids fetching the full sysvar list on every
  // write. Types virtually never change; a fresh-cache miss still refetches,
  // so newly created variables are picked up immediately.
  let typeCache: { ts: number; types: Map<string, string> } | null = null;

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
        title: "Set System Variable",
        destructiveHint: true,
      },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        // Look up variable type (cached) to choose correct setter
        let method: string;
        let sysVarType: string | undefined;
        if (typeCache && Date.now() - typeCache.ts < SYSVAR_TYPE_TTL_MS) {
          sysVarType = typeCache.types.get(args.name);
        }
        if (sysVarType === undefined) {
          await rateLimiter.acquire();
          const allVars = await withRetry(
            () => session.call("SysVar.getAll"),
            "SysVar.getAll",
            logger,
          ) as Array<{ name: string; type: string }>;
          typeCache = { ts: Date.now(), types: new Map(allVars.map((v) => [v.name, v.type])) };
          sysVarType = typeCache.types.get(args.name);
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
        title: "Execute Program",
        destructiveHint: true,
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
