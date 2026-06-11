import { describe, it, expect, beforeEach } from "vitest";
import { Resolver } from "../../src/middleware/resolver.js";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { Logger } from "../../src/logger.js";
import type { CcuDevice } from "../../src/ccu/types.js";

const logger = new Logger("error");

const mockDevices: CcuDevice[] = [
  {
    id: "1", name: "Thermostat Wohnzimmer", address: "000A1BE9A71F15",
    interface: "HmIP-RF", type: "HmIP-eTRV-2", operateGroupOnly: "false", isReady: "true",
    channels: [
      { id: "10", name: "Ch0", address: "000A1BE9A71F15:0", deviceId: "1", index: 0,
        partnerId: "", mode: "", category: "", isReady: true, isUsable: true, isVisible: true,
        isLogged: false, isLogable: false, isReadable: true, isWritable: false, isEventable: true,
        isAesAvailable: false, isVirtual: false, channelType: "MAINTENANCE" },
      { id: "11", name: "Ch1", address: "000A1BE9A71F15:1", deviceId: "1", index: 1,
        partnerId: "", mode: "", category: "", isReady: true, isUsable: true, isVisible: true,
        isLogged: false, isLogable: true, isReadable: true, isWritable: true, isEventable: true,
        isAesAvailable: false, isVirtual: false, channelType: "HEATING_CLIMATECONTROL_TRANSCEIVER" },
    ],
  },
  {
    id: "2", name: "Fensterkontakt", address: "00109D898C36B0",
    interface: "HmIP-RF", type: "HmIP-SWDO-I", operateGroupOnly: "false", isReady: "true",
    channels: [],
  },
];

describe("Resolver", () => {
  let resolver: Resolver;

  beforeEach(() => {
    resolver = new Resolver();
  });

  describe("updateDeviceList + getDeviceType", () => {
    it("resolves device type from address", () => {
      resolver.updateDeviceList(mockDevices);
      expect(resolver.getDeviceType("000A1BE9A71F15")).toBe("HmIP-eTRV-2");
      expect(resolver.getDeviceType("00109D898C36B0")).toBe("HmIP-SWDO-I");
    });

    it("returns undefined for unknown address", () => {
      resolver.updateDeviceList(mockDevices);
      expect(resolver.getDeviceType("UNKNOWN")).toBeUndefined();
    });
  });

  describe("getDeviceList", () => {
    it("returns null before population", () => {
      expect(resolver.getDeviceList()).toBeNull();
    });

    it("returns devices after population", () => {
      resolver.updateDeviceList(mockDevices);
      expect(resolver.getDeviceList()!.length).toBe(2);
    });
  });

  describe("resolveType", () => {
    it("resolves FLOAT to double", () => {
      resolver.updateDeviceList(mockDevices);
      const cache = new DeviceTypeCache("/tmp", 86400, logger);
      (cache as any).cache.set("HmIP-eTRV-2", {
        interface: "HmIP-RF",
        channels: {
          "1": {
            type: "HEATING",
            paramsets: {
              VALUES: {
                SET_POINT_TEMPERATURE: { type: "FLOAT", operations: 7 },
                ACTUAL_TEMPERATURE: { type: "FLOAT", operations: 5 },
              },
            },
          },
        },
      });

      expect(resolver.resolveType("000A1BE9A71F15:1", "SET_POINT_TEMPERATURE", cache)).toBe("double");
      expect(resolver.resolveType("000A1BE9A71F15:1", "ACTUAL_TEMPERATURE", cache)).toBe("double");
    });

    it("resolves BOOL to bool", () => {
      resolver.updateDeviceList(mockDevices);
      const cache = new DeviceTypeCache("/tmp", 86400, logger);
      (cache as any).cache.set("HmIP-eTRV-2", {
        interface: "HmIP-RF",
        channels: {
          "0": {
            type: "MAINTENANCE",
            paramsets: { VALUES: { LOWBAT: { type: "BOOL", operations: 5 } } },
          },
        },
      });

      expect(resolver.resolveType("000A1BE9A71F15:0", "LOWBAT", cache)).toBe("bool");
    });

    it("resolves INTEGER to int", () => {
      resolver.updateDeviceList(mockDevices);
      const cache = new DeviceTypeCache("/tmp", 86400, logger);
      (cache as any).cache.set("HmIP-eTRV-2", {
        interface: "HmIP-RF",
        channels: {
          "1": { type: "HEATING", paramsets: { VALUES: { BOOST_TIME: { type: "INTEGER", operations: 5 } } } },
        },
      });

      expect(resolver.resolveType("000A1BE9A71F15:1", "BOOST_TIME", cache)).toBe("int");
    });

    it("resolves ENUM to int", () => {
      resolver.updateDeviceList(mockDevices);
      const cache = new DeviceTypeCache("/tmp", 86400, logger);
      (cache as any).cache.set("HmIP-eTRV-2", {
        interface: "HmIP-RF",
        channels: {
          "1": { type: "HEATING", paramsets: { VALUES: { CONTROL_MODE: { type: "ENUM", operations: 7 } } } },
        },
      });

      expect(resolver.resolveType("000A1BE9A71F15:1", "CONTROL_MODE", cache)).toBe("int");
    });

    it("returns undefined for unknown device type", () => {
      resolver.updateDeviceList(mockDevices);
      const cache = new DeviceTypeCache("/tmp", 86400, logger);
      expect(resolver.resolveType("000A1BE9A71F15:1", "SOMETHING", cache)).toBeUndefined();
    });

    it("returns undefined when resolver not populated", () => {
      const cache = new DeviceTypeCache("/tmp", 86400, logger);
      expect(resolver.resolveType("UNKNOWN:1", "STATE", cache)).toBeUndefined();
    });
  });

  describe("resolveInterface", () => {
    // Regression: concurrent cold-cache resolutions duplicated Device.listAllDetail (issue #11)
    it("coalesces concurrent device list refreshes", async () => {
      let listCalls = 0;
      const session = {
        call: async () => {
          listCalls++;
          await new Promise((r) => setTimeout(r, 5));
          return mockDevices;
        },
      } as any;
      const rateLimiter = { acquire: async () => {} } as any;

      const [a, b] = await Promise.all([
        resolver.resolveInterface("000A1BE9A71F15:1", session, rateLimiter, logger),
        resolver.resolveInterface("00109D898C36B0", session, rateLimiter, logger),
      ]);

      expect(a).toBe("HmIP-RF");
      expect(b).toBe("HmIP-RF");
      expect(listCalls).toBe(1);
    });
  });
});

describe("resolveInterface failure (coverage round)", () => {
  it("throws NOT_FOUND when the address is unknown even after refresh", async () => {
    const { CcuError } = await import("../../src/middleware/error-mapper.js");
    const resolver = new Resolver();
    const session = { call: async () => mockDevices } as any;
    const rateLimiter = { acquire: async () => {} } as any;

    await expect(resolver.resolveInterface("DOES-NOT-EXIST:1", session, rateLimiter, logger))
      .rejects.toSatisfy((e: unknown) => e instanceof CcuError && (e as any).structured.error === "NOT_FOUND");
  });
});
