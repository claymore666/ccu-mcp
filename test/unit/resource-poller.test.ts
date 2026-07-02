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
    const poller = new ResourcePoller(mocks.notify, () => mocks.session, mocks.rateLimiter, logger, 30);
    poller.start();
    poller.stop();
    // No throw, timer cleaned up
  });

  it("does not emit event on first poll (no previous hash)", async () => {
    const mocks = createMocks();
    mocks.session.call.mockResolvedValue([{ id: "1" }]);
    const poller = new ResourcePoller(mocks.notify, () => mocks.session, mocks.rateLimiter, logger, 10);
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

    const poller = new ResourcePoller(mocks.notify, () => mocks.session, mocks.rateLimiter, logger, 10);
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

    const poller = new ResourcePoller(mocks.notify, () => mocks.session, mocks.rateLimiter, logger, 10);
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

    const poller = new ResourcePoller(mocks.notify, () => mocks.session, mocks.rateLimiter, logger, 10);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000);

    // Should have been called for all 5 POLLABLE resources despite first failing
    expect(mocks.session.call.mock.calls.length).toBe(5);
    poller.stop();
  });

  it("acquires rate limiter before each resource poll", async () => {
    const mocks = createMocks();
    const poller = new ResourcePoller(mocks.notify, () => mocks.session, mocks.rateLimiter, logger, 10);
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
    const poller = new ResourcePoller(mocks.notify, () => mocks.session, mocks.rateLimiter, logger, 10);
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
    const poller = new ResourcePoller(mocks.notify, () => mocks.session, mocks.rateLimiter, logger, 10);
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

// Regression for the multi-CCU poller binding (#73): the poller must resolve
// the ACTIVE target's session on every cycle, so a use_ccu() switch is followed
// instead of forever polling the startup target.
describe("ResourcePoller follows the active target (multi-CCU)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("polls the session returned by the provider on each cycle, not a captured one", async () => {
    const notify = vi.fn(async () => {});
    const rateLimiter = { acquire: vi.fn(async () => {}) } as any;
    const sessionA = { call: vi.fn(async () => [{ ccu: "A" }]) } as any;
    const sessionB = { call: vi.fn(async () => [{ ccu: "B" }]) } as any;

    // Mutable "active" pointer, like targets.active in index.ts.
    let active = sessionA;
    const poller = new ResourcePoller(notify, () => active, rateLimiter, logger, 10);
    poller.start();

    // First cycle hits A.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessionA.call).toHaveBeenCalled();
    expect(sessionB.call).not.toHaveBeenCalled();

    // Switch the active target (use_ccu) — the next cycle must hit B, not A.
    const aCallsAtSwitch = sessionA.call.mock.calls.length;
    active = sessionB;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sessionB.call).toHaveBeenCalled();
    // A is no longer polled after the switch.
    expect(sessionA.call.mock.calls.length).toBe(aCallsAtSwitch);
    poller.stop();
  });

  it("notifies on a change to the now-active target after a switch", async () => {
    const notify = vi.fn(async () => {});
    const rateLimiter = { acquire: vi.fn(async () => {}) } as any;
    // A is static; B changes between cycles.
    const sessionA = { call: vi.fn(async () => [{ ccu: "A", static: true }]) } as any;
    let bValue = 0;
    const sessionB = { call: vi.fn(async () => [{ ccu: "B", v: bValue }]) } as any;

    let active = sessionA;
    const poller = new ResourcePoller(notify, () => active, rateLimiter, logger, 10);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_000); // baseline on A
    expect(notify).not.toHaveBeenCalled();

    // Switch to B; first B cycle re-baselines against B's data.
    active = sessionB;
    await vi.advanceTimersByTimeAsync(10_000);

    // Now change B and poll again — the change on the active target must notify.
    bValue = 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notify).toHaveBeenCalled();
    poller.stop();
  });
});
