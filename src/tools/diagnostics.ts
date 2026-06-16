import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { toolResult, tryParseJson, VERSION } from "../utils.js";

export function registerDiagnosticsTools(server: McpServer, deps: ServerDeps): void {
  registerGetServiceMessages(server, deps);
  registerGetSystemInfo(server, deps);
}

function registerGetServiceMessages(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_service_messages",
    {
      title: "Get Service Messages",
      description:
        "Get all active service messages (low battery, unreachable, etc.) with device details and timestamps.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        // Two single passes instead of a nested per-alarm channel scan: emit the
        // alarms first while collecting their addresses, then resolve channel
        // names in ONE sweep over all channels (sentinel-comma Find, as in
        // buildGetValuesScript). The name merge happens in JS below.
        const script = `
          object svcs = dom.GetObject(ID_SERVICES);
          boolean first = true;
          string addrList = ",";
          Write('{"alarms":[');
          if (svcs) {
            string sId;
            foreach(sId, svcs.EnumIDs()) {
              object svc = dom.GetObject(sId);
              if (svc && svc.IsTypeOf(OT_ALARMDP) && svc.AlState() == asOncoming) {
                if (!first) { Write(","); } first = false;
                ! Parse address from alarm name: AL-<address>.<dpName>
                string alName = svc.Name();
                string chAddr = "";
                string dpName = "";
                integer alPos = alName.Find("AL-");
                if (alPos >= 0) {
                  string rest = alName.Substr(3, alName.Length());
                  integer dotPos = rest.Find(".");
                  if (dotPos > 0) {
                    chAddr = rest.Substr(0, dotPos);
                    dpName = rest.Substr(dotPos + 1, rest.Length());
                  }
                }
                if (chAddr != "") { addrList = addrList # chAddr # ","; }
                ! JSON-escape user-controlled names (backslash first, then quote)
                dpName = dpName.Replace("\\\\", "\\\\\\\\");
                dpName = dpName.Replace("\\"", "\\\\\\"");
                Write('{"id":"' # sId # '"');
                Write(',"type":"' # dpName # '"');
                Write(',"address":"' # chAddr # '"');
                Write(',"timestamp":"' # svc.AlOccurrenceTime() # '"');
                Write('}');
              }
            }
          }
          Write('],"channelNames":{');
          boolean firstCh = true;
          string cId;
          foreach(cId, dom.GetObject(ID_CHANNELS).EnumUsedIDs()) {
            object c = dom.GetObject(cId);
            if (c) {
              string needle = "," # c.Address() # ",";
              if (addrList.Find(needle) >= 0) {
                if (!firstCh) { Write(","); } firstCh = false;
                string cName = c.Name();
                cName = cName.Replace("\\\\", "\\\\\\\\");
                cName = cName.Replace("\\"", "\\\\\\"");
                Write('"' # c.Address() # '":"' # cName # '"');
              }
            }
          }
          Write("}}");
        `;

        await rateLimiter.acquire();
        const result = await withRetry(
          () => session.call("ReGa.runScript", { script }, deps.config.ccu.scriptTimeout),
          "ReGa.runScript",
          logger,
        );

        const parsed = typeof result === "string" ? tryParseJson(result) : result;

        // Merge channel names into the alarms (same output shape as before)
        let messages: unknown = parsed;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
            && Array.isArray((parsed as Record<string, unknown>).alarms)) {
          const names = ((parsed as Record<string, unknown>).channelNames ?? {}) as Record<string, string>;
          messages = ((parsed as Record<string, unknown>).alarms as Array<Record<string, unknown>>).map((a) => ({
            ...a,
            channelName: names[a.address as string] ?? "",
          }));
        }

        logger.info("tool_call", { tool: "get_service_messages", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(messages);
      } catch (err) {
        logger.info("tool_call", { tool: "get_service_messages", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerGetSystemInfo(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_system_info",
    {
      title: "Get System Info",
      description: "Get CCU system information: firmware version, serial number, addresses.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { session, rateLimiter, logger, deviceTypeCache } = deps;
      const start = Date.now();

      try {
        const results: Record<string, unknown> = { serverVersion: VERSION };

        const calls: Array<{ key: string; method: string }> = [
          { key: "version", method: "CCU.getVersion" },
          { key: "serial", method: "CCU.getSerial" },
          { key: "address", method: "CCU.getAddress" },
          { key: "hmipAddress", method: "CCU.getHmIPAddress" },
        ];

        for (const { key, method } of calls) {
          try {
            await rateLimiter.acquire();
            results[key] = await session.call(method);
          } catch {
            results[key] = null;
          }
        }

        results.cacheTypes = deviceTypeCache.size();
        results.cacheWarming = deviceTypeCache.isWarming();

        logger.info("tool_call", { tool: "get_system_info", duration_ms: Date.now() - start, status: "ok" });
        return toolResult(results);
      } catch (err) {
        logger.info("tool_call", { tool: "get_system_info", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

// tryParseJson re-exported from utils for backward compatibility with tests
export { tryParseJson } from "../utils.js";
