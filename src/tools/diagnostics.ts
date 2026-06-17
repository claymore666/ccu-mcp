import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import type { CcuDevice } from "../ccu/types.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { toolResult, structuredResult, tryParseJson, escapeHmScript, VERSION } from "../utils.js";

export function registerDiagnosticsTools(server: McpServer, deps: ServerDeps): void {
  registerGetServiceMessages(server, deps);
  registerAcknowledgeServiceMessages(server, deps);
  registerGetSystemInfo(server, deps);
  registerGetRssi(server, deps);
}

// rssiInfo reports 65536 (0x10000) when no measurement is available; real
// values are already in dBm. Map the sentinel (and any non-number) to null.
function normalizeRssi(v: unknown): number | null {
  return typeof v === "number" && v !== 65536 ? v : null;
}

function registerGetServiceMessages(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_service_messages",
    {
      title: "Get Service Messages",
      description:
        "Get all active service messages (low battery, unreachable, etc.) with device details and timestamps.",
      outputSchema: { messages: z.array(z.unknown()).describe("Active alarms: {id, type, address, channelName, timestamp}") },
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
        return structuredResult({ messages: Array.isArray(messages) ? messages : [] }, messages);
      } catch (err) {
        logger.info("tool_call", { tool: "get_service_messages", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerAcknowledgeServiceMessages(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "acknowledge_service_messages",
    {
      title: "Acknowledge Service Messages",
      description:
        "Confirm/dismiss active service messages (e.g. clear a low-battery or unreachable warning). " +
        "Provide an alarm id (from get_service_messages) to confirm one message, or a channel address " +
        "to confirm all active messages on that channel. A warning reappears if its condition persists.",
      inputSchema: {
        id: z.string().optional().describe("Alarm id from get_service_messages (confirm a single message)"),
        address: z.string().optional().describe("Channel address — confirm all active messages on this channel (e.g. '000A1BE9A71F15:0')"),
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
        if (!args.id && !args.address) {
          throw new CcuError({
            error: "INVALID_INPUT",
            code: 0,
            message: "Provide either an alarm id or a channel address to acknowledge.",
            hint: "Call get_service_messages to see active alarms with their ids and addresses.",
          });
        }

        // Enumerate active alarms (same OT_ALARMDP objects get_service_messages
        // lists), AlConfirm() the ones matching the requested id/address, and
        // report what was confirmed. Confirming in ReGa avoids a second round
        // trip and means we only ever confirm currently-active alarms.
        const wantId = escapeHmScript(args.id ?? "");
        const wantAddr = escapeHmScript(args.address ?? "");
        const script = `
          string wantId = "${wantId}";
          string wantAddr = "${wantAddr}";
          object svcs = dom.GetObject(ID_SERVICES);
          boolean first = true;
          Write('{"confirmed":[');
          if (svcs) {
            string sId;
            foreach(sId, svcs.EnumIDs()) {
              object svc = dom.GetObject(sId);
              if (svc && svc.IsTypeOf(OT_ALARMDP) && svc.AlState() == asOncoming) {
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
                boolean match = false;
                if (wantId != "" && sId == wantId) { match = true; }
                if (wantAddr != "" && chAddr == wantAddr) { match = true; }
                if (match) {
                  svc.AlConfirm();
                  if (!first) { Write(","); } first = false;
                  ! JSON-escape user-controlled names (backslash first, then quote)
                  dpName = dpName.Replace("\\\\", "\\\\\\\\");
                  dpName = dpName.Replace("\\"", "\\\\\\"");
                  Write('{"id":"' # sId # '","type":"' # dpName # '","address":"' # chAddr # '"}');
                }
              }
            }
          }
          Write(']}');
        `;

        await rateLimiter.acquire();
        const result = await withRetry(
          () => session.call("ReGa.runScript", { script }, deps.config.ccu.scriptTimeout),
          "ReGa.runScript",
          logger,
        );

        const parsed = typeof result === "string" ? tryParseJson(result) : result;
        const confirmed = (parsed && typeof parsed === "object" && !Array.isArray(parsed)
          && Array.isArray((parsed as Record<string, unknown>).confirmed))
          ? (parsed as Record<string, unknown>).confirmed as Array<Record<string, unknown>>
          : [];

        if (confirmed.length === 0) {
          throw new CcuError({
            error: "NOT_FOUND",
            code: 0,
            message: args.id
              ? `No active service message with id: ${args.id}`
              : `No active service messages on channel: ${args.address}`,
            hint: "Call get_service_messages to see currently active alarms.",
          });
        }

        logger.info("tool_call", { tool: "acknowledge_service_messages", duration_ms: Date.now() - start, status: "ok", count: confirmed.length });
        return toolResult({ confirmed, count: confirmed.length });
      } catch (err) {
        logger.info("tool_call", { tool: "acknowledge_service_messages", duration_ms: Date.now() - start, status: "error" });
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
      outputSchema: {
        serverVersion: z.string().optional(),
        version: z.unknown().optional(),
        serial: z.unknown().optional(),
        address: z.unknown().optional(),
        hmipAddress: z.unknown().optional(),
        cacheTypes: z.number().optional(),
        cacheWarming: z.boolean().optional(),
      },
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
        return structuredResult(results as Record<string, unknown>);
      } catch (err) {
        logger.info("tool_call", { tool: "get_system_info", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

function registerGetRssi(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_rssi",
    {
      title: "Get RSSI / Radio Quality",
      description:
        "Report radio link quality (RSSI, in dBm) for every device, resolved to device names, plus " +
        "BidCos interface health (duty cycle, connected state). Covers both transports: BidCos-RF via " +
        "Interface.rssiInfo, and HmIP-RF via each device's RSSI_DEVICE/RSSI_PEER maintenance datapoints. " +
        "Use to answer 'why is this sensor flaky?'. Higher (closer to 0) dBm is better; null = no measurement.",
      inputSchema: {
        name: z.string().optional().describe("Filter by device name or address (substring, case-insensitive)"),
      },
      outputSchema: {
        devices: z.array(z.unknown()).describe("Per device: {address, name, interface, links:[{peer, rssiDevice, rssiPeer}]}"),
        interfaces: z.unknown().describe("BidCos interface health (duty cycle, connected)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session, rateLimiter, logger } = deps;
      const start = Date.now();

      try {
        // Device list → address→{name,interface}. Same call list_devices uses;
        // also refresh the resolver so later interface lookups are warm.
        await rateLimiter.acquire();
        const devices = await withRetry(
          () => session.call("Device.listAllDetail"),
          "Device.listAllDetail",
          logger,
        ) as CcuDevice[];
        deps.resolver.updateDeviceList(devices);
        const nameByAddress = new Map<string, string>();
        const ifaceByAddress = new Map<string, string>();
        for (const d of devices) {
          nameByAddress.set(d.address, d.name);
          ifaceByAddress.set(d.address, d.interface);
        }

        // Enumerate interfaces and pull rssiInfo per interface. The JSON-RPC
        // Interface.rssiInfo returns an ARRAY (see occu .../interface/rssiinfo.tcl):
        //   [{ name: <deviceAddress>, partner: [{ name: <peerAddress>, rssiData: [a, b] }] }]
        // The `name` fields are device/peer addresses; rssiData values are dBm
        // (65536 = no measurement). atDevice = received by this device from peer,
        // atPeer = received by the peer from this device.
        await rateLimiter.acquire();
        const interfaces = await withRetry(
          () => session.call("Interface.listInterfaces"),
          "Interface.listInterfaces",
          logger,
        ) as Array<{ name: string }>;

        const needle = args.name?.toLowerCase();
        const deviceEntries: Array<Record<string, unknown>> = [];

        type RssiEntry = { name: string; partner?: Array<{ name: string; rssiData?: unknown }> };
        for (const iface of interfaces) {
          let info: RssiEntry[] | null = null;
          try {
            await rateLimiter.acquire();
            info = await withRetry(
              () => session.call("Interface.rssiInfo", { interface: iface.name }),
              "Interface.rssiInfo",
              logger,
            ) as RssiEntry[];
          } catch {
            // Interfaces without RF (e.g. VirtualDevices) don't support rssiInfo.
            continue;
          }
          if (!Array.isArray(info)) continue;

          for (const dev of info) {
            const address = dev?.name ?? "";
            if (!address) continue;
            const links = (Array.isArray(dev.partner) ? dev.partner : []).map((p) => {
              const pair = Array.isArray(p?.rssiData) ? p.rssiData : [];
              return {
                peer: p?.name ?? "",
                peerName: nameByAddress.get(p?.name ?? "") ?? "",
                rssiDevice: normalizeRssi(pair[0]), // dBm received by this device from peer
                rssiPeer: normalizeRssi(pair[1]),   // dBm received by the peer from this device
              };
            });
            const entry = {
              address,
              name: nameByAddress.get(address) ?? "",
              interface: ifaceByAddress.get(address) ?? iface.name,
              links,
            };
            if (needle && !`${entry.address} ${entry.name}`.toLowerCase().includes(needle)) continue;
            deviceEntries.push(entry);
          }
        }

        // HmIP devices don't expose rssiInfo; their RSSI lives in the :0
        // maintenance channel's RSSI_DEVICE / RSSI_PEER datapoints (dBm, negative).
        // Read the :0 VALUES paramset per HmIP device (one call each — there's no
        // bulk equivalent) and merge into the same output shape: rssiDevice =
        // measured by the device, rssiPeer = measured by the peer (AP/CCU), where
        // present. Values are already dBm; a non-negative reading means "no value".
        // Interface.getParamset returns raw string values; coerce, and treat
        // only a negative dBm as a real reading (0/positive/non-numeric = none).
        const dbm = (v: unknown): number | null => {
          const n = typeof v === "string" ? Number(v) : v;
          return typeof n === "number" && Number.isFinite(n) && n < 0 ? n : null;
        };
        for (const d of devices) {
          if (!/hmip/i.test(d.interface)) continue;
          const maint = d.channels.find((c) => c.address.endsWith(":0"));
          if (!maint) continue;
          if (needle && !`${d.address} ${d.name}`.toLowerCase().includes(needle)) continue;
          try {
            await rateLimiter.acquire();
            const vals = await withRetry(
              () => session.call("Interface.getParamset", { interface: d.interface, address: maint.address, paramsetKey: "VALUES" }),
              "Interface.getParamset",
              logger,
            ) as Record<string, unknown>;
            const rssiDevice = dbm(vals?.RSSI_DEVICE);
            const rssiPeer = dbm(vals?.RSSI_PEER);
            if (rssiDevice === null && rssiPeer === null) continue; // no usable RSSI
            deviceEntries.push({
              address: d.address,
              name: d.name,
              interface: d.interface,
              links: [{ peer: d.interface, peerName: "", rssiDevice, rssiPeer }],
            });
          } catch {
            // device unreachable / paramset unreadable — skip, don't fail the call
            continue;
          }
        }

        // BidCos interface health (duty cycle, connected). Optional — not all
        // setups expose it; tolerate failure rather than failing the whole call.
        let bidcosInterfaces: unknown = [];
        try {
          await rateLimiter.acquire();
          bidcosInterfaces = await withRetry(
            () => session.call("Interface.listBidcosInterfaces"),
            "Interface.listBidcosInterfaces",
            logger,
          );
        } catch {
          bidcosInterfaces = [];
        }

        logger.info("tool_call", { tool: "get_rssi", duration_ms: Date.now() - start, status: "ok", devices: deviceEntries.length });
        return structuredResult({ devices: deviceEntries, interfaces: bidcosInterfaces });
      } catch (err) {
        logger.info("tool_call", { tool: "get_rssi", duration_ms: Date.now() - start, status: "error" });
        if (err instanceof CcuError) return err.toMcpError();
        throw err;
      }
    },
  );
}

// tryParseJson re-exported from utils for backward compatibility with tests
export { tryParseJson } from "../utils.js";
