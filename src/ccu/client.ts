import { Agent, fetch as undiciFetch } from "undici";
import type { CcuConfig, CcuRpcRequest, CcuRpcResponse } from "./types.js";
import { CcuError, mapCcuError, mapNetworkError } from "../middleware/error-mapper.js";
import type { Logger } from "../logger.js";

export class CcuClient {
  private readonly baseUrl: string;
  private readonly config: CcuConfig;
  private readonly logger: Logger;
  private readonly dispatcher: Agent | undefined;
  private requestCounter = 0;

  constructor(config: CcuConfig, logger: Logger) {
    this.config = config;
    const protocol = config.https ? "https" : "http";
    this.baseUrl = `${protocol}://${config.host}:${config.port}/api/homematic.cgi`;
    this.logger = logger;

    if (config.https) {
      this.dispatcher = new Agent({
        connect: { rejectUnauthorized: config.tlsVerify },
        pipelining: 0,
        keepAliveTimeout: 1000,
      });
    }
  }

  async call(method: string, params: Record<string, unknown>, timeout?: number): Promise<unknown> {
    const id = String(++this.requestCounter);
    const effectiveTimeout = timeout ?? this.config.timeout;

    const request: CcuRpcRequest = { id, method, params };

    this.logger.debug("ccu_request", { method, id });

    const start = Date.now();
    let response: CcuRpcResponse;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);

      let text: string;
      let httpStatus = 0;
      try {
        const httpResponse = await undiciFetch(this.baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
          dispatcher: this.dispatcher,
        });
        httpStatus = httpResponse.status;

        // The abort signal also covers the body read, so the timeout
        // applies to the full request, not just the response headers.
        text = await httpResponse.text();
      } finally {
        clearTimeout(timer);
      }

      try {
        response = JSON.parse(text) as CcuRpcResponse;
      } catch {
        throw new CcuError({
          error: "CCU_ERROR",
          code: 0,
          message: `Invalid JSON response from CCU (HTTP ${httpStatus}): ${text.slice(0, 200)}`,
          hint: "CCU returned invalid JSON. It may be overloaded, misconfigured, or behind a proxy returning an error page.",
          ccuMethod: method,
        });
      }
    } catch (err) {
      if (err instanceof CcuError) throw err;

      const duration = Date.now() - start;
      this.logger.error("ccu_request_failed", { method, duration_ms: duration, error: (err as Error).message });
      throw new CcuError(mapNetworkError(err as Error, method));
    }

    const duration = Date.now() - start;

    if (response.error) {
      this.logger.debug("ccu_response_error", { method, duration_ms: duration, code: response.error.code });
      throw new CcuError(mapCcuError(response.error, method));
    }

    this.logger.debug("ccu_response_ok", { method, duration_ms: duration });
    return response.result;
  }
}
