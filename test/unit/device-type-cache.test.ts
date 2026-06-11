import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { Logger } from "../../src/logger.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DeviceTypeCacheFile } from "../../src/cache/types.js";
import { CACHE_VERSION } from "../../src/cache/types.js";

const logger = new Logger("error");

describe("DeviceTypeCache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "debmatic-cache-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    expect(cache.size()).toBe(0);
    expect(cache.has("HmIP-eTRV-2")).toBe(false);
    expect(cache.get("HmIP-eTRV-2")).toBeUndefined();
  });

  it("loadFromDisk returns false for missing file", async () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    expect(await cache.loadFromDisk()).toBe(false);
  });

  it("saves and loads cache to/from disk", async () => {
    const cache1 = new DeviceTypeCache(tempDir, 86400, logger);

    // Manually populate cache via the internal Map (simulating warm)
    const testType = {
      interface: "HmIP-RF",
      channels: {
        "1": {
          type: "HEATING",
          paramsets: {
            VALUES: {
              ACTUAL_TEMPERATURE: { type: "FLOAT", operations: 5 },
            },
          },
        },
      },
    };

    // Use queryAndCache-like approach — set directly for test
    (cache1 as any).cache.set("HmIP-eTRV-2", testType);
    await cache1.saveToDisk();

    // Load in a new instance
    const cache2 = new DeviceTypeCache(tempDir, 86400, logger);
    const valid = await cache2.loadFromDisk();

    expect(valid).toBe(true);
    expect(cache2.size()).toBe(1);
    expect(cache2.has("HmIP-eTRV-2")).toBe(true);
    expect(cache2.get("HmIP-eTRV-2")!.interface).toBe("HmIP-RF");
    expect(cache2.get("HmIP-eTRV-2")!.channels["1"]!.paramsets.VALUES!.ACTUAL_TEMPERATURE.type).toBe("FLOAT");
  });

  it("returns false for expired cache", async () => {
    const cacheFile: DeviceTypeCacheFile = {
      version: CACHE_VERSION,
      timestamp: new Date(Date.now() - 100_000 * 1000).toISOString(), // 100k seconds ago
      ttl: 86400,
      types: { "HmIP-TEST": { interface: "HmIP-RF", channels: {} } },
    };
    await writeFile(join(tempDir, "device-type-cache.json"), JSON.stringify(cacheFile));

    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    const valid = await cache.loadFromDisk();

    expect(valid).toBe(false);
    // But data should still be loaded (serve stale)
    expect(cache.size()).toBe(1);
    expect(cache.has("HmIP-TEST")).toBe(true);
  });

  it("returns false for wrong version", async () => {
    const cacheFile = {
      version: 999,
      timestamp: new Date().toISOString(),
      ttl: 86400,
      types: { "HmIP-TEST": { interface: "HmIP-RF", channels: {} } },
    };
    await writeFile(join(tempDir, "device-type-cache.json"), JSON.stringify(cacheFile));

    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    const valid = await cache.loadFromDisk();

    expect(valid).toBe(false);
    expect(cache.size()).toBe(0); // Wrong version = don't load
  });

  it("handles corrupt cache file gracefully", async () => {
    await writeFile(join(tempDir, "device-type-cache.json"), "not valid json{{{");

    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    const valid = await cache.loadFromDisk();

    expect(valid).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("getAll returns all types as object", async () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    (cache as any).cache.set("TypeA", { interface: "A", channels: {} });
    (cache as any).cache.set("TypeB", { interface: "B", channels: {} });

    const all = cache.getAll();
    expect(Object.keys(all)).toEqual(["TypeA", "TypeB"]);
  });

  it("atomic write leaves no .tmp file on success", async () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    (cache as any).cache.set("Test", { interface: "RF", channels: {} });
    await cache.saveToDisk();

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(tempDir);
    expect(files).toContain("device-type-cache.json");
    expect(files).not.toContain("device-type-cache.json.tmp");
  });

  // Regression: concurrent live queries for the same type were duplicated (issue #11)
  it("coalesces concurrent queryAndCache calls for the same type", async () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    let calls = 0;
    const session = {
      call: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return [];
      },
    } as any;
    const rateLimiter = { acquire: async () => {} } as any;

    const [a, b] = await Promise.all([
      cache.queryAndCache("HmIP-X", "ADDR", "HmIP-RF", ["ADDR:1"], session, rateLimiter),
      cache.queryAndCache("HmIP-X", "ADDR", "HmIP-RF", ["ADDR:1"], session, rateLimiter),
    ]);

    // 1 channel × 2 paramset keys = 2 CCU calls if coalesced, 4 if duplicated
    expect(calls).toBe(2);
    expect(a).toBe(b);

    // let the fire-and-forget saveToDisk finish before afterEach removes tempDir
    await new Promise((r) => setTimeout(r, 25));
  });

  // Issue #12: warming processes device types with bounded concurrency
  it("warm populates the cache for all device types", async () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    const session = {
      call: async (method: string) => {
        if (method === "Interface.listInterfaces") return [{ name: "HmIP-RF" }];
        if (method === "Interface.listDevices") return [
          { type: "HmIP-A", address: "A1", children: ["A1:1"] },
          { type: "HmIP-B", address: "B1", children: ["B1:1"] },
          { type: "HmIP-C", address: "C1", children: ["C1:1"] },
          { type: "HmIP-D", address: "D1", children: ["D1:1"] },
        ];
        if (method === "Interface.getParamsetDescription") {
          return [{ ID: "STATE", TYPE: "BOOL", OPERATIONS: "7" }];
        }
        return null;
      },
    } as any;
    const rateLimiter = { acquire: async () => {} } as any;

    await cache.warm(session, rateLimiter);

    expect(cache.size()).toBe(4);
    expect(cache.get("HmIP-A")!.channels["1"]!.paramsets["VALUES"]!["STATE"]!.type).toBe("BOOL");
  });

  it("isWarming returns false by default", () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    expect(cache.isWarming()).toBe(false);
  });
});

describe("warm edge cases (coverage round)", () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "debmatic-cache-test2-")); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it("skips interfaces whose device listing fails and continues with the rest", async () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    const session = {
      call: async (method: string, params?: { interface?: string }) => {
        if (method === "Interface.listInterfaces") return [{ name: "Broken" }, { name: "HmIP-RF" }];
        if (method === "Interface.listDevices") {
          if (params?.interface === "Broken") throw new Error("interface down");
          return [{ type: "HmIP-A", address: "A1", children: ["A1:1"] }];
        }
        if (method === "Interface.getParamsetDescription") {
          return [{ ID: "STATE", TYPE: "BOOL", OPERATIONS: "7" }];
        }
        return null;
      },
    } as any;
    const rateLimiter = { acquire: async () => {} } as any;

    await cache.warm(session, rateLimiter);
    expect(cache.size()).toBe(1);
  });

  it("preserves optional param description fields (min/max/unit/valueList)", async () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    const session = {
      call: async (method: string, params?: { paramsetKey?: string }) => {
        if (method === "Interface.getParamsetDescription" && params?.paramsetKey === "VALUES") {
          return [{ ID: "LEVEL", TYPE: "FLOAT", OPERATIONS: "7", MIN: "0", MAX: "1.01", DEFAULT: "0", UNIT: "%", VALUE_LIST: ["a", "b"] }];
        }
        return [];
      },
    } as any;
    const rateLimiter = { acquire: async () => {} } as any;

    const cached = await cache.queryAndCache("HmIP-X", "A1", "HmIP-RF", ["A1:1"], session, rateLimiter);
    const param = cached!.channels["1"]!.paramsets["VALUES"]!["LEVEL"]!;
    expect(param).toMatchObject({ type: "FLOAT", operations: 7, min: 0, max: 1.01, unit: "%", valueList: ["a", "b"] });
    await new Promise((r) => setTimeout(r, 25)); // let background save finish
  });
});
