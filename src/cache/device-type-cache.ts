import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionManager } from "../ccu/session.js";
import type { RateLimiter } from "../middleware/rate-limiter.js";
import type { Logger } from "../logger.js";
import type { CachedDeviceType, CachedParamDescription, DeviceTypeCacheFile } from "./types.js";
import { CACHE_VERSION } from "./types.js";
import { expectArray } from "../utils.js";

const DEFAULT_CACHE_FILENAME = "device-type-cache.json";

// Device types warmed in parallel; per-request pacing stays with the rate limiter
const WARM_CONCURRENCY = 3;

type RawParamDesc = {
  ID: string; TYPE: string; OPERATIONS: string;
  MIN?: string; MAX?: string; DEFAULT?: string; UNIT?: string; VALUE_LIST?: string[] | string;
};

/**
 * getparamsetdescription.tcl pushes VALUE_LIST through json_toString, which
 * serializes the TCL list as ONE space-joined string, brace-wrapping entries
 * that contain spaces ('{Party Mode} Off'). Tokenize it back into labels so
 * enum indexes line up with the real value list.
 */
function parseTclList(input: string): string[] {
  const items: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (input[i] === " ") i++;
    if (i >= input.length) break;
    if (input[i] === "{") {
      let depth = 1;
      let j = i + 1;
      const start = j;
      while (j < input.length && depth > 0) {
        if (input[j] === "{") depth++;
        else if (input[j] === "}") depth--;
        j++;
      }
      items.push(input.slice(start, depth === 0 ? j - 1 : j));
      i = j;
    } else {
      let j = i;
      while (j < input.length && input[j] !== " ") j++;
      items.push(input.slice(i, j));
      i = j;
    }
  }
  return items;
}

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
      ...(p.VALUE_LIST && {
        valueList: Array.isArray(p.VALUE_LIST) ? p.VALUE_LIST : parseTclList(p.VALUE_LIST),
      }),
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
  // True until a load proves fresh or a warm completes: expired-on-disk data is
  // still loaded as a fallback, but callers can see it needs a refresh.
  private stale = true;
  // Serializes saveToDisk calls: concurrent saves share one fixed .tmp path, so
  // interleaved write/rename pairs could drop a save or keep the older snapshot.
  private savePromise: Promise<void> = Promise.resolve();

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
      this.stale = expired;
      this.logger.info("cache_loaded", { types: this.cache.size, age_seconds: Math.round(age), expired });

      return !expired;
    } catch {
      this.logger.info("cache_load_miss");
      return false;
    }
  }

  /** Atomic write: serialize → tmp file → rename. Calls are queued so two
   *  concurrent saves (background warm + a live-query save) can't interleave
   *  on the shared .tmp path. */
  saveToDisk(): Promise<void> {
    this.savePromise = this.savePromise.then(() => this.doSaveToDisk());
    return this.savePromise;
  }

  private async doSaveToDisk(): Promise<void> {
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
      const interfaces = expectArray<{ name: string }>(
        await session.call("Interface.listInterfaces"), "Interface.listInterfaces",
      );

      // Get all devices per interface
      // `address` used to be stored here and never read — processType's own
      // parameter type omitted it (issue #121).
      const devicesByType = new Map<string, { interface: string; channels: string[] }>();

      for (const iface of interfaces) {
        await rateLimiter.acquire();
        let devices: Array<{ type: string; address: string; children?: string[]; parent?: string }>;
        try {
          devices = expectArray(
            await session.call("Interface.listDevices", { interface: iface.name }), "Interface.listDevices",
          );
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
          this.cache.set(deviceType, {
            interface: info.interface,
            channels: await this.fetchChannels(info.interface, info.channels, session, rateLimiter),
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
      this.stale = false;

      const duration = Date.now() - start;
      this.logger.info("cache_warm_done", { types: this.cache.size, duration_ms: duration });
    } catch (err) {
      this.logger.error("cache_warm_failed", { error: (err as Error).message });
    } finally {
      this.warming = false;
    }
  }

  /**
   * Fetch every channel's VALUES/MASTER paramset descriptions for one device
   * type. Shared by the background warm and the live query fallback — they had
   * near-identical copies of this loop that had already drifted apart in error
   * handling (issue #121).
   *
   * A channel that doesn't support a paramset key is normal and skipped; the
   * result guard is `expectArray`, so a malformed CCU/proxy answer (`result:
   * null`) is a diagnosable CCU_ERROR rather than a TypeError swallowed as
   * "this channel has no such paramset".
   */
  private async fetchChannels(
    interfaceName: string,
    channels: string[],
    session: SessionManager,
    rateLimiter: RateLimiter,
  ): Promise<CachedDeviceType["channels"]> {
    const out: CachedDeviceType["channels"] = {};

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
          const params = parseParamDescriptions(
            expectArray<RawParamDesc>(desc, "Interface.getParamsetDescription"),
          );
          if (Object.keys(params).length > 0) {
            paramsets[paramsetKey] = params;
          }
        } catch {
          // Channel doesn't support this paramset key — expected, skip.
        }
      }

      // `type` carries the channel address for now; enriched if we ever add
      // real channel-type info.
      out[channelIndex] = { type: channelAddr, paramsets };
    }

    return out;
  }

  /**
   * Add a single type to cache (live query fallback).
   * Single-flight per device type: concurrent calls share one live query.
   */
  async queryAndCache(
    deviceType: string,
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
    const cached: CachedDeviceType = {
      interface: interfaceName,
      channels: await this.fetchChannels(interfaceName, channels, session, rateLimiter),
    };

    this.cache.set(deviceType, cached);
    // Don't block on disk save
    this.saveToDisk().catch(() => {});
    return cached;
  }

  isWarming(): boolean {
    return this.warming;
  }

  /** True when the cached schemas are older than the TTL (or never loaded). */
  isStale(): boolean {
    return this.stale;
  }
}
