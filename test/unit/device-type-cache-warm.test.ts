import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { Logger } from "../../src/logger.js";
import { RateLimiter } from "../../src/middleware/rate-limiter.js";
import type { SessionManager } from "../../src/ccu/session.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Covers the warm/parse half of DeviceTypeCache, which the existing suite
// leaves out: the TCL VALUE_LIST tokenizer, the device/channel filtering, and
// the failure paths that must degrade instead of aborting a warm run.

const logger = new Logger("error");

/** A SessionManager stand-in driven by a per-method script. */
function fakeSession(handlers: Record<string, (params?: any) => unknown>): SessionManager {
  return {
    call: async (method: string, params?: any) => {
      const h = handlers[method];
      if (!h) throw new Error(`unexpected CCU call: ${method}`);
      return h(params);
    },
  } as unknown as SessionManager;
}

/** Fast limiter — these tests care about logic, not pacing. */
function limiter(): RateLimiter {
  return new RateLimiter(1000, 1000);
}

const ETRV_DESC = [
  { ID: "SET_POINT_TEMPERATURE", TYPE: "FLOAT", OPERATIONS: "7", MIN: "4.5", MAX: "30.5", UNIT: "°C" },
];

describe("DeviceTypeCache.warm", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccu-mcp-warm-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("caches one entry per device type and skips channels", async () => {
    const session = fakeSession({
      "Interface.listInterfaces": () => [{ name: "HmIP-RF" }],
      "Interface.listDevices": () => [
        { type: "HmIP-eTRV-2", address: "0001", children: ["0001:1"] },
        // Same type again — must be deduplicated, not re-queried.
        { type: "HmIP-eTRV-2", address: "0002", children: ["0002:1"] },
        // A channel (no children) — must be skipped entirely.
        { type: "MAINTENANCE", address: "0001:0", parent: "0001" },
      ],
      "Interface.getParamsetDescription": () => ETRV_DESC,
    });

    const cache = new DeviceTypeCache(dir, 86400, logger);
    await cache.warm(session, limiter());

    expect(cache.size()).toBe(1);
    expect(cache.has("HmIP-eTRV-2")).toBe(true);
    expect(cache.has("MAINTENANCE")).toBe(false);
    expect(cache.get("HmIP-eTRV-2")?.interface).toBe("HmIP-RF");
  });

  it("skips an interface whose device listing fails and keeps the rest", async () => {
    const session = fakeSession({
      "Interface.listInterfaces": () => [{ name: "BidCos-RF" }, { name: "HmIP-RF" }],
      "Interface.listDevices": (p: { interface: string }) => {
        if (p.interface === "BidCos-RF") throw new Error("interface down");
        return [{ type: "HmIP-eTRV-2", address: "0001", children: ["0001:1"] }];
      },
      "Interface.getParamsetDescription": () => ETRV_DESC,
    });

    const cache = new DeviceTypeCache(dir, 86400, logger);
    await cache.warm(session, limiter());

    // One bad interface must not abort the whole warm run.
    expect(cache.has("HmIP-eTRV-2")).toBe(true);
  });

  it("keeps a device type whose paramset query fails, minus the failed paramset", async () => {
    const session = fakeSession({
      "Interface.listInterfaces": () => [{ name: "HmIP-RF" }],
      "Interface.listDevices": () => [{ type: "HmIP-eTRV-2", address: "0001", children: ["0001:1"] }],
      "Interface.getParamsetDescription": (p: { paramsetKey: string }) => {
        // Many channels don't implement MASTER — that is normal, not an error.
        if (p.paramsetKey === "MASTER") throw new Error("no such paramset");
        return ETRV_DESC;
      },
    });

    const cache = new DeviceTypeCache(dir, 86400, logger);
    await cache.warm(session, limiter());

    const channel = cache.get("HmIP-eTRV-2")?.channels["1"];
    expect(channel?.paramsets.VALUES).toBeDefined();
    expect(channel?.paramsets.MASTER).toBeUndefined();
  });

  it("does not start a second warm run while one is in flight", async () => {
    let listCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const session = fakeSession({
      "Interface.listInterfaces": async () => { listCalls++; await gate; return []; },
    });

    const cache = new DeviceTypeCache(dir, 86400, logger);
    const first = cache.warm(session, limiter());
    expect(cache.isWarming()).toBe(true);

    // Second call must return immediately instead of duplicating CCU load.
    await cache.warm(session, limiter());
    expect(listCalls).toBe(1);

    release();
    await first;
    expect(cache.isWarming()).toBe(false);
  });

  describe("VALUE_LIST parsing (TCL list from getparamsetdescription.tcl)", () => {
    async function valueListFor(raw: unknown): Promise<string[] | undefined> {
      const session = fakeSession({
        "Interface.listInterfaces": () => [{ name: "HmIP-RF" }],
        "Interface.listDevices": () => [{ type: "T", address: "0001", children: ["0001:1"] }],
        "Interface.getParamsetDescription": (p: { paramsetKey: string }) =>
          p.paramsetKey === "VALUES"
            ? [{ ID: "MODE", TYPE: "ENUM", OPERATIONS: "7", VALUE_LIST: raw }]
            : [],
      });
      const cache = new DeviceTypeCache(dir, 86400, logger);
      await cache.warm(session, limiter());
      return cache.get("T")?.channels["1"].paramsets.VALUES?.MODE.valueList;
    }

    it("passes a real array through untouched", async () => {
      expect(await valueListFor(["AUTO", "MANU"])).toEqual(["AUTO", "MANU"]);
    });

    it("splits a plain space-joined string", async () => {
      expect(await valueListFor("AUTO MANU BOOST")).toEqual(["AUTO", "MANU", "BOOST"]);
    });

    it("keeps brace-wrapped entries that contain spaces as one label", async () => {
      // The case the tokenizer exists for: enum indexes must line up with the
      // real value list, so '{Party Mode}' is ONE entry, not two.
      expect(await valueListFor("{Party Mode} Off {Boost Mode}")).toEqual([
        "Party Mode", "Off", "Boost Mode",
      ]);
    });

    it("handles nested braces and collapses runs of spaces", async () => {
      expect(await valueListFor("  {outer {inner} tail}   plain  ")).toEqual([
        "outer {inner} tail", "plain",
      ]);
    });

    it("does not hang or drop data on an unterminated brace", async () => {
      expect(await valueListFor("{never closed")).toEqual(["never closed"]);
    });
  });
});

describe("DeviceTypeCache.saveToDisk failure handling", () => {
  it("logs instead of throwing when the cache dir cannot be written", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ccu-mcp-save-"));
    // A file where the cache dir should be: mkdir fails with ENOTDIR for any
    // user, unlike chmod 000 which root ignores.
    const blocked = join(parent, "not-a-dir");
    await writeFile(blocked, "", "utf-8");

    const errors: string[] = [];
    const noisy = new Logger("error");
    vi.spyOn(noisy, "error").mockImplementation((msg: string) => { errors.push(msg); });

    const cache = new DeviceTypeCache(blocked, 86400, noisy);
    // Must resolve: a save failure is logged, never propagated into shutdown.
    await expect(cache.saveToDisk()).resolves.toBeUndefined();
    expect(errors).toContain("cache_save_failed");

    vi.restoreAllMocks();
    await rm(parent, { recursive: true, force: true });
  });
});
