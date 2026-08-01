import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Logger } from "../../src/logger.js";
import { Resolver } from "../../src/middleware/resolver.js";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { RateLimiter } from "../../src/middleware/rate-limiter.js";
import type { SessionManager } from "../../src/ccu/session.js";
import type { CcuDevice } from "../../src/ccu/types.js";

/**
 * One defect class, four sites. Building a plain object with `obj[key] = …`
 * where `key` comes from outside routes a "__proto__" key through
 * Object.prototype's setter instead of creating an own property, so the field
 * silently disappears; reading back with `obj[key]` walks the prototype chain,
 * so a key like "constructor" resolves to something truthy that was never
 * stored.
 *
 * Found in parseValues by property testing (see utils-properties.test.ts), then
 * swept for across the tree. None of these was exploitable — the values are
 * CCU- or caller-supplied but the shapes are implausible in practice — so these
 * tests pin behaviour rather than guard an attack.
 */

const logger = new Logger("error");

describe("logger redaction keeps prototype-named keys", () => {
  it("does not silently drop a __proto__ field from the log line", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => {
      lines.push(s);
      return true;
    }) as typeof process.stderr.write);
    try {
      new Logger("debug").info("test", {
        ["__proto__"]: "must-survive",
        password: "hunter2",
        keep: "yes",
      });
    } finally {
      spy.mockRestore();
    }

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    // The field used to vanish entirely.
    expect(Object.keys(entry)).toContain("__proto__");
    expect(entry["__proto__"]).toBe("must-survive");
    // Redaction was never affected by the bug and must stay that way.
    expect(entry.password).toBe("[REDACTED]");
    expect(entry.keep).toBe("yes");
  });
});

describe("device type cache keeps prototype-named CCU keys", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccu-mcp-proto-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fakeSession(handlers: Record<string, (params?: never) => unknown>): SessionManager {
    return {
      call: async (method: string, params?: never) => {
        const h = handlers[method];
        if (!h) throw new Error(`unexpected CCU call: ${method}`);
        return h(params);
      },
    } as unknown as SessionManager;
  }

  it("keeps a parameter the CCU named __proto__", async () => {
    const session = fakeSession({
      "Interface.listInterfaces": () => [{ name: "HmIP-RF" }],
      "Interface.listDevices": () => [
        { type: "HmIP-eTRV-2", address: "0001", children: ["0001:1"] },
      ],
      "Interface.getParamsetDescription": () => [
        { ID: "__proto__", TYPE: "FLOAT", OPERATIONS: "7" },
        { ID: "LEVEL", TYPE: "FLOAT", OPERATIONS: "7" },
      ],
    });

    const cache = new DeviceTypeCache(dir, 86400, logger);
    await cache.warm(session, new RateLimiter(1000, 1000));

    const params = cache.get("HmIP-eTRV-2")?.channels["1"]?.paramsets.VALUES;
    expect(Object.keys(params ?? {}).sort()).toEqual(["LEVEL", "__proto__"]);
  });

  it("keeps a channel whose index is __proto__", async () => {
    const session = fakeSession({
      "Interface.listInterfaces": () => [{ name: "HmIP-RF" }],
      "Interface.listDevices": () => [
        { type: "WEIRD-DEV", address: "0001", children: ["0001:__proto__"] },
      ],
      "Interface.getParamsetDescription": () => [
        { ID: "LEVEL", TYPE: "FLOAT", OPERATIONS: "7" },
      ],
    });

    const cache = new DeviceTypeCache(dir, 86400, logger);
    await cache.warm(session, new RateLimiter(1000, 1000));

    const channels = cache.get("WEIRD-DEV")?.channels ?? {};
    // The whole channel used to vanish from the cached type.
    expect(Object.keys(channels)).toContain("__proto__");
    expect(Object.getPrototypeOf(channels)).toBe(Object.prototype);
  });
});

describe("resolver indexes only own properties", () => {
  const devices: CcuDevice[] = [
    {
      id: "1",
      name: "Dev",
      address: "000A1BE9A71F15",
      interface: "HmIP-RF",
      type: "HmIP-eTRV-2",
      operateGroupOnly: "false",
      isReady: "true",
      channels: [],
    } as unknown as CcuDevice,
  ];

  function cacheWithChannel(): DeviceTypeCache {
    const cache = new DeviceTypeCache("/tmp", 86400, logger);
    (cache as unknown as { cache: Map<string, unknown> }).cache.set("HmIP-eTRV-2", {
      interface: "HmIP-RF",
      channels: {
        "0": {
          type: "HEATING",
          paramsets: { VALUES: { LEVEL: { type: "FLOAT", operations: 7 } } },
        },
      },
    });
    return cache;
  }

  let resolver: Resolver;
  beforeEach(() => {
    resolver = new Resolver();
    resolver.updateDeviceList(devices);
  });

  it("treats a trailing-colon address as channel 0, matching DeviceTypeCache", () => {
    // Was "" — no channel matched, and the type silently degraded to inferred.
    expect(resolver.resolveType("000A1BE9A71F15:", "LEVEL", cacheWithChannel())).toBe("double");
    expect(resolver.resolveType("000A1BE9A71F15", "LEVEL", cacheWithChannel())).toBe("double");
  });

  it("does not resolve a channel index that only exists on Object.prototype", () => {
    for (const idx of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(
        resolver.resolveRawParamType(`000A1BE9A71F15:${idx}`, "LEVEL", cacheWithChannel()),
      ).toBeUndefined();
    }
  });

  it("does not resolve a parameter name that only exists on Object.prototype", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(
        resolver.resolveRawParamType("000A1BE9A71F15:0", key, cacheWithChannel()),
      ).toBeUndefined();
    }
  });

  it("does not resolve a paramset key that only exists on Object.prototype", () => {
    expect(
      resolver.resolveRawParamType("000A1BE9A71F15:0", "LEVEL", cacheWithChannel(), "constructor"),
    ).toBeUndefined();
  });

  it("still resolves the real parameter", () => {
    expect(resolver.resolveRawParamType("000A1BE9A71F15:0", "LEVEL", cacheWithChannel())).toBe(
      "FLOAT",
    );
  });
});
