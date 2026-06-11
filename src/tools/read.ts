import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { toolResult, tryParseJson, escapeHmScript, parseValue, parseValues } from "../utils.js";

export function registerReadTools(server: McpServer, deps: ServerDeps): void {
  registerGetValue(server, deps);
  registerGetValues(server, deps);
  registerGetParamset(server, deps);
}

function registerGetValue(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_value",
    {
      title: "Get Value",
      description:
        "Read a single datapoint value from a device channel. " +
        "Only address and valueKey are required — interface is auto-resolved. " +
        "Use list_devices to find addresses, describe_device_type to find valid valueKeys.",
      inputSchema: {
        address: z.string().describe("Channel address (e.g. '000A1BE9A71F15:1')"),
        valueKey: z.string().describe("Datapoint name (e.g. 'STATE', 'LEVEL', 'ACTUAL_TEMPERATURE')"),
        interface: z.string().optional().describe("Interface name override (auto-resolved if omitted)"),
      },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        const iface = args.interface ?? await deps.resolver.resolveInterface(args.address, session, rateLimiter, logger);

        await rateLimiter.acquire();
        const value = await withRetry(
          () => session.call("Interface.getValue", {
            interface: iface,
            address: args.address,
            valueKey: args.valueKey,
          }),
          "Interface.getValue",
          logger,
        );

        logger.info("tool_call", { tool: "get_value", duration_ms: Date.now() - start, status: "ok", address: args.address });
        return toolResult({ address: args.address, valueKey: args.valueKey, value: parseValue(value) });
      } catch (err) {
        logger.info("tool_call", { tool: "get_value", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerGetValues(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_values",
    {
      title: "Get Values (Bulk)",
      description:
        "Read datapoint values for multiple channels at once via HM Script. " +
        "Provide either a list of channel addresses, or filter by room or function name.",
      inputSchema: {
        channels: z.array(z.string()).optional().describe("Array of channel addresses to read"),
        room: z.string().optional().describe("Room name — read all channels in this room"),
        function: z.string().optional().describe("Function name — read all channels in this function group"),
      },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        // Build HM Script to collect values
        let script: string;

        if (args.channels && args.channels.length > 0) {
          // Comma-delimited with sentinel commas for exact matching via Find()
          const addrList = "," + args.channels.map((a) => escapeHmScript(a)).join(",") + ",";
          script = buildGetValuesScript(`"${addrList}"`, "addresses");
        } else if (args.room) {
          script = buildGetValuesScript(`"${escapeHmScript(args.room)}"`, "room");
        } else if (args.function) {
          script = buildGetValuesScript(`"${escapeHmScript(args.function)}"`, "function");
        } else {
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify({
              error: "INVALID_INPUT",
              message: "Provide either channels, room, or function parameter.",
              hint: "At least one filter is required to avoid reading all devices.",
            }) }],
          };
        }

        await rateLimiter.acquire();
        const result = await withRetry(
          () => session.call("ReGa.runScript", { script }, deps.config.ccu.scriptTimeout),
          "ReGa.runScript",
          logger,
        );

        logger.info("tool_call", { tool: "get_values", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(typeof result === "string" ? tryParseJson(result) : result);
      } catch (err) {
        logger.info("tool_call", { tool: "get_values", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

// Helper HM Script fragment: write channel datapoints as JSON object
// Quote all values as JSON strings for safety — empty values, special chars, enums all handled.
// Names and values are JSON-escaped (backslash first, then quote) since channel names and
// STRING datapoints are user-controlled; addresses and HssType are CCU identifiers and safe.
const WRITE_CHANNEL_DPS = `
          if (!first) { Write(","); } first = false;
          string chNameEsc = ch.Name();
          chNameEsc = chNameEsc.Replace("\\\\", "\\\\\\\\");
          chNameEsc = chNameEsc.Replace("\\"", "\\\\\\"");
          Write('{"address":"' # ch.Address() # '","name":"' # chNameEsc # '","datapoints":{');
          boolean firstDp = true;
          string dpId;
          foreach(dpId, ch.DPs()) {
            object dp = dom.GetObject(dpId);
            if (dp) {
              if (!firstDp) { Write(","); } firstDp = false;
              string dpValEsc = "" # dp.Value();
              dpValEsc = dpValEsc.Replace("\\\\", "\\\\\\\\");
              dpValEsc = dpValEsc.Replace("\\"", "\\\\\\"");
              Write('"' # dp.HssType() # '":"' # dpValEsc # '"');
            }
          }
          Write("}}");
`;

export function buildGetValuesScript(filter: string, filterType: "addresses" | "room" | "function"): string {
  if (filterType === "addresses") {
    // Address-based: single pass over channels, match via string Find
    // HM Script can't do nested foreach over large collections
    return `
      string targetAddrs = ${filter};
      boolean first = true;
      Write("[");
      string chId;
      foreach(chId, dom.GetObject(ID_CHANNELS).EnumUsedIDs()) {
        object ch = dom.GetObject(chId);
        if (ch) {
          string needle = "," # ch.Address() # ",";
          if (targetAddrs.Find(needle) >= 0) {
            ${WRITE_CHANNEL_DPS}
          }
        }
      }
      Write("]");
    `;
  }

  // Room/function: use EnumIDs() on the ENUM object
  const objectLookup = filterType === "room"
    ? `dom.GetObject(ID_ROOMS).Get(${filter})`
    : `dom.GetObject(ID_FUNCTIONS).Get(${filter})`;

  return `
    object container = ${objectLookup};
    boolean first = true;
    Write("[");
    if (container) {
      string chId;
      foreach(chId, container.EnumIDs()) {
        object ch = dom.GetObject(chId);
        if (ch) {
          ${WRITE_CHANNEL_DPS}
        }
      }
    }
    Write("]");
  `;
}

function registerGetParamset(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_paramset",
    {
      title: "Get Paramset",
      description:
        "Read all parameters for a channel (VALUES, MASTER, or LINK). " +
        "Interface is auto-resolved from the address.",
      inputSchema: {
        address: z.string().describe("Channel address (e.g. '000A1BE9A71F15:1')"),
        paramsetKey: z.enum(["VALUES", "MASTER", "LINK"]).describe("Paramset to read"),
        interface: z.string().optional().describe("Interface name override (auto-resolved if omitted)"),
      },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        const iface = args.interface ?? await deps.resolver.resolveInterface(args.address, session, rateLimiter, logger);

        await rateLimiter.acquire();
        const result = await withRetry(
          () => session.call("Interface.getParamset", {
            interface: iface,
            address: args.address,
            paramsetKey: args.paramsetKey,
          }),
          "Interface.getParamset",
          logger,
        );

        logger.info("tool_call", { tool: "get_paramset", duration_ms: Date.now() - start, status: "ok" });
        // Parse values to native types if result is a flat object
        const params = (typeof result === "object" && result !== null && !Array.isArray(result))
          ? parseValues(result as Record<string, unknown>)
          : result;
        return toolResult({ address: args.address, paramsetKey: args.paramsetKey, params });
      } catch (err) {
        logger.info("tool_call", { tool: "get_paramset", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

// tryParseJson re-exported from utils for backward compatibility with tests
export { tryParseJson } from "../utils.js";
