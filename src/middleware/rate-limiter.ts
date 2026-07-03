import { CcuError } from "./error-mapper.js";

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly maxQueue: number;
  private lastRefill: number;
  private waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private refillTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(maxBurst: number = 20, refillRate: number = 10, maxQueue: number = 1000) {
    this.maxTokens = maxBurst;
    this.tokens = maxBurst;
    this.refillRate = refillRate;
    // Backpressure bound: callers waiting on a token queue here. Without a cap a
    // sustained flood (faster than refillRate) grows the queue — and the pending
    // promises behind it — without limit. The cap is deliberately generous (a
    // backstop, not normal-load shaping); past it acquire() rejects so a caller
    // fails fast with a clear error instead of parking on an ever-growing queue.
    this.maxQueue = maxQueue;
    this.lastRefill = Date.now();

    // Start refill timer only when there are queued requests
  }

  private ensureRefillTimer(): void {
    if (!this.refillTimer && this.waitQueue.length > 0) {
      this.refillTimer = setInterval(() => {
        this.refill();
        if (this.waitQueue.length === 0 && this.refillTimer) {
          clearInterval(this.refillTimer);
          this.refillTimer = null;
        }
      }, 100);
      this.refillTimer.unref();
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;

    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);

    // Wake up waiting requests
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const waiter = this.waitQueue.shift()!;
      waiter.resolve();
    }
  }

  async acquire(): Promise<void> {
    // A post-destroy acquire (e.g. a tool's SECOND acquire racing shutdown)
    // must fail like the queued waiters did — re-arming the refill timer and
    // firing the call into a session being logged out would produce a
    // confusing AUTH/UNREACHABLE error instead of this clean rejection.
    if (this.destroyed) {
      throw new CcuError({
        error: "CCU_ERROR",
        code: 0,
        message: "Server is shutting down; the request was cancelled.",
        hint: "Retry after the server restarts.",
      });
    }
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // At capacity — refuse rather than queue unboundedly. RATE_LIMITED is not
    // retriable (see retry.ts), so a flooded caller fails fast instead of
    // looping back into the same full queue.
    if (this.waitQueue.length >= this.maxQueue) {
      throw new CcuError({
        error: "RATE_LIMITED",
        code: 0,
        message: "Too many requests queued for the CCU; the server is overloaded.",
        hint: "Reduce concurrent calls and retry shortly. Raise CCU_RATE_LIMIT_BURST/RATE if this is sustained legitimate load.",
      });
    }

    // Wait for a token to become available
    return new Promise<void>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
      this.ensureRefillTimer();
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    // REJECT waiting requests instead of releasing them: destroy() runs during
    // shutdown, and an unthrottled release would fire the queued CCU calls
    // into a session that is being logged out — confusing AUTH/UNREACHABLE
    // errors instead of a clean "shutting down" failure.
    for (const waiter of this.waitQueue) {
      waiter.reject(new CcuError({
        error: "CCU_ERROR",
        code: 0,
        message: "Server is shutting down; the queued request was cancelled.",
        hint: "Retry after the server restarts.",
      }));
    }
    this.waitQueue = [];
  }
}
