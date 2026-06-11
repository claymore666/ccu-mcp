import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

/** Server version — read from package.json at runtime, single source of truth. */
export const VERSION: string = (_require("../package.json") as { version: string }).version;

/** Escape a string for safe interpolation into HomeMatic Script double-quoted strings. */
export function escapeHmScript(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/#/g, "\\#")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** Format a tool result as MCP text content. */
export function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

/** Try to parse JSON, return raw string on failure. */
export function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Parse a CCU string value to a native JS type.
 * "19.000000" → 19, "true" → true, "false" → false, "" → null, else string.
 */
// Plain decimal notation only. Rejects formats Number() would also accept but
// that lose information on round-trip: leading zeros ("0123"), sign prefix
// ("+49170..."), hex ("0x1A"), exponent ("1e5"), and "Infinity".
const DECIMAL_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function parseValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  const s = String(val);
  if (s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (DECIMAL_RE.test(s)) return Number(s);
  return s;
}

/**
 * Parse all values in a flat key-value object (e.g. paramset or datapoints).
 */
export function parseValues(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = parseValue(v);
  }
  return result;
}
