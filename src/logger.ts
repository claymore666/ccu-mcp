export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const REDACTED_KEYS = new Set(["password", "_session_id_", "MCP_AUTH_TOKEN"]);

// Object.fromEntries, not `result[key] = …`: assignment routes a "__proto__"
// key through Object.prototype's setter instead of creating an own property,
// so that field silently vanished from the log line. Losing a field from the
// diagnostic path is the opposite of what a logger is for. Redaction itself
// was never affected — a secret-named key is still masked either way.
function redact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [
      key,
      REDACTED_KEYS.has(key) ? "[REDACTED]" : redactValue(value),
    ]),
  );
}

// Recurse through both objects AND arrays so a secret-named key nested inside an
// array element (e.g. { params: [{ password: "…" }] }) is redacted too — a plain
// object walk would emit it in cleartext.
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object" && value !== null) {
    return redact(value as Record<string, unknown>);
  }
  return value;
}

export class Logger {
  private level: number;

  constructor(level: LogLevel = "info") {
    this.level = LEVEL_PRIORITY[level];
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] > this.level) return;

    // Spread, not Object.assign: assign copies with [[Set]], which routes a
    // "__proto__" key through the target's prototype setter and drops the
    // field — the same trap redact() itself had. Object spread uses
    // CreateDataProperty, so the key lands as an own property.
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data ? redact(data) : {}),
    };

    // Write to stderr so it doesn't interfere with stdio MCP transport on stdout
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }
}

export function createLogger(): Logger {
  const level = (process.env.LOG_LEVEL || "info") as LogLevel;
  // hasOwn, not `in`: `in` matches Object.prototype keys, so LOG_LEVEL values
  // like "constructor" would pass validation and silently log at full verbosity.
  if (!Object.hasOwn(LEVEL_PRIORITY, level)) {
    throw new Error(`Invalid LOG_LEVEL: ${level}. Must be one of: error, warn, info, debug`);
  }
  return new Logger(level);
}
