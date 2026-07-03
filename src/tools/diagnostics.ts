import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../server.js";
import type { CcuDevice } from "../ccu/types.js";
import { CcuError } from "../middleware/error-mapper.js";
import { withRetry } from "../middleware/retry.js";
import { runTool } from "../middleware/tool-handler.js";
import { assertWritable, resolveTarget } from "../ccu/target-registry.js";
import { toolResult, structuredResult, tryParseJson, escapeHmScript, VERSION, loadBuildInfo } from "../utils.js";

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
      inputSchema: {
        target: z.string().optional().describe("CCU target to read from (default: active). See list_ccu_targets."),
      },
      outputSchema: { messages: z.array(z.unknown()).describe("Active alarms: {id, type, address, channelName, timestamp}") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => runTool("get_service_messages", deps.logger, async () => {
      const { rateLimiter, logger } = deps;
      const t = resolveTarget(deps.selection, args.target);
      const { session } = t;
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
              ! HM Script has NO operator precedence (right-to-left evaluation,
              ! see issue #74) — null-check first, parenthesize comparisons.
              if (svc) {
              if (svc.IsTypeOf(OT_ALARMDP) && (svc.AlState() == asOncoming)) {
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
                ! JSON-escape user-controlled names (backslash first, then quote,
                ! then raw control chars JSON forbids)
                dpName = dpName.Replace("\\\\", "\\\\\\\\");
                dpName = dpName.Replace("\\"", "\\\\\\"");
                dpName = dpName.Replace("\\t", "\\\\t");
                dpName = dpName.Replace("\\r", "\\\\r");
                dpName = dpName.Replace("\\n", "\\\\n");
                Write('{"id":"' # sId # '"');
                Write(',"type":"' # dpName # '"');
                Write(',"address":"' # chAddr # '"');
                Write(',"timestamp":"' # svc.AlOccurrenceTime() # '"');
                Write('}');
              }
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
                cName = cName.Replace("\\t", "\\\\t");
                cName = cName.Replace("\\r", "\\\\r");
                cName = cName.Replace("\\n", "\\\\n");
                Write('"' # c.Address() # '":"' # cName # '"');
              }
            }
          }
          Write("}}");
        `;

        await rateLimiter.acquire();
        const result = await withRetry(
          () => session.call("ReGa.runScript", { script }, t.profile.ccu.scriptTimeout),
          "ReGa.runScript",
          logger,
          { rateLimiter },
        );

        const parsed = typeof result === "string" ? tryParseJson(result) : result;

        // Merge channel names into the alarms (same output shape as before).
        // A bare array (the pre-#8 script format) is accepted as-is.
        let messages: unknown = Array.isArray(parsed) ? parsed : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
            && Array.isArray((parsed as Record<string, unknown>).alarms)) {
          const names = ((parsed as Record<string, unknown>).channelNames ?? {}) as Record<string, string>;
          messages = ((parsed as Record<string, unknown>).alarms as Array<Record<string, unknown>>).map((a) => ({
            ...a,
            channelName: names[a.address as string] ?? "",
          }));
        }

        // Unparseable/empty script output must NOT read as "zero alarms" —
        // that is a monitoring-grade false negative while LOWBAT/UNREACH may
        // be active. runscript returns "" whenever the ReGa script fails.
        if (!Array.isArray(messages)) {
          throw new CcuError({
            error: "CCU_ERROR",
            code: 0,
            message: "The CCU script for get_service_messages returned no parseable output",
            hint: "The CCU's script engine failed (busy or errored). Try again — do not treat this as 'no service messages'.",
          });
        }

        return structuredResult({ messages }, messages);
    }),
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
        confirm: z.boolean().optional().describe("Set true to authorize this write against a protected CCU target (e.g. prod)."),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => runTool("acknowledge_service_messages", deps.logger, async (log) => {
      const { rateLimiter, logger } = deps;
      // Pin the target once (see control.ts set_value).
      const active = deps.selection.active;
      const { session } = active;
        assertWritable(deps.selection, active, args.confirm);
        if (!args.id && !args.address) {
          throw new CcuError({
            error: "INVALID_INPUT",
            code: 0,
            message: "Provide either an alarm id or a channel address to acknowledge.",
            hint: "Call get_service_messages to see active alarms with their ids and addresses.",
          });
        }

        // Enumerate active alarms (same OT_ALARMDP objects get_service_messages
        // lists), AlReceipt() the ones matching the requested id/address, and
        // report what was confirmed. Confirming in ReGa avoids a second round
        // trip and means we only ever confirm currently-active alarms.
        // AlReceipt() is what the WebUI itself uses (OCCU functions.fn::ReceiptAlarm);
        // there is no AlConfirm() in ReGa — an unknown method aborts the whole
        // script at parse time with EMPTY output (issue #74).
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
              ! HM Script has NO operator precedence (right-to-left evaluation,
              ! see issue #74) — null-check first, parenthesize comparisons.
              ! Unparenthesized 'a != "" && b == c' mis-groups and is ALWAYS true.
              if (svc) {
              if (svc.IsTypeOf(OT_ALARMDP) && (svc.AlState() == asOncoming)) {
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
                if ((wantId != "") && (sId == wantId)) { match = true; }
                if ((wantAddr != "") && (chAddr == wantAddr)) { match = true; }
                if (match) {
                  svc.AlReceipt();
                  if (!first) { Write(","); } first = false;
                  ! JSON-escape user-controlled names (backslash first, then quote)
                  dpName = dpName.Replace("\\\\", "\\\\\\\\");
                  dpName = dpName.Replace("\\"", "\\\\\\"");
                  Write('{"id":"' # sId # '","type":"' # dpName # '","address":"' # chAddr # '"}');
                }
              }
              }
            }
          }
          Write(']}');
        `;

        await rateLimiter.acquire();
        const result = await withRetry(
          () => session.call("ReGa.runScript", { script }, active.profile.ccu.scriptTimeout),
          "ReGa.runScript",
          logger,
          { rateLimiter },
        );

        const parsed = typeof result === "string" ? tryParseJson(result) : result;
        const isShapeOk = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
          && Array.isArray((parsed as Record<string, unknown>).confirmed));
        // Distinguish "script ran, nothing matched" (NOT_FOUND below) from
        // "script failed / output corrupted" — in the latter case AlReceipt may
        // or may not have run, so claiming NOT_FOUND would be a lie either way.
        if (!isShapeOk) {
          throw new CcuError({
            error: "CCU_ERROR",
            code: 0,
            message: "The CCU script for acknowledge_service_messages returned no parseable output",
            hint: "The ReGa engine failed or its output was corrupted; the acknowledgement may or may not have happened. Call get_service_messages to check the current state.",
          });
        }
        const confirmed = (parsed as Record<string, unknown>).confirmed as Array<Record<string, unknown>>;

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

        log({ count: confirmed.length });
        return toolResult({ confirmed, count: confirmed.length });
    }),
  );
}

function registerGetSystemInfo(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_system_info",
    {
      title: "Get System Info",
      description:
        "Get CCU system information: firmware version, serial number, addresses. Reports the active " +
        "login user and inferred role (ADMIN/USER) — note that version/serial/address are ADMIN-only " +
        "on the CCU, so they show \"N/A\" for a non-admin (USER) login. Also reports the running " +
        "server's build identification (git branch/commit/tag and build time) under `build`.",
      inputSchema: {
        target: z.string().optional().describe("CCU target to read from (default: active). See list_ccu_targets."),
      },
      outputSchema: {
        serverVersion: z.string().optional(),
        target: z.string().optional().describe("Active CCU target name"),
        user: z.string().optional().describe("Configured login user for the active target"),
        role: z.enum(["ADMIN", "USER", "UNKNOWN"]).optional()
          .describe("Access role inferred from which CCU methods answer: ADMIN if admin-only calls succeed, USER if logged in without admin rights, UNKNOWN if not connected"),
        version: z.unknown().optional().describe("Firmware version, or \"N/A\" if unavailable (ADMIN-only)"),
        serial: z.unknown().optional().describe("Serial number, or \"N/A\" if unavailable (ADMIN-only)"),
        address: z.unknown().optional().describe("BidCos address, or \"N/A\" if unavailable (ADMIN-only)"),
        hmipAddress: z.unknown().optional().describe("HmIP address, or \"N/A\" if unavailable (ADMIN-only)"),
        accessNote: z.string().optional().describe("Present when ADMIN-only fields are unavailable, explaining why"),
        cacheTypes: z.number().optional(),
        cacheWarming: z.boolean().optional(),
        build: z.object({
          branch: z.string().nullable().describe("Git branch (null if detached or not a git checkout)"),
          commit: z.string().nullable().describe("Short commit SHA"),
          tag: z.string().nullable().describe("Tag if HEAD is exactly on one, else null"),
          describe: z.string().nullable().describe("git describe --tags --dirty --always"),
          dirty: z.boolean().nullable().describe("true if the working tree had uncommitted changes at build time"),
          builtAt: z.string().nullable().describe("ISO timestamp of the build"),
        }).optional().describe("Build identification of the running server (stamped at build time)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => runTool("get_system_info", deps.logger, async () => {
      const { rateLimiter } = deps;
      const active = resolveTarget(deps.selection, args.target);
      const { session, deviceTypeCache } = active;
      const results: Record<string, unknown> = {
        serverVersion: VERSION,
        target: active.profile.name,
        user: active.profile.ccu.user,
      };

      // These four are LEVEL ADMIN on the CCU (verified in OCCU methods.conf),
      // so they only return real values for an admin session. We use that as a
      // capability probe: any non-empty result => the login has admin rights.
      const calls: Array<{ key: string; method: string }> = [
        { key: "version", method: "CCU.getVersion" },
        { key: "serial", method: "CCU.getSerial" },
        { key: "address", method: "CCU.getAddress" },
        { key: "hmipAddress", method: "CCU.getHmIPAddress" },
      ];

      let anyAdminOk = false;
      for (const { key, method } of calls) {
        try {
          await rateLimiter.acquire();
          const value = await session.call(method);
          if (value !== null && value !== undefined && value !== "") {
            results[key] = value;
            anyAdminOk = true;
          } else {
            results[key] = "N/A"; // empty/no value rather than null
          }
        } catch {
          results[key] = "N/A"; // permission denied or call failed
        }
      }

      // Infer role: admin-only calls answered => ADMIN; otherwise logged in but
      // without those rights => USER; not logged in / unreachable => UNKNOWN.
      const loggedIn = active.session.isLoggedIn();
      results.role = anyAdminOk ? "ADMIN" : (loggedIn ? "USER" : "UNKNOWN");
      if (!anyAdminOk && loggedIn) {
        results.accessNote =
          `Firmware version, serial and addresses are ADMIN-only on the CCU; ` +
          `'${active.profile.ccu.user}' is a non-admin (USER) login, so those show "N/A". ` +
          `Use an ADMIN account to see them.`;
      }

      results.cacheTypes = deviceTypeCache.size();
      results.cacheWarming = deviceTypeCache.isWarming();
      results.build = loadBuildInfo();

      return structuredResult(results as Record<string, unknown>);
    }),
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
        target: z.string().optional().describe("CCU target to read from (default: active). See list_ccu_targets."),
      },
      outputSchema: {
        devices: z.array(z.unknown()).describe("Per device: {address, name, interface, links:[{peer, rssiDevice, rssiPeer}]}"),
        interfaces: z.unknown().describe("BidCos interface health (duty cycle, connected)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => runTool("get_rssi", deps.logger, async (log) => {
      const { rateLimiter, logger } = deps;
      const { session, resolver } = resolveTarget(deps.selection, args.target);
        // Device list → address→{name,interface}. Same call list_devices uses;
        // also refresh the resolver so later interface lookups are warm.
        await rateLimiter.acquire();
        const devices = await withRetry(
          () => session.call("Device.listAllDetail"),
          "Device.listAllDetail",
          logger,
          { rateLimiter },
        ) as CcuDevice[];
        resolver.updateDeviceList(devices);
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
          { rateLimiter },
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
              { rateLimiter },
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
              { rateLimiter },
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
            { rateLimiter },
          );
        } catch {
          bidcosInterfaces = [];
        }

        log({ devices: deviceEntries.length });
        return structuredResult({ devices: deviceEntries, interfaces: bidcosInterfaces });
    }),
  );
}

// tryParseJson re-exported from utils for backward compatibility with tests
export { tryParseJson } from "../utils.js";
