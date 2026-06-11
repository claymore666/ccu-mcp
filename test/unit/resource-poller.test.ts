import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResourcePoller } from "../../src/resources/poller.js";
import { Logger } from "../../src/logger.js";

const logger = new Logger("error");

function createMocks() {
  return {
    notify: vi.fn(async () => {}),
    session: { call: vi.fn(async () => []) } as any,
    rateLimiter: { acquire: vi.fn(async () => {}) } as any,
  };
}

describe("ResourcePoller", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("start sets interval and stop clears it", () => {
    const mocks = createMocks();
    const poller = new ResourcePoller(mocks.notify, mocks.session, mocks.rateLimiter, logger, 30);
    poller.start();
    poller.stop();
    // No throw, timer cleaned up
  });

  it("does not emit event on first poll (no previous hash)", async () => {
    const mocks = createMocks();
    mocks.session.call.mockResolvedValue([{ id: "1" }]);
    const poller = new ResourcePoller(mocks.notify, mocks.session, mocks.rateLimiter, logger, 10);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.notify).not.toHaveBeenCalled();
    poller.stop();
  });

  it("emits sendResourceListChanged when data hash changes", async () => {
    const mocks = createMocks();
    let callCount = 0;
    mocks.session.call.mockImplementation(async () => {
      callCount++;
      return [{ data: callCount }]; // different on each call
    });

    const poller = new ResourcePoller(mocks.notify, mocks.session, mocks.rateLimiter, logger, 10);
    poller.start();

    // First poll — sets baseline hashes
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.notify).not.toHaveBeenCalled();

    // Second poll — data changed
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.notify).toHaveBeenCalled();
    poller.stop();
  });

  it("does not emit event when data is unchanged", async () => {
    const mocks = createMocks();
    mocks.session.call.mockResolvedValue([{ data: "static" }]);

    const poller = new ResourcePoller(mocks.notify, mocks.session, mocks.rateLimiter, logger, 10);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000); // first poll
    await vi.advanceTimersByTimeAsync(10_000); // second poll — same data

    expect(mocks.notify).not.toHaveBeenCalled();
    poller.stop();
  });

  it("failure in one resource does not stop polling others", async () => {
    const mocks = createMocks();
    let callIdx = 0;
    mocks.session.call.mockImplementation(async (method: string) => {
      callIdx++;
      if (method === "Device.listAllDetail") throw new Error("fail");
      return [];
    });

    const poller = new ResourcePoller(mocks.notify, mocks.session, mocks.rateLimiter, logger, 10);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000);

    // Should have been called for all 5 POLLABLE resources despite first failing
    expect(mocks.session.call.mock.calls.length).toBe(5);
    poller.stop();
  });

  it("acquires rate limiter before each resource poll", async () => {
    const mocks = createMocks();
    const poller = new ResourcePoller(mocks.notify, mocks.session, mocks.rateLimiter, logger, 10);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000);

    // 5 resources = 5 acquire calls
    expect(mocks.rateLimiter.acquire).toHaveBeenCalledTimes(5);
    poller.stop();
  });
});

describe("ResourcePoller backoff and notify failure (coverage round)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("applies exponential backoff after consecutive failures and resets on success", async () => {
    const mocks = createMocks();
    mocks.session.call.mockRejectedValue(new Error("ccu down"));
    const poller = new ResourcePoller(mocks.notify, mocks.session, mocks.rateLimiter, logger, 10);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000); // first cycle fails
    expect((poller as any).consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000); // backoff 1x -> second cycle fails
    expect((poller as any).consecutiveFailures).toBe(2);
    // next delay is now 2x base; nothing fires after 1x
    const callsBefore = mocks.session.call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.session.call.mock.calls.length).toBe(callsBefore);

    mocks.session.call.mockResolvedValue([{ ok: true }]);
    await vi.advanceTimersByTimeAsync(10_000); // completes the 2x window -> success
    expect((poller as any).consecutiveFailures).toBe(0);
    poller.stop();
  });

  it("swallows notify failures and keeps polling", async () => {
    const mocks = createMocks();
    let value = 0;
    mocks.session.call.mockImplementation(async () => [{ v: value }]);
    mocks.notify.mockRejectedValue(new Error("no transport"));
    const poller = new ResourcePoller(mocks.notify, mocks.session, mocks.rateLimiter, logger, 10);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000); // baseline hashes
    value = 1;
    await vi.advanceTimersByTimeAsync(10_000); // change -> notify rejects, must not throw
    expect(mocks.notify).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000); // still polling
    expect((poller as any).consecutiveFailures).toBe(0);
    poller.stop();
  });
});
