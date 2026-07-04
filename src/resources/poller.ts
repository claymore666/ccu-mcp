import { createHash } from "node:crypto";
import type { SessionManager } from "../ccu/session.js";
import type { RateLimiter } from "../middleware/rate-limiter.js";
import type { Logger } from "../logger.js";
import { withRetry } from "../middleware/retry.js";

interface PollableResource {
  uri: string;
  method: string;
}

// Only mutable CCU resources are polled. Static/rarely-changing resources are excluded:
// - homematic://system: server version + CCU firmware, changes only on deliberate upgrades
// - homematic://device-types: cache managed separately by DeviceTypeCache
const POLLABLE: PollableResource[] = [
  { uri: "homematic://devices", method: "Device.listAllDetail" },
  { uri: "homematic://rooms", method: "Room.getAll" },
  { uri: "homematic://functions", method: "Subsection.getAll" },
  { uri: "homematic://programs", method: "Program.getAll" },
  { uri: "homematic://sysvars", method: "SysVar.getAll" },
  { uri: "homematic://interfaces", method: "Interface.listInterfaces" },
];

// Backoff: 1×, 2×, 4×, 8×, capped at 10× the base interval
const MAX_BACKOFF_MULTIPLIER = 10;

export class ResourcePoller {
  private hashes = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Tracks which session the hashes belong to: after a use_ccu switch the new
  // target's data must become the fresh baseline, not be diffed against the
  // OLD target's hashes (which would fire one spurious update per resource).
  private hashedSession: SessionManager | null = null;
  // Counts consecutive poll cycles where at least one resource failed.
  // Used to apply exponential backoff on the next schedule.
  private consecutiveFailures = 0;

  constructor(
    // Called with the URIs whose CONTENT changed. In stdio mode this notifies
    // the single server; in HTTP mode it fans out to all active MCP sessions.
    // Consumers send notifications/resources/updated per subscribed URI — the
    // resource LIST is static, so list_changed would be the wrong signal.
    private readonly notifyChanged: (changedUris: string[]) => Promise<void>,
    // Resolved on every cycle (not captured once). In stdio mode this follows
    // the single session's use_ccu() switch; in HTTP mode it deliberately pins
    // the DEFAULT target — many MCP sessions share one poller, so there is no
    // single "active" target to follow there.
    private readonly getSession: () => SessionManager,
    private readonly rateLimiter: RateLimiter,
    private readonly logger: Logger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.schedule(this.intervalMs * 1000);
    this.logger.info("resource_poller_started", { interval_s: this.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.poll().finally(() => {
        if (this.timer !== null) {
          // still running (not stopped)
          const multiplier = this.consecutiveFailures > 0
            ? Math.min(Math.pow(2, this.consecutiveFailures - 1), MAX_BACKOFF_MULTIPLIER)
            : 1;
          this.schedule(this.intervalMs * 1000 * multiplier);
        }
      });
    }, delayMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    const changedUris: string[] = [];
    let anyFailed = false;

    const session = this.getSession();
    if (this.hashedSession !== session) {
      this.hashes.clear();
      this.hashedSession = session;
    }

    for (const resource of POLLABLE) {
      try {
        await this.rateLimiter.acquire();
        const data = await withRetry(
          () => session.call(resource.method),
          resource.method,
          this.logger,
          { rateLimiter: this.rateLimiter },
        );
        const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");

        const prev = this.hashes.get(resource.uri);
        this.hashes.set(resource.uri, hash);

        if (prev && prev !== hash) {
          this.logger.info("resource_changed", { uri: resource.uri });
          changedUris.push(resource.uri);
        }
      } catch (err) {
        anyFailed = true;
        this.logger.warn("resource_poll_failed", { uri: resource.uri, error: (err as Error).message });
      }
    }

    if (anyFailed) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures === 5) {
        this.logger.error("resource_poll_repeated_failures", { count: 5 });
      }
    } else {
      this.consecutiveFailures = 0;
    }

    if (changedUris.length > 0) {
      try {
        await this.notifyChanged(changedUris);
      } catch (err) {
        this.logger.warn("resource_notify_failed", { error: (err as Error).message });
      }
    }
  }
}
