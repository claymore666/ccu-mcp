export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const REDACTED_KEYS = new Set(["password", "_session_id_", "MCP_AUTH_TOKEN"]);

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = REDACTED_KEYS.has(key) ? "[REDACTED]" : redactValue(value);
  }
  return result;
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

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };

    if (data) {
      Object.assign(entry, redact(data));
    }

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
