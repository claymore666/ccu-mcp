import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../../src/ccu/session.js";
import { CcuError } from "../../src/middleware/error-mapper.js";
import { Logger } from "../../src/logger.js";

const logger = new Logger("error");
const baseConfig = { host: "test", port: 80, https: false, tlsVerify: false, user: "Admin", password: "pw", timeout: 5000, scriptTimeout: 30000 };

function createMockClient() {
  return { call: vi.fn() };
}

function createSession(mockClient: ReturnType<typeof createMockClient>) {
  const session = new SessionManager(baseConfig, logger, "/tmp/nonexistent-session-test-" + Date.now());
  (session as any).client = mockClient;
  return session;
}

describe("SessionManager", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe("login", () => {
    it("stores session ID from client result", async () => {
      const client = createMockClient();
      client.call.mockResolvedValue("sess-abc");
      const session = createSession(client);
      await session.login();
      expect(session.getSessionId()).toBe("sess-abc");
      session.destroy();
    });

    // Regression: concurrent logins stampeded Session.login → "too many sessions" (issue #2)
    it("coalesces concurrent logins into a single Session.login", async () => {
      const client = createMockClient();
      let resolveLogin!: (v: string) => void;
      client.call.mockImplementation(async (method: string) => {
        if (method === "Session.login") return new Promise((r) => { resolveLogin = r; });
        return true;
      });

      const session = createSession(client);
      // Skip the fs-based restore so doLogin reaches Session.login without real I/O
      vi.spyOn(session as any, "tryRestoreSession").mockResolvedValue(false);
      const p1 = session.login();
      const p2 = session.login();
      await vi.advanceTimersByTimeAsync(0); // flush microtasks so doLogin reaches Session.login
      resolveLogin("sess-shared");
      await Promise.all([p1, p2]);

      const loginCalls = client.call.mock.calls.filter((c) => c[0] === "Session.login");
      expect(loginCalls.length).toBe(1);
      expect(session.getSessionId()).toBe("sess-shared");
      session.destroy();
    });

    it("allows a fresh login after the previous one completed", async () => {
      const client = createMockClient();
      client.call.mockResolvedValue("sess-1");
      const session = createSession(client);
      await session.login();

      client.call.mockClear();
      client.call.mockImplementation(async (method: string) => {
        if (method === "Session.login") return "sess-2";
        throw new Error("renew fail"); // force restore to fail so doLogin does a fresh login
      });
      await (session as any).clearPersistedSession();
      await session.login();

      expect(session.getSessionId()).toBe("sess-2");
      session.destroy();
    });

    it("sets isLoggedIn to true", async () => {
      const client = createMockClient();
      client.call.mockResolvedValue("sess");
      const session = createSession(client);
      expect(session.isLoggedIn()).toBe(false);
      await session.login();
      expect(session.isLoggedIn()).toBe(true);
      session.destroy();
    });
  });

  describe("logout", () => {
    it("clears session and calls Session.logout", async () => {
      const client = createMockClient();
      client.call.mockResolvedValue("sess");
      const session = createSession(client);
      await session.login();
      client.call.mockResolvedValue(true);
      await session.logout();

      expect(session.isLoggedIn()).toBe(false);
      expect(client.call).toHaveBeenCalledWith("Session.logout", expect.objectContaining({ _session_id_: "sess" }));
    });

    it("handles logout failure gracefully", async () => {
      const client = createMockClient();
      client.call.mockResolvedValueOnce("sess").mockRejectedValueOnce(new Error("network"));
      const session = createSession(client);
      await session.login();
      await session.logout(); // should not throw
      expect(session.isLoggedIn()).toBe(false);
    });

    it("does nothing if no active session", async () => {
      const client = createMockClient();
      const session = createSession(client);
      await session.logout(); // no throw
      expect(client.call).not.toHaveBeenCalledWith("Session.logout", expect.anything());
      session.destroy();
    });
  });

  describe("getSessionId", () => {
    it("throws CcuError(AUTH) when no session", () => {
      const session = createSession(createMockClient());
      try {
        session.getSessionId();
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CcuError);
        expect((err as CcuError).structured.error).toBe("AUTH");
      }
      session.destroy();
    });
  });

  describe("call", () => {
    it("attaches _session_id_ to params", async () => {
      const client = createMockClient();
      client.call.mockResolvedValueOnce("sess").mockResolvedValueOnce("result");
      const session = createSession(client);
      await session.login();
      await session.call("Interface.getValue", { address: "ABC:1" });

      expect(client.call).toHaveBeenLastCalledWith(
        "Interface.getValue",
        expect.objectContaining({ _session_id_: "sess", address: "ABC:1" }),
        undefined,
      );
      session.destroy();
    });

    it("re-logins and retries on AUTH error", async () => {
      const client = createMockClient();
      const authError = new CcuError({ error: "AUTH", code: 400, message: "access denied", hint: "" });

      client.call
        .mockResolvedValueOnce("old-sess")     // login
        .mockRejectedValueOnce(authError)       // first call fails
        .mockResolvedValueOnce("new-sess")      // re-login
        .mockResolvedValueOnce("success");      // retry

      const session = createSession(client);
      await session.login();
      const result = await session.call("Interface.getValue", {});

      expect(result).toBe("success");
      session.destroy();
    });

    it("throws non-AUTH errors without retry", async () => {
      const client = createMockClient();
      const notFoundError = new CcuError({ error: "NOT_FOUND", code: 502, message: "not found", hint: "" });

      client.call.mockResolvedValueOnce("sess").mockRejectedValueOnce(notFoundError);
      const session = createSession(client);
      await session.login();

      await expect(session.call("Interface.getValue", {})).rejects.toThrow(notFoundError);
      session.destroy();
    });
  });

  describe("callNoSession", () => {
    it("calls client without _session_id_", async () => {
      const client = createMockClient();
      client.call.mockResolvedValue("result");
      const session = createSession(client);
      await session.callNoSession("Interface.isPresent", { interface: "BidCos-RF" });

      expect(client.call).toHaveBeenCalledWith("Interface.isPresent", { interface: "BidCos-RF" }, undefined);
      session.destroy();
    });
  });

  describe("renewal timer", () => {
    it("renews session every 60 seconds", async () => {
      const client = createMockClient();
      client.call.mockResolvedValue("sess");
      const session = createSession(client);
      await session.login();

      client.call.mockResolvedValue(true); // renew response
      await vi.advanceTimersByTimeAsync(60_000);

      expect(client.call).toHaveBeenCalledWith("Session.renew", expect.objectContaining({ _session_id_: "sess" }));
      session.destroy();
    });

    it("re-logins when renewal fails", async () => {
      const client = createMockClient();
      client.call.mockResolvedValueOnce("sess"); // initial login
      const session = createSession(client);
      await session.login();
      expect(session.getSessionId()).toBe("sess");

      // Clear persisted session so restore doesn't interfere
      await (session as any).clearPersistedSession();

      // From here: renewal calls renew (fail), then login() tries Session.login (success)
      client.call.mockImplementation(async (method: string) => {
        if (method === "Session.renew") throw new Error("renew fail");
        if (method === "Session.login") return "new-sess";
        return null;
      });

      await vi.advanceTimersByTimeAsync(60_000);
      // Allow async login() chain to complete
      await vi.advanceTimersByTimeAsync(100);

      // Session should have been replaced
      expect(session.getSessionId()).toBe("new-sess");
      session.destroy();
    });
  });

  describe("destroy", () => {
    it("clears renewal timer", async () => {
      const client = createMockClient();
      client.call.mockResolvedValue("sess");
      const session = createSession(client);
      await session.login();
      session.destroy();

      // Advance time — renew should NOT be called
      const callCountBefore = client.call.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(client.call.mock.calls.length).toBe(callCountBefore);
    });
  });
});
