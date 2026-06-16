import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import type { TLSSocket } from "node:tls";
import type { CcuConfig, CcuRpcRequest, CcuRpcResponse } from "./types.js";
import { CcuError, mapCcuError, mapNetworkError } from "../middleware/error-mapper.js";
import type { Logger } from "../logger.js";

/** Normalize a SHA-256 fingerprint for comparison: drop colons, lowercase. */
function normalizeFingerprint(fp: string): string {
  return fp.replace(/:/g, "").toLowerCase();
}

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
        connect: this.buildConnect(config, logger),
        pipelining: 0,
        keepAliveTimeout: 1000,
      });
    }
  }

  /**
   * Decide how the CCU's TLS certificate is verified (issue #51), most specific
   * first:
   *  1. CCU_TLS_FINGERPRINT — pin the exact self-signed leaf cert. Strongest
   *     for an appliance; we complete the handshake without chain validation
   *     (a self-signed cert has no chain) and reject unless the presented
   *     cert's SHA-256 matches.
   *  2. CCU_CA_CERT — trust a provided CA/self-signed PEM and do standard
   *     chain validation.
   *  3. CCU_TLS_VERIFY — verify against the system trust store (public CA).
   *  4. Default — unverified, with a loud warning (a CCU ships a self-signed
   *     cert, so this is the zero-config fallback, but it's MITM-exposed).
   */
  private buildConnect(config: CcuConfig, logger: Logger) {
    if (config.tlsFingerprint) {
      const expected = normalizeFingerprint(config.tlsFingerprint);
      // rejectUnauthorized:false lets the self-signed handshake complete; the
      // fingerprint check below is what actually authenticates the peer.
      // maxCachedSessions:0 disables TLS session resumption: on a resumed
      // session the server does NOT re-send its certificate, so
      // getPeerCertificate() comes back empty and the fingerprint check would
      // wrongly reject every connection after the first. Forcing a full
      // handshake per connection guarantees the cert is always present to pin.
      const connector = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
      return (opts: buildConnector.Options, cb: buildConnector.Callback): void => {
        connector(opts, (err, socket) => {
          if (err || !socket) return cb(err ?? new Error("CCU TLS connect failed"), null);
          const cert = (socket as TLSSocket).getPeerCertificate?.();
          const actual = cert?.fingerprint256 ? normalizeFingerprint(cert.fingerprint256) : "";
          if (!actual || actual !== expected) {
            socket.destroy();
            return cb(
              new Error(
                `CCU TLS certificate fingerprint mismatch (expected ${expected}, got ${actual || "none"})`,
              ),
              null,
            );
          }
          cb(null, socket);
        });
      };
    }

    if (config.caCert) {
      return { ca: config.caCert, rejectUnauthorized: true };
    }

    if (!config.tlsVerify) {
      logger.warn("ccu_tls_unverified", {
        hint:
          "CCU TLS certificate is NOT verified (MITM-exposed). Pin it with " +
          "CCU_TLS_FINGERPRINT, trust it with CCU_CA_CERT, or set CCU_TLS_VERIFY=true " +
          "if the CCU presents a publicly-trusted certificate.",
      });
    }
    return { rejectUnauthorized: config.tlsVerify };
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
