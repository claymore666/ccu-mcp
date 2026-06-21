import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionManager } from "../ccu/session.js";
import type { RateLimiter } from "../middleware/rate-limiter.js";
import type { Logger } from "../logger.js";
import type { CachedDeviceType, CachedParamDescription, DeviceTypeCacheFile } from "./types.js";
import { CACHE_VERSION } from "./types.js";

const DEFAULT_CACHE_FILENAME = "device-type-cache.json";

// Device types warmed in parallel; per-request pacing stays with the rate limiter
const WARM_CONCURRENCY = 3;

type RawParamDesc = {
  ID: string; TYPE: string; OPERATIONS: string;
  MIN?: string; MAX?: string; DEFAULT?: string; UNIT?: string; VALUE_LIST?: string[];
};

function parseParamDescriptions(descArray: RawParamDesc[]): Record<string, CachedParamDescription> {
  const params: Record<string, CachedParamDescription> = {};
  for (const p of descArray) {
    params[p.ID] = {
      type: p.TYPE,
      operations: parseInt(p.OPERATIONS, 10),
      ...(p.MIN !== undefined && { min: Number(p.MIN) }),
      ...(p.MAX !== undefined && { max: Number(p.MAX) }),
      ...(p.DEFAULT !== undefined && { default: p.DEFAULT }),
      ...(p.UNIT && { unit: p.UNIT }),
      ...(p.VALUE_LIST && { valueList: p.VALUE_LIST }),
    };
  }
  return params;
}

export class DeviceTypeCache {
  private cache = new Map<string, CachedDeviceType>();
  private readonly cacheDir: string;
  private readonly ttl: number;
  private readonly logger: Logger;
  private readonly fileName: string;
  private warming = false;
  private inflightQueries = new Map<string, Promise<CachedDeviceType | undefined>>();

  constructor(cacheDir: string, ttl: number, logger: Logger, fileName?: string) {
    this.cacheDir = cacheDir;
    this.ttl = ttl;
    this.logger = logger;
    // Per-target cache file so different CCUs don't pollute each other's schema
    // cache (default keeps the historical single-file name for back-compat).
    this.fileName = fileName || DEFAULT_CACHE_FILENAME;
  }

  get(deviceType: string): CachedDeviceType | undefined {
    return this.cache.get(deviceType);
  }

  has(deviceType: string): boolean {
    return this.cache.has(deviceType);
  }

  getAll(): Record<string, CachedDeviceType> {
    return Object.fromEntries(this.cache);
  }

  size(): number {
    return this.cache.size;
  }

  /** Load cache from disk. Returns true if valid cache was loaded. */
  async loadFromDisk(): Promise<boolean> {
    const filePath = join(this.cacheDir, this.fileName);
    try {
      const data = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(data) as DeviceTypeCacheFile;

      if (parsed.version !== CACHE_VERSION) {
        this.logger.warn("cache_version_mismatch", { expected: CACHE_VERSION, got: parsed.version });
        return false;
      }

      const age = (Date.now() - new Date(parsed.timestamp).getTime()) / 1000;
      const expired = age > this.ttl;

      this.cache = new Map(Object.entries(parsed.types));
      this.logger.info("cache_loaded", { types: this.cache.size, age_seconds: Math.round(age), expired });

      return !expired;
    } catch {
      this.logger.info("cache_load_miss");
      return false;
    }
  }

  /** Atomic write: serialize → tmp file → rename */
  async saveToDisk(): Promise<void> {
    const filePath = join(this.cacheDir, this.fileName);
    const tmpPath = filePath + ".tmp";

    const data: DeviceTypeCacheFile = {
      version: CACHE_VERSION,
      timestamp: new Date().toISOString(),
      ttl: this.ttl,
      types: Object.fromEntries(this.cache),
    };

    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await rename(tmpPath, filePath);
      this.logger.info("cache_saved", { types: this.cache.size });
    } catch (err) {
      this.logger.error("cache_save_failed", { error: (err as Error).message });
      // Clean up tmp file if rename failed
      try { await unlink(tmpPath); } catch { /* ignore */ }
    }
  }

  /** Background cache warming. Non-blocking — errors are logged, not thrown. */
  async warm(session: SessionManager, rateLimiter: RateLimiter): Promise<void> {
    if (this.warming) {
      this.logger.debug("cache_warm_already_running");
      return;
    }

    this.warming = true;
    const start = Date.now();

    try {
      this.logger.info("cache_warm_start");

      // Get all interfaces
      await rateLimiter.acquire();
      const interfaces = await session.call("Interface.listInterfaces") as Array<{ name: string }>;

      // Get all devices per interface
      const devicesByType = new Map<string, { interface: string; address: string; channels: string[] }>();

      for (const iface of interfaces) {
        await rateLimiter.acquire();
        let devices: Array<{ type: string; address: string; children?: string[]; parent?: string }>;
        try {
          devices = await session.call("Interface.listDevices", { interface: iface.name }) as typeof devices;
        } catch {
          this.logger.warn("cache_warm_interface_skip", { interface: iface.name });
          continue;
        }

        // Deduplicate by device type — pick first instance of each type
        for (const device of devices) {
          // Only top-level devices (have children), not channels
          if (!device.children || device.children.length === 0) continue;
          if (devicesByType.has(device.type)) continue;

          devicesByType.set(device.type, {
            interface: iface.name,
            address: device.address,
            channels: device.children,
          });
        }
      }

      this.logger.info("cache_warm_types_found", { count: devicesByType.size });

      // Query paramset descriptions for each unique device type.
      // Bounded concurrency: a few types in flight cut warm time roughly in
      // half while the rate limiter still caps overall CCU load.
      const processType = async (deviceType: string, info: { interface: string; channels: string[] }) => {
        try {
          const channels: CachedDeviceType["channels"] = {};

          // Get description for each channel
          for (const channelAddr of info.channels) {
            const channelIndex = channelAddr.split(":")[1] || "0";

            const paramsets: Record<string, Record<string, CachedParamDescription>> = {};

            for (const paramsetKey of ["VALUES", "MASTER"]) {
              await rateLimiter.acquire();
              try {
                const desc = await session.call("Interface.getParamsetDescription", {
                  interface: info.interface,
                  address: channelAddr,
                  paramsetKey,
                });

                const params = parseParamDescriptions(desc as RawParamDesc[]);

                if (Object.keys(params).length > 0) {
                  paramsets[paramsetKey] = params;
                }
              } catch {
                // Some channels don't support all paramset keys — skip
              }
            }

            // Determine channel type from the first param or address pattern
            channels[channelIndex] = {
              type: channelAddr, // Will be enriched if we add channel type info later
              paramsets,
            };
          }

          this.cache.set(deviceType, {
            interface: info.interface,
            channels,
          });
        } catch (err) {
          this.logger.warn("cache_warm_type_failed", { deviceType, error: (err as Error).message });
        }
      };

      const entries = [...devicesByType];
      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(WARM_CONCURRENCY, entries.length) },
        async () => {
          while (nextIndex < entries.length) {
            const [deviceType, info] = entries[nextIndex++]!;
            await processType(deviceType, info);
          }
        },
      );
      await Promise.all(workers);

      await this.saveToDisk();

      const duration = Date.now() - start;
      this.logger.info("cache_warm_done", { types: this.cache.size, duration_ms: duration });
    } catch (err) {
      this.logger.error("cache_warm_failed", { error: (err as Error).message });
    } finally {
      this.warming = false;
    }
  }

  /**
   * Add a single type to cache (live query fallback).
   * Single-flight per device type: concurrent calls share one live query.
   */
  async queryAndCache(
    deviceType: string,
    deviceAddress: string,
    interfaceName: string,
    channels: string[],
    session: SessionManager,
    rateLimiter: RateLimiter,
  ): Promise<CachedDeviceType | undefined> {
    const inflight = this.inflightQueries.get(deviceType);
    if (inflight) return inflight;

    const query = this.doQueryAndCache(deviceType, interfaceName, channels, session, rateLimiter)
      .finally(() => {
        this.inflightQueries.delete(deviceType);
      });
    this.inflightQueries.set(deviceType, query);
    return query;
  }

  private async doQueryAndCache(
    deviceType: string,
    interfaceName: string,
    channels: string[],
    session: SessionManager,
    rateLimiter: RateLimiter,
  ): Promise<CachedDeviceType | undefined> {
    const cached: CachedDeviceType = { interface: interfaceName, channels: {} };

    for (const channelAddr of channels) {
      const channelIndex = channelAddr.split(":")[1] || "0";
      const paramsets: Record<string, Record<string, CachedParamDescription>> = {};

      for (const paramsetKey of ["VALUES", "MASTER"]) {
        await rateLimiter.acquire();
        try {
          const desc = await session.call("Interface.getParamsetDescription", {
            interface: interfaceName,
            address: channelAddr,
            paramsetKey,
          });

          const params = parseParamDescriptions(desc as RawParamDesc[]);

          if (Object.keys(params).length > 0) {
            paramsets[paramsetKey] = params;
          }
        } catch { /* skip */ }
      }

      cached.channels[channelIndex] = { type: channelAddr, paramsets };
    }

    this.cache.set(deviceType, cached);
    // Don't block on disk save
    this.saveToDisk().catch(() => {});
    return cached;
  }

  isWarming(): boolean {
    return this.warming;
  }
}
