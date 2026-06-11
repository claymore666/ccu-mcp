import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CcuConfig } from "./types.js";
import { CcuClient } from "./client.js";
import { CcuError } from "../middleware/error-mapper.js";
import type { Logger } from "../logger.js";

const SESSION_RENEW_INTERVAL = 60_000; // Renew every 60s
const SESSION_FILE = "session.json";
const LOGIN_RETRY_DELAY = 3_000;
const LOGIN_MAX_RETRIES = 3;

export class SessionManager {
  private readonly client: CcuClient;
  private readonly config: CcuConfig;
  private readonly logger: Logger;
  private readonly cacheDir: string;
  private sessionId: string | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(config: CcuConfig, logger: Logger, cacheDir?: string) {
    this.config = config;
    this.client = new CcuClient(config, logger);
    this.logger = logger;
    this.cacheDir = cacheDir || "/tmp";
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
    // Try to reuse a persisted session first
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
    const paramsWithSession = { ...params, _session_id_: this.getSessionId() };

    try {
      return await this.client.call(method, paramsWithSession, timeout);
    } catch (err) {
      if (err instanceof CcuError && err.structured.error === "AUTH") {
        this.logger.warn("session_expired", { method });
        await this.login();
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
      const filePath = join(this.cacheDir, SESSION_FILE);
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
      const filePath = join(this.cacheDir, SESSION_FILE);
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
      await unlink(join(this.cacheDir, SESSION_FILE));
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
