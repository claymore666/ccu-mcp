export interface DeviceTypeCacheFile {
  version: number;
  timestamp: string;
  ttl: number;
  types: Record<string, CachedDeviceType>;
}

export interface CachedDeviceType {
  interface: string;
  channels: Record<string, CachedChannelSchema>;
}

export interface CachedChannelSchema {
  type: string;
  paramsets: Record<string, Record<string, CachedParamDescription>>;
}

export interface CachedParamDescription {
  type: string;
  operations: number;
  min?: number;
  max?: number;
  default?: unknown;
  unit?: string;
  valueList?: string[];
}

// v2: valueList changed shape — pre-v2 caches stored the raw TCL-list string
// ("AUTO MANU {Party Mode}") instead of tokenized labels; the bump discards
// them so stale enum shapes are never served from disk.
export const CACHE_VERSION = 2;
