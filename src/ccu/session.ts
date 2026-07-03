import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CcuConfig } from "./types.js";
import { CcuClient } from "./client.js";
import { CcuError } from "../middleware/error-mapper.js";
import type { Logger } from "../logger.js";

const SESSION_RENEW_INTERVAL = 60_000; // Renew every 60s
const DEFAULT_SESSION_FILE = "session.json";
const LOGIN_RETRY_DELAY = 3_000;
const LOGIN_MAX_RETRIES = 3;

export class SessionManager {
  private readonly client: CcuClient;
  private readonly config: CcuConfig;
  private readonly logger: Logger;
  private readonly cacheDir: string;
  private readonly sessionFile: string;
  private sessionId: string | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(config: CcuConfig, logger: Logger, cacheDir?: string, sessionFile?: string) {
    this.config = config;
    this.client = new CcuClient(config, logger);
    this.logger = logger;
    this.cacheDir = cacheDir || "/tmp";
    // Per-target session file so multiple SessionManagers don't fight over one
    // session.json (each target's session is keyed by host/port/user too).
    this.sessionFile = sessionFile || DEFAULT_SESSION_FILE;
  }

  /**
   * Single-flight: concurrent callers (parallel tool calls hitting AUTH,
   * the renewal timer) share one login instead of stampeding Session.login,
   * which is what drives the CCU into "too many sessions".
   */
  async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async doLogin(): Promise<void> {
    // Reuse the in-memory session if the CCU still accepts it. This matters
    // when re-login was triggered by a 400 that was really a privilege denial
    // (the session is fine, the user just may not call that method): minting a
    // fresh session would leak the old one and drive the CCU toward its
    // session limit. A dead session is cleared so /health reflects reality.
    if (this.sessionId) {
      try {
        await this.client.call("Session.renew", { _session_id_: this.sessionId });
        return;
      } catch {
        this.sessionId = null;
      }
    }

    // Try to reuse a persisted session next
    const restored = await this.tryRestoreSession();
    if (restored) return;

    // Fresh login with retry on "too many sessions"
    for (let attempt = 0; attempt <= LOGIN_MAX_RETRIES; attempt++) {
      try {
        const result = await this.client.call("Session.login", {
          username: this.config.user,
          password: this.config.password,
        });

        this.sessionId = result as string;
        this.logger.info("session_login", { sessionActive: true });
        this.startRenewal();
        await this.persistSession();
        return;
      } catch (err) {
        if (err instanceof CcuError && err.structured.message?.includes("too many sessions")) {
          if (attempt < LOGIN_MAX_RETRIES) {
            this.logger.warn("session_too_many", { attempt: attempt + 1, retryIn: LOGIN_RETRY_DELAY });
            await new Promise((r) => setTimeout(r, LOGIN_RETRY_DELAY));
            continue;
          }
          // Out of retries. The CCU returns this single 501 message for BOTH
          // wrong credentials and session exhaustion (occu login.tcl), so
          // surface it as an auth problem instead of "CCU internal error. Try
          // again" — a mistyped password must not read as a transient fault.
          throw new CcuError({
            ...err.structured,
            error: "AUTH",
            hint:
              "The CCU reports one error for both invalid credentials and too many sessions. " +
              "Verify CCU_USER/CCU_PASSWORD first; if they are correct, wait a few minutes " +
              "for stale CCU sessions to expire and try again.",
          });
        }
        throw err;
      }
    }
  }

  async logout(): Promise<void> {
    this.stopRenewal();
    if (this.sessionId) {
      try {
        await this.client.call("Session.logout", { _session_id_: this.sessionId });
        this.logger.info("session_logout");
      } catch {
        this.logger.warn("session_logout_failed");
      }
      this.sessionId = null;
      await this.clearPersistedSession();
    }
  }

  getSessionId(): string {
    if (!this.sessionId) {
      throw new CcuError({
        error: "AUTH",
        code: 0,
        message: "No active session",
        hint: "Session not initialized. The server may still be starting.",
      });
    }
    return this.sessionId;
  }

  async call(method: string, params: Record<string, unknown> = {}, timeout?: number): Promise<unknown> {
    // Lazy login: the server starts even when the CCU is unreachable, so the
    // first call after a failed startup (or a CCU outage) re-attempts login.
    if (!this.isLoggedIn()) {
      await this.login();
    }
    const paramsWithSession = { ...params, _session_id_: this.getSessionId() };

    try {
      return await this.client.call(method, paramsWithSession, timeout);
    } catch (err) {
      if (err instanceof CcuError && err.structured.error === "AUTH") {
        // The CCU answers 400 "access denied" both for an expired session and
        // for a valid session whose user lacks the method's privilege level.
        // Re-login distinguishes them: if it comes back with the SAME session
        // id THE FAILED REQUEST USED, that session was never invalid — the 400
        // was a permission denial and retrying would fail identically. Compare
        // against the id the request carried (not this.sessionId at catch
        // time): a concurrent re-login may already have swapped in a new id,
        // and then the right move is to retry with it, not to report a
        // privilege problem.
        const usedSid = paramsWithSession._session_id_;
        await this.login();
        if (this.sessionId !== null && this.sessionId === usedSid) {
          throw new CcuError({
            error: "AUTH",
            code: err.structured.code,
            message: `Access denied for ${method}: the CCU user lacks the required privilege level`,
            hint:
              "The session is valid but the configured CCU user may not call this method " +
              "(e.g. script execution needs an ADMIN-level user). Configure a user with " +
              "sufficient rights or avoid this tool.",
            ccuMethod: method,
          });
        }
        this.logger.warn("session_expired", { method });
        const retryParams = { ...params, _session_id_: this.getSessionId() };
        return this.client.call(method, retryParams, timeout);
      }
      throw err;
    }
  }

  async callNoSession(method: string, params: Record<string, unknown> = {}, timeout?: number): Promise<unknown> {
    return this.client.call(method, params, timeout);
  }

  isLoggedIn(): boolean {
    return this.sessionId !== null;
  }

  private async tryRestoreSession(): Promise<boolean> {
    try {
      const filePath = join(this.cacheDir, this.sessionFile);
      const data = JSON.parse(await readFile(filePath, "utf-8"));

      if (data.sessionId && data.host === this.config.host && data.port === this.config.port
          && data.user === this.config.user) {
        // Test if session is still valid
        try {
          await this.client.call("Session.renew", { _session_id_: data.sessionId });
          this.sessionId = data.sessionId;
          this.logger.info("session_restored", { sessionId: "***" });
          this.startRenewal();
          return true;
        } catch {
          this.logger.info("session_restore_expired");
        }
      }
    } catch {
      // No persisted session or file doesn't exist
    }
    return false;
  }

  private async persistSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const filePath = join(this.cacheDir, this.sessionFile);
      const tmpPath = filePath + ".tmp";
      const data = JSON.stringify({
        sessionId: this.sessionId,
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        timestamp: new Date().toISOString(),
      });
      // 0600: the session ID grants full admin access to the CCU
      await writeFile(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
      await rename(tmpPath, filePath);
    } catch {
      // Best effort — don't fail if we can't persist
    }
  }

  private async clearPersistedSession(): Promise<void> {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(join(this.cacheDir, this.sessionFile));
    } catch {
      // Ignore
    }
  }

  private startRenewal(): void {
    this.stopRenewal();
    this.renewTimer = setInterval(async () => {
      if (!this.sessionId) return;
      try {
        await this.client.call("Session.renew", { _session_id_: this.sessionId });
        this.logger.debug("session_renewed");
      } catch {
        this.logger.warn("session_renew_failed");
        try {
          await this.login();
        } catch (loginErr) {
          this.logger.error("session_relogin_failed", { error: (loginErr as Error).message });
        }
      }
    }, SESSION_RENEW_INTERVAL);
    this.renewTimer.unref();
  }

  private stopRenewal(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  destroy(): void {
    this.stopRenewal();
  }
}
