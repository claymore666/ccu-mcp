// CCU JSON-RPC request/response types

export interface CcuRpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface CcuRpcResponse {
  id?: string;
  version: string;
  result: unknown;
  error: CcuRpcError | null;
}

export interface CcuRpcError {
  name: string;
  code: number;
  message: string;
}

// Error categories for structured MCP errors
export type ErrorCategory =
  | "AUTH"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CCU_ERROR"
  | "TIMEOUT"
  | "UNREACHABLE"
  | "RATE_LIMITED"
  | "INTERNAL";

export interface StructuredError {
  error: ErrorCategory;
  code: number;
  message: string;
  hint: string;
  ccuMethod?: string;
  ccuCode?: number;
}

// CCU device/channel types from Device.listAllDetail
export interface CcuDevice {
  id: string;
  name: string;
  address: string;
  interface: string;
  type: string;
  operateGroupOnly: string;
  isReady: string;
  channels: CcuChannel[];
}

export interface CcuChannel {
  id: string;
  name: string;
  address: string;
  deviceId: string;
  index: number;
  partnerId: string;
  mode: string;
  category: string;
  isReady: boolean;
  isUsable: boolean;
  isVisible: boolean;
  isLogged: boolean;
  isLogable: boolean;
  isReadable: boolean;
  isWritable: boolean;
  isEventable: boolean;
  isAesAvailable: boolean;
  isVirtual: boolean;
  channelType: string;
}

// CCU room/function types
export interface CcuRoom {
  id: string;
  name: string;
  description: string;
  channelIds: string[];
}

export interface CcuFunction {
  id: string;
  name: string;
  description: string;
  channelIds: string[];
}

// CCU program types
export interface CcuProgram {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  isInternal: boolean;
  lastExecuteTime: string;
}

// CCU system variable types
export interface CcuSysVar {
  id: string;
  name: string;
  description: string;
  type: string;
  value: string;
  valueList: string;
  minValue: string;
  maxValue: string;
  unit: string;
  isLogged: boolean;
}

// CCU interface info
export interface CcuInterface {
  name: string;
  port: number;
  info: string;
}

// Device type cache schema
export interface DeviceTypeSchema {
  description: string;
  interface: string;
  channels: Record<string, ChannelSchema>;
}

export interface ChannelSchema {
  type: string;
  paramsets: Record<string, Record<string, ParamDescription>>;
}

export interface ParamDescription {
  type: string;
  operations: number;
  min?: number;
  max?: number;
  default?: unknown;
  unit?: string;
  valueList?: string[];
  description?: string;
}

// Config
/**
 * A named CCU target (e.g. `prod`, `dev`). Profiles let one server reach
 * several CCUs; the connection details live in `ccu`, and the two policy flags
 * gate writes. Built from env in config.ts.
 */
export interface CcuProfile {
  /** Profile name as used by use_ccu / the optional per-call `target` arg. */
  name: string;
  /**
   * Production seatbelt: when true, write tools refuse unless the caller passes
   * `confirm:true` (which unlocks writes to this target for the rest of the
   * session). Declared explicitly per profile — never inferred from the name.
   */
  protected: boolean;
  /** When true, write tools are refused outright (even with confirm). */
  readonly: boolean;
  /** Connection details for this target. */
  ccu: CcuConfig;
}

export interface CcuConfig {
  host: string;
  port: number;
  https: boolean;
  /** Verify the CCU's TLS certificate. Off by default: CCUs ship self-signed certs. */
  tlsVerify: boolean;
  /**
   * Pin the CCU's self-signed leaf certificate by its SHA-256 fingerprint
   * (`CCU_TLS_FINGERPRINT`, hex, with or without colons). When set, the
   * connection is rejected unless the presented cert matches — the simplest way
   * to verify a self-signed appliance cert. Takes precedence over `caCert`.
   */
  tlsFingerprint?: string;
  /**
   * PEM contents of the CCU's CA / self-signed certificate (`CCU_CA_CERT`
   * points at the file). When set, the connection is validated against this CA
   * with standard chain verification.
   */
  caCert?: string;
  user: string;
  password: string;
  timeout: number;
  scriptTimeout: number;
}
