import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

/**
 * Minimal mock CCU JSON-RPC endpoint for the CLI wizard tests: answers every
 * POST with the configured result for the request's method, or a JSON-RPC
 * error envelope. Values in `results` may be an error spec to simulate CCU
 * error codes (e.g. 400 access denied for privilege probes).
 */
export type MockResult = unknown | { __error: { code: number; message: string } };

export interface MockCcu {
  port: number;
  calls: string[];
  close: () => Promise<void>;
}

function handler(results: Record<string, MockResult>, calls: string[]) {
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let method = "";
      try {
        method = (JSON.parse(body) as { method: string }).method;
      } catch {
        // fall through to the unknown-method error envelope
      }
      calls.push(method);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (Object.hasOwn(results, method)) {
        const value = results[method] as MockResult;
        if (value !== null && typeof value === "object" && "__error" in (value as object)) {
          const e = (value as { __error: { code: number; message: string } }).__error;
          res.end(JSON.stringify({ version: "2.0", result: null, error: { name: "Error", ...e } }));
          return;
        }
        res.end(JSON.stringify({ version: "2.0", result: value, error: null }));
        return;
      }
      res.end(
        JSON.stringify({
          version: "2.0",
          result: null,
          error: { name: "JSONRPCError", code: 501, message: `unknown method ${method}` },
        }),
      );
    });
  };
}

export function startMockCcu(results: Record<string, MockResult> = {}): Promise<MockCcu> {
  const calls: string[] = [];
  const server: HttpServer = createHttpServer(handler(results, calls));
  return listen(server, calls);
}

export function startMockCcuTls(
  tls: { cert: string; key: string },
  results: Record<string, MockResult> = {},
): Promise<MockCcu> {
  const calls: string[] = [];
  const server: HttpsServer = createHttpsServer(tls, handler(results, calls));
  return listen(server, calls);
}

function listen(server: HttpServer | HttpsServer, calls: string[]): Promise<MockCcu> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** The standard happy-path result set: login works, the user is ADMIN. */
export function adminResults(): Record<string, MockResult> {
  return {
    "Session.login": "mock-session-id",
    "Session.logout": true,
    "Session.renew": true,
    "CCU.getVersion": "3.85.7-mock",
  };
}
