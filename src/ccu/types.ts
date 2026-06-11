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
export interface CcuConfig {
  host: string;
  port: number;
  https: boolean;
  /** Verify the CCU's TLS certificate. Off by default: CCUs ship self-signed certs. */
  tlsVerify: boolean;
  user: string;
  password: string;
  timeout: number;
  scriptTimeout: number;
}
