import type { Logger } from "../logger.js";
import { CcuError } from "./error-mapper.js";

type LogFields = Record<string, unknown>;

/**
 * Shared wrapper for tool handler bodies (review finding I-2). Collapses the
 * boilerplate that every tool repeated by hand — start timer, run the body,
 * emit one `tool_call` log (ok/error) with duration, and map a thrown
 * `CcuError` to an MCP error result (re-throwing anything else) — into one
 * place so logging and error mapping can't drift between tools.
 *
 * The body receives a `log` callback to contribute extra success-log fields
 * (e.g. `{ address }`, `{ deviceCount }`); they're merged into the `ok` line.
 * The handler stays `async (args) => runTool(name, logger, (log) => …)`, so the
 * SDK still infers `args` from the tool's input schema.
 */
export async function runTool<R>(
  tool: string,
  logger: Logger,
  body: (log: (fields: LogFields) => void) => Promise<R>,
): Promise<R | ReturnType<CcuError["toMcpError"]>> {
  const start = Date.now();
  let extra: LogFields = {};
  const log = (fields: LogFields): void => {
    extra = { ...extra, ...fields };
  };

  try {
    const result = await body(log);
    logger.info("tool_call", { tool, duration_ms: Date.now() - start, status: "ok", ...extra });
    return result;
  } catch (err) {
    if (err instanceof CcuError) {
      // Mapped CCU failure: expected operational error — keep it at info, but
      // carry the category/message (and the body's extra fields) so a failing
      // tool is diagnosable from the logs.
      logger.info("tool_call", {
        tool,
        duration_ms: Date.now() - start,
        status: "error",
        error: err.structured.error,
        message: err.structured.message,
        ...extra,
      });
      return err.toMcpError();
    }
    // Unexpected crash (TypeError etc.): must stand out from routine CCU errors.
    logger.error("tool_call", {
      tool,
      duration_ms: Date.now() - start,
      status: "crash",
      error: (err as Error).name,
      message: (err as Error).message,
      ...extra,
    });
    throw err;
  }
}
