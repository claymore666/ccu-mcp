import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SessionManager } from "../../src/ccu/session.js";
import { DeviceTypeCache } from "../../src/cache/device-type-cache.js";
import { RateLimiter } from "../../src/middleware/rate-limiter.js";
import { createLogger } from "../../src/logger.js";
import { Resolver } from "../../src/middleware/resolver.js";
import type { CcuConfig, CcuDevice } from "../../src/ccu/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CCU_HOST = process.env.CCU_HOST;
const describeIf = CCU_HOST ? describe : describe.skip;

describeIf("CCU Integration (against debmatic)", () => {
  const config: CcuConfig = {
    host: CCU_HOST!,
    port: parseInt(process.env.CCU_PORT || "80", 10),
    https: process.env.CCU_HTTPS === "true",
    tlsVerify: process.env.CCU_TLS_VERIFY === "true",
    user: process.env.CCU_USER || "Admin",
    password: process.env.CCU_PASSWORD || "",
    timeout: 10_000,
    scriptTimeout: 30_000,
  };

  const logger = createLogger();
  let session: SessionManager;
  let tempDir: string;

  beforeAll(async () => {
    session = new SessionManager(config, logger);
    await session.login();
    tempDir = await mkdtemp(join(tmpdir(), "debmatic-integ-"));
  });

  afterAll(async () => {
    await session.logout();
    session.destroy();
    await rm(tempDir, { recursive: true, force: true });
  });

  // === Session ===

  it("Session.login succeeds", () => {
    expect(session.isLoggedIn()).toBe(true);
  });

  // === Device listing ===

  it("Device.listAllDetail returns devices with expected shape", async () => {
    const devices = await session.call("Device.listAllDetail") as CcuDevice[];
    expect(Array.isArray(devices)).toBe(true);
    expect(devices.length).toBeGreaterThan(0);

    const device = devices[0]!;
    expect(device).toHaveProperty("id");
    expect(device).toHaveProperty("name");
    expect(device).toHaveProperty("address");
    expect(device).toHaveProperty("interface");
    expect(device).toHaveProperty("type");
    expect(device).toHaveProperty("channels");
  });

  // === Interfaces ===

  it("Interface.listInterfaces returns interfaces", async () => {
    const interfaces = await session.call("Interface.listInterfaces") as Array<{ name: string }>;
    expect(Array.isArray(interfaces)).toBe(true);
    expect(interfaces.length).toBeGreaterThan(0);
  });

  // === Rooms & Functions ===

  it("Room.getAll returns array", async () => {
    const rooms = await session.call("Room.getAll") as Array<{ id: string; name: string }>;
    expect(Array.isArray(rooms)).toBe(true);
    // Verify rooms have expected shape if any exist
    if (rooms.length > 0) {
      expect(rooms[0]).toHaveProperty("id");
      expect(rooms[0]).toHaveProperty("name");
    }
  });

  it("Subsection.getAll returns array", async () => {
    const functions = await session.call("Subsection.getAll") as Array<{ id: string; name: string }>;
    expect(Array.isArray(functions)).toBe(true);
  });

  // === Programs & SysVars ===

  it("Program.getAll returns array", async () => {
    const programs = await session.call("Program.getAll") as Array<{ id: string; name: string }>;
    expect(Array.isArray(programs)).toBe(true);
  });

  it("SysVar.getAll returns array", async () => {
    const sysvars = await session.call("SysVar.getAll") as Array<{ id: string; name: string }>;
    expect(Array.isArray(sysvars)).toBe(true);
  });

  // === getValue ===

  it("Interface.getValue reads a thermostat temperature", async () => {
    const devices = await session.call("Device.listAllDetail") as CcuDevice[];
    const thermostat = devices.find((d) => d.type.startsWith("HmIP-eTRV"));
    if (!thermostat) { console.log("No thermostat found, skipping"); return; }

    const value = await session.call("Interface.getValue", {
      interface: thermostat.interface,
      address: thermostat.address + ":1",
      valueKey: "ACTUAL_TEMPERATURE",
    });

    const numValue = Number(value);
    expect(isNaN(numValue)).toBe(false);
    expect(numValue).toBeGreaterThan(-10);
    expect(numValue).toBeLessThan(50);
  });

  // === Paramset Description ===

  it("Interface.getParamsetDescription returns array of param descriptions", async () => {
    const devices = await session.call("Device.listAllDetail") as CcuDevice[];
    const device = devices.find((d) => d.interface === "HmIP-RF" && d.channels.length > 1);
    if (!device) { console.log("No HmIP device found, skipping"); return; }

    const desc = await session.call("Interface.getParamsetDescription", {
      interface: device.interface,
      address: device.channels[0]!.address,
      paramsetKey: "VALUES",
    });

    expect(Array.isArray(desc)).toBe(true);
    const params = desc as Array<{ ID: string; TYPE: string; OPERATIONS: string }>;
    if (params.length > 0) {
      expect(params[0]).toHaveProperty("ID");
      expect(params[0]).toHaveProperty("TYPE");
      expect(params[0]).toHaveProperty("OPERATIONS");
    }
  });

  // === System ===

  it("CCU.getVersion returns firmware version", async () => {
    const version = await session.call("CCU.getVersion");
    expect(typeof version).toBe("string");
    expect((version as string).length).toBeGreaterThan(0);
  });

  // === ReGa Script ===

  it("ReGa.runScript executes and returns output", async () => {
    const result = await session.call("ReGa.runScript", {
      script: 'Write("hello from ReGa");',
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("hello from ReGa");
  });

  // === Device Type Cache Warming ===

  it("device type cache warms against real CCU", async () => {
    const cache = new DeviceTypeCache(tempDir, 86400, logger);
    const rateLimiter = new RateLimiter(20, 10);

    await cache.warm(session, rateLimiter);

    expect(cache.size()).toBeGreaterThan(0);
    expect(cache.isWarming()).toBe(false);

    // Verify cache file was written
    const { readFile } = await import("node:fs/promises");
    const fileContent = await readFile(join(tempDir, "device-type-cache.json"), "utf-8");
    const parsed = JSON.parse(fileContent);
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.types).length).toBeGreaterThan(0);

    // Spot check a known device type
    const types = Object.keys(parsed.types);
    const firstType = cache.get(types[0]!)!;
    expect(firstType).toHaveProperty("interface");
    expect(firstType).toHaveProperty("channels");
    expect(Object.keys(firstType.channels).length).toBeGreaterThan(0);

    rateLimiter.destroy();
  }, 120_000); // Allow up to 2 minutes for warming

  // === Resolver with real data ===

  it("resolver populates from Device.listAllDetail", async () => {
    const devices = await session.call("Device.listAllDetail") as CcuDevice[];
    const resolver = new Resolver();
    resolver.updateDeviceList(devices);

    // First device should resolve
    const type = resolver.getDeviceType(devices[0]!.address);
    expect(type).toBe(devices[0]!.type);
  });

  // === Interface.getParamset (read full paramset) ===

  it("Interface.getParamset reads VALUES for a thermostat channel", async () => {
    const devices = await session.call("Device.listAllDetail") as CcuDevice[];
    const thermostat = devices.find((d) => d.type.startsWith("HmIP-eTRV"));
    if (!thermostat) { console.log("No thermostat found, skipping"); return; }

    const paramset = await session.call("Interface.getParamset", {
      interface: thermostat.interface,
      address: thermostat.address + ":1",
      paramsetKey: "VALUES",
    });

    expect(paramset).toBeDefined();
    // Should be an array of key-value pairs or an object
    expect(typeof paramset === "object").toBe(true);
  });
});
