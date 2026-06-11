import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "../../src/logger.js";
import { CcuError } from "../../src/middleware/error-mapper.js";

// Mock undici before importing CcuClient
const mockFetch = vi.fn();
vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
  Agent: vi.fn(),
}));

// Import after mock
const { CcuClient } = await import("../../src/ccu/client.js");

const logger = new Logger("error");
const baseConfig = { host: "test-ccu", port: 80, https: false, tlsVerify: false, user: "Admin", password: "pw", timeout: 5000, scriptTimeout: 30000 };

function jsonResponse(body: object) {
  return Promise.resolve({ text: () => Promise.resolve(JSON.stringify(body)) });
}

describe("CcuClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("builds HTTP URL from config", () => {
    const client = new CcuClient(baseConfig, logger);
    expect((client as any).baseUrl).toBe("http://test-ccu:80/api/homematic.cgi");
  });

  it("builds HTTPS URL when config.https is true", () => {
    const client = new CcuClient({ ...baseConfig, https: true, port: 443 }, logger);
    expect((client as any).baseUrl).toBe("https://test-ccu:443/api/homematic.cgi");
  });

  it("returns result on successful response", async () => {
    mockFetch.mockReturnValue(jsonResponse({ id: "1", version: "1.1", result: "session123", error: null }));
    const client = new CcuClient(baseConfig, logger);
    const result = await client.call("Session.login", { username: "Admin", password: "pw" });
    expect(result).toBe("session123");
  });

  it("sends JSON-RPC body with method and params", async () => {
    mockFetch.mockReturnValue(jsonResponse({ id: "1", version: "1.1", result: true, error: null }));
    const client = new CcuClient(baseConfig, logger);
    await client.call("Interface.setValue", { address: "ABC:1", valueKey: "STATE" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("Interface.setValue");
    expect(body.params.address).toBe("ABC:1");
  });

  it("throws CcuError(TIMEOUT) on AbortError", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    mockFetch.mockRejectedValue(abortErr);

    const client = new CcuClient(baseConfig, logger);
    try {
      await client.call("Test", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CcuError);
      expect((err as CcuError).structured.error).toBe("TIMEOUT");
    }
  });

  it("throws CcuError(UNREACHABLE) on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const client = new CcuClient(baseConfig, logger);
    try {
      await client.call("Test", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CcuError);
      expect((err as CcuError).structured.error).toBe("UNREACHABLE");
    }
  });

  it("throws CcuError(CCU_ERROR) on invalid JSON response", async () => {
    mockFetch.mockReturnValue(Promise.resolve({ text: () => Promise.resolve("<html>502</html>") }));

    const client = new CcuClient(baseConfig, logger);
    try {
      await client.call("Test", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CcuError);
      expect((err as CcuError).structured.error).toBe("CCU_ERROR");
      expect((err as CcuError).structured.message).toContain("Invalid JSON");
    }
  });

  it("throws CcuError via mapCcuError when response has error", async () => {
    mockFetch.mockReturnValue(jsonResponse({
      id: "1", version: "1.1", result: null,
      error: { name: "JSONRPCError", code: 502, message: "unknown device" },
    }));

    const client = new CcuClient(baseConfig, logger);
    try {
      await client.call("Interface.getValue", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CcuError);
      expect((err as CcuError).structured.error).toBe("NOT_FOUND");
      expect((err as CcuError).structured.ccuCode).toBe(502);
    }
  });

  it("increments request ID across calls", async () => {
    mockFetch.mockReturnValue(jsonResponse({ id: "1", version: "1.1", result: true, error: null }));
    const client = new CcuClient(baseConfig, logger);

    await client.call("A", {});
    await client.call("B", {});

    const id1 = JSON.parse(mockFetch.mock.calls[0][1].body).id;
    const id2 = JSON.parse(mockFetch.mock.calls[1][1].body).id;
    expect(Number(id2)).toBeGreaterThan(Number(id1));
  });
});
