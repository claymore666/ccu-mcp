import { describe, it, expect, afterEach } from "vitest";
import { RateLimiter } from "../../src/middleware/rate-limiter.js";
import { CcuError } from "../../src/middleware/error-mapper.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it("allows burst of requests up to max", async () => {
    limiter = new RateLimiter(5, 10);

    // 5 tokens available, so all 5 must be granted without waiting for a
    // refill. Asserting on elapsed time is the point: without it this test
    // passes even if the limiter blocks on every acquire, because a slow
    // acquire still resolves eventually. Refill here is 10/s (100ms apart), so
    // a single queued token would push this well past the bound.
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("queues requests when tokens exhausted", async () => {
    limiter = new RateLimiter(1, 100); // 1 token, fast refill

    await limiter.acquire(); // Use the one token

    // Next acquire should wait for refill
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;

    // Should have waited a bit (at least one refill cycle of 100ms)
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it("rejects with RATE_LIMITED once the wait queue is full", async () => {
    // 0 tokens, no refill, queue capped at 2: the first 2 acquires park, the
    // 3rd exceeds the cap and must reject rather than grow the queue.
    limiter = new RateLimiter(0, 0, 2);

    const queued1 = limiter.acquire();
    const queued2 = limiter.acquire();

    await expect(limiter.acquire()).rejects.toBeInstanceOf(CcuError);
    await limiter.acquire().catch((err) => {
      expect(err).toBeInstanceOf(CcuError);
      expect((err as CcuError).structured.error).toBe("RATE_LIMITED");
    });

    // The two genuinely-queued waiters are still pending; destroy settles them
    // (by rejection) so the test doesn't leak unsettled promises.
    limiter.destroy();
    await expect(queued1).rejects.toBeInstanceOf(CcuError);
    await expect(queued2).rejects.toBeInstanceOf(CcuError);
  });

  it("destroy rejects waiting requests (shutdown must not fire queued CCU calls)", async () => {
    limiter = new RateLimiter(0, 0); // No tokens, no refill

    const promise = limiter.acquire();

    limiter.destroy();
    await expect(promise).rejects.toBeInstanceOf(CcuError);
    await promise.catch((err) => {
      expect((err as CcuError).structured.message).toMatch(/shutting down/);
    });
  });

  it("acquire after destroy rejects instead of re-arming the refill timer", async () => {
    // A tool's SECOND acquire racing shutdown must fail like the queued
    // waiters did — not park in a fresh queue and fire into a session being
    // logged out.
    limiter = new RateLimiter(10, 10);
    limiter.destroy();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(CcuError);
    await limiter.acquire().catch((err) => {
      expect((err as CcuError).structured.message).toMatch(/shutting down/);
    });
  });
});
