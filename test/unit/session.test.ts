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

      // Stub persistence out of the relogin chain: real fs I/O does not
      // resolve deterministically under fake timers (flaked on CI).
      vi.spyOn(session as any, "tryRestoreSession").mockResolvedValue(false);
      vi.spyOn(session as any, "persistSession").mockResolvedValue(undefined);

      // From here: renewal calls renew (fail), then login() tries Session.login (success)
      client.call.mockImplementation(async (method: string) => {
        if (method === "Session.renew") throw new Error("renew fail");
        if (method === "Session.login") return "new-sess";
        return null;
      });

      await vi.advanceTimersByTimeAsync(60_000);
      // Drain the microtask chain of the async relogin (no real I/O left)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

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

describe("session persistence and restore (coverage round)", () => {
  let dir: string;
  beforeEach(async () => {
    vi.useRealTimers();
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dir = await mkdtemp(join(tmpdir(), "debmatic-session-test-"));
  });
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSessionFile(data: Record<string, unknown>) {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(dir, "session.json"), JSON.stringify(data), "utf-8");
  }

  function createSessionWithDir(client: ReturnType<typeof createMockClient>) {
    const session = new SessionManager(baseConfig, logger, dir);
    (session as any).client = client;
    return session;
  }

  it("restores a persisted session when host, port, and user match", async () => {
    await writeSessionFile({ sessionId: "persisted", host: "test", port: 80, user: "Admin" });
    const client = createMockClient();
    client.call.mockResolvedValue(true); // Session.renew
    const session = createSessionWithDir(client);

    await session.login();

    expect(session.getSessionId()).toBe("persisted");
    expect(client.call).not.toHaveBeenCalledWith("Session.login", expect.anything());
    session.destroy();
  });

  // Regression: restore used to ignore the user (round-5 I-1)
  it("ignores a persisted session belonging to a different user", async () => {
    await writeSessionFile({ sessionId: "other-users", host: "test", port: 80, user: "SomeoneElse" });
    const client = createMockClient();
    client.call.mockImplementation(async (method: string) =>
      method === "Session.login" ? "fresh" : true);
    const session = createSessionWithDir(client);

    await session.login();

    expect(session.getSessionId()).toBe("fresh");
    expect(client.call).not.toHaveBeenCalledWith("Session.renew", expect.anything());
    session.destroy();
  });

  it("falls back to fresh login when the persisted session fails to renew", async () => {
    await writeSessionFile({ sessionId: "expired", host: "test", port: 80, user: "Admin" });
    const client = createMockClient();
    client.call.mockImplementation(async (method: string) => {
      if (method === "Session.renew") throw new Error("expired");
      if (method === "Session.login") return "fresh";
      return true;
    });
    const session = createSessionWithDir(client);

    await session.login();
    expect(session.getSessionId()).toBe("fresh");
    session.destroy();
  });

  // Regression: session file used to be world-readable (round-5 W-2)
  it("persists the session with mode 0600 and removes it on logout", async () => {
    const client = createMockClient();
    client.call.mockResolvedValue("sess-1");
    const session = createSessionWithDir(client);
    await session.login();

    const { stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const file = join(dir, "session.json");
    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);

    await session.logout();
    await expect(stat(file)).rejects.toThrow();
    session.destroy();
  });

  it("retries login on 'too many sessions' and succeeds", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    let attempts = 0;
    client.call.mockImplementation(async (method: string) => {
      if (method === "Session.login") {
        attempts++;
        if (attempts === 1) {
          throw new CcuError({ error: "AUTH", code: 400, message: "too many sessions", hint: "" });
        }
        return "second-try";
      }
      return true;
    });
    const session = createSessionWithDir(client);
    // Skip the fs-based restore so the retry timer is scheduled deterministically
    vi.spyOn(session as any, "tryRestoreSession").mockResolvedValue(false);

    const login = session.login();
    await vi.advanceTimersByTimeAsync(0); // first attempt fails, retry timer armed
    await vi.advanceTimersByTimeAsync(3_500); // fire the 3s retry delay
    await login;

    expect(session.getSessionId()).toBe("second-try");
    expect(attempts).toBe(2);
    session.destroy();
    vi.useRealTimers();
  });
});

describe("renewal double failure (coverage round)", () => {
  it("logs and survives when renewal and re-login both fail", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    client.call.mockResolvedValueOnce("sess-1"); // initial login
    const session = new SessionManager(baseConfig, logger, "/tmp/nonexistent-session-test-renewfail");
    (session as any).client = client;
    await session.login();

    client.call.mockRejectedValue(new Error("everything is down"));
    vi.spyOn(session as any, "tryRestoreSession").mockResolvedValue(false);

    await vi.advanceTimersByTimeAsync(60_000); // renew fails
    await vi.advanceTimersByTimeAsync(15_000); // login retries exhaust without throwing out of the timer

    expect(session.isLoggedIn()).toBe(true); // old session id kept; no crash
    session.destroy();
    vi.useRealTimers();
  });
});
