import { describe, it, expect, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { endWithInternalError } from "../../src/http/error-response.js";

/** Minimal ServerResponse stand-in recording what the handler did to it. */
function fakeRes(headersSent: boolean) {
  const res = {
    headersSent,
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return res as unknown as ServerResponse & typeof res;
}

describe("endWithInternalError", () => {
  it("sends a 500 JSON body when nothing has been written yet", () => {
    const res = fakeRes(false);
    endWithInternalError(res);

    expect(res.writeHead).toHaveBeenCalledWith(500, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.end.mock.calls[0]![0] as string)).toEqual({ error: "Internal error" });
  });

  // Issue #123: the old code guarded writeHead on headersSent but not end(), so
  // a failure on an already-open SSE stream appended {"error":"Internal error"}
  // into the event stream — not a valid `data:` frame, not an event boundary.
  it("closes an already-committed response without writing a body into it", () => {
    const res = fakeRes(true);
    endWithInternalError(res);

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
    // the decisive assertion: end() called with NO payload
    expect(res.end.mock.calls[0]).toEqual([]);
  });
});
