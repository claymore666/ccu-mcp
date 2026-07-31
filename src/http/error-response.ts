import type { ServerResponse } from "node:http";

/**
 * Terminate a response after an unexpected handler failure.
 *
 * Split out of the HTTP handler's catch-all so it can be unit-tested:
 * `src/index.ts` calls `main()` at module scope, so a test cannot import it
 * without starting a server.
 *
 * The `headersSent` branch is the point. A GET opens the long-lived SSE
 * notification stream, which commits its headers the moment it opens; any
 * later rejection lands in the catch with a response already in flight.
 * Writing a JSON body there appended it INTO the event stream, where it is
 * neither a valid `data:` frame nor an event boundary — clients saw a parse
 * error rather than a clean close (issue #123). End the stream instead and
 * let the client reconnect.
 */
export function endWithInternalError(res: ServerResponse): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Internal error" }));
}
