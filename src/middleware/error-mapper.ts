import type { CcuRpcError, ErrorCategory, StructuredError } from "../ccu/types.js";

// Map CCU error codes to our error categories
const CCU_ERROR_MAP: Record<number, { category: ErrorCategory; hint: string }> = {
  400: { category: "AUTH", hint: "Session expired. Will re-login automatically." },
  401: { category: "INTERNAL", hint: "Invalid CCU method called — this is a bug in ccu-mcp." },
  402: { category: "INTERNAL", hint: "Missing required argument — this is a bug in ccu-mcp." },
  501: { category: "CCU_ERROR", hint: "CCU internal error. Try again or check CCU logs." },
  502: { category: "NOT_FOUND", hint: "Device or channel not found. Call list_devices to discover valid addresses." },
  503: { category: "NOT_FOUND", hint: "Invalid paramset key. Valid keys are VALUES, MASTER, or a link partner's channel address." },
  505: { category: "INVALID_INPUT", hint: "Invalid valueKey or value. Call describe_device_type to see valid parameters." },
  506: { category: "INVALID_INPUT", hint: "Operation not supported by this device/channel." },
  507: { category: "CCU_ERROR", hint: "Transmission pending in HmIP Legacy API. Try again shortly." },
};

export function mapCcuError(ccuError: CcuRpcError, ccuMethod: string): StructuredError {
  const mapping = CCU_ERROR_MAP[ccuError.code];

  return {
    error: mapping?.category ?? "CCU_ERROR",
    code: ccuError.code,
    message: ccuError.message,
    hint: mapping?.hint ?? "Unexpected CCU error.",
    ccuMethod,
    ccuCode: ccuError.code,
  };
}

export function mapNetworkError(err: Error, ccuMethod: string): StructuredError {
  // undici's fetch wraps every dispatch/connect failure in a generic
  // TypeError("fetch failed") with the real error on `cause` — without
  // unwrapping it, a TLS fingerprint mismatch (an active-MITM / cert-rotation
  // signal!) is indistinguishable from an unplugged CCU.
  const cause = (err as Error & { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error ? cause.message : "";

  if (causeMsg.includes("fingerprint mismatch")) {
    return {
      error: "TLS_ERROR",
      code: 0,
      message: `CCU TLS certificate verification failed: ${causeMsg}`,
      hint:
        "The CCU presented a DIFFERENT certificate than the pinned one. If the CCU's " +
        "certificate was legitimately renewed, refresh CCU_TLS_FINGERPRINT; otherwise " +
        "treat this as a possible interception attempt.",
      ccuMethod,
    };
  }

  if (err.name === "AbortError" || /timeout/i.test(err.message) || /timeout/i.test(causeMsg)) {
    return {
      error: "TIMEOUT",
      code: 0,
      message: `Request to CCU timed out: ${ccuMethod}`,
      hint: "CCU may be slow or overloaded. Try again.",
      ccuMethod,
    };
  }

  return {
    error: "UNREACHABLE",
    code: 0,
    message: `Cannot connect to CCU: ${causeMsg ? `${err.message} (${causeMsg})` : err.message}`,
    hint: "Check that the CCU is running and reachable at the configured host/port.",
    ccuMethod,
  };
}

export class CcuError extends Error {
  public readonly structured: StructuredError;

  constructor(structured: StructuredError) {
    super(structured.message);
    this.name = "CcuError";
    this.structured = structured;
  }

  toMcpError(): { isError: true; content: [{ type: "text"; text: string }] } {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(this.structured) }],
    };
  }
}
