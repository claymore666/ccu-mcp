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

    // Should complete immediately — 5 tokens available
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
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

    // The two genuinely-queued waiters are still pending; destroy releases them
    // so the test doesn't leak unsettled promises.
    limiter.destroy();
    await Promise.all([queued1, queued2]);
  });

  it("destroy releases waiting requests", async () => {
    limiter = new RateLimiter(0, 0); // No tokens, no refill

    let resolved = false;
    const promise = limiter.acquire().then(() => {
      resolved = true;
    });

    limiter.destroy();
    await promise;
    expect(resolved).toBe(true);
  });
});
