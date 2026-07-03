import type { SessionManager } from "../ccu/session.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { DeviceTypeCache } from "../cache/device-type-cache.js";
import type { Logger } from "../logger.js";
import type { CcuDevice } from "../ccu/types.js";
import { CcuError } from "./error-mapper.js";
import { withRetry } from "./retry.js";

export class Resolver {
  private interfaceMap: Map<string, string> | null = null;
  private deviceTypeMap: Map<string, string> | null = null;
  private deviceList: CcuDevice[] | null = null;
  private refreshPromise: Promise<void> | null = null;

  async resolveInterface(
    address: string,
    session: SessionManager,
    rateLimiter: RateLimiter,
    logger: Logger,
  ): Promise<string> {
    const deviceAddress = address.includes(":") ? address.split(":")[0]! : address;

    if (this.interfaceMap?.has(deviceAddress)) {
      return this.interfaceMap.get(deviceAddress)!;
    }

    await this.refreshDeviceList(session, rateLimiter, logger);

    const iface = this.interfaceMap!.get(deviceAddress);
    if (!iface) {
      throw new CcuError({
        error: "NOT_FOUND",
        code: 0,
        message: `Cannot resolve interface for address: ${address}`,
        hint: "Address not found in device list. Call list_devices to discover valid addresses.",
      });
    }

    return iface;
  }

  /**
   * The parameter's RAW paramset TYPE (BOOL, ACTION, FLOAT, ...) from the
   * device-type cache, or undefined when unknown. ACTION identifies one-shot
   * trigger datapoints (button press, stop) that must never be auto-retried.
   */
  resolveRawParamType(
    address: string,
    valueKey: string,
    cache: DeviceTypeCache,
  ): string | undefined {
    const deviceAddress = address.includes(":") ? address.split(":")[0]! : address;
    const channelIndex = address.includes(":") ? address.split(":")[1]! : "0";
    const deviceType = this.deviceTypeMap?.get(deviceAddress);

    if (!deviceType) return undefined;

    const cached = cache.get(deviceType);
    if (!cached) return undefined;

    const channel = cached.channels[channelIndex];
    if (!channel) return undefined;

    return channel.paramsets["VALUES"]?.[valueKey]?.type;
  }

  resolveType(
    address: string,
    valueKey: string,
    cache: DeviceTypeCache,
  ): string | undefined {
    const rawType = this.resolveRawParamType(address, valueKey, cache);
    if (!rawType) return undefined;

    const typeMap: Record<string, string> = {
      BOOL: "bool",
      ACTION: "bool",
      FLOAT: "double",
      INTEGER: "int",
      ENUM: "int",
      STRING: "string",
    };

    return typeMap[rawType] || "string";
  }

  getDeviceType(address: string): string | undefined {
    const deviceAddress = address.includes(":") ? address.split(":")[0]! : address;
    return this.deviceTypeMap?.get(deviceAddress);
  }

  getDeviceList(): CcuDevice[] | null {
    return this.deviceList;
  }

  updateDeviceList(devices: CcuDevice[]): void {
    this.interfaceMap = new Map();
    this.deviceTypeMap = new Map();
    this.deviceList = devices;

    for (const device of devices) {
      this.interfaceMap.set(device.address, device.interface);
      this.deviceTypeMap.set(device.address, device.type);
    }
  }

  /** Single-flight: concurrent cold-cache resolutions share one Device.listAllDetail. */
  private async refreshDeviceList(
    session: SessionManager,
    rateLimiter: RateLimiter,
    logger: Logger,
  ): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(session, rateLimiter, logger).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(
    session: SessionManager,
    rateLimiter: RateLimiter,
    logger: Logger,
  ): Promise<void> {
    await rateLimiter.acquire();
    const devices = await withRetry(
      () => session.call("Device.listAllDetail"),
      "Device.listAllDetail",
      logger,
    ) as CcuDevice[];

    this.updateDeviceList(devices);
  }
}
