import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CompletionSource } from "../../src/prompts/completions.js";
import { createMockDeps, cleanupDeps } from "./_helpers.js";

// completion/complete fires per keystroke, so the two properties that matter
// are that it never throws at the caller and that typing does not turn into one
// CCU round-trip per character.

const ROOMS = [{ name: "Bad OG" }, { name: "Küche" }, { name: "Wohnzimmer" }, { noName: true }];
const DEVICES = [{ name: "Heizung Bad" }, { name: "Fenster Küche" }, { address: "ABC:1" }];

function sourceWith(call: (method: string) => Promise<unknown>) {
  const sessionCall = vi.fn(async (method: string) => call(method));
  const deps = createMockDeps({ sessionCall });
  return { source: new CompletionSource(deps), deps, sessionCall };
}

describe("prompt argument completions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suggests room names matching what has been typed, case-insensitively", async () => {
    const { source, deps } = sourceWith(async () => ROOMS);
    expect(await source.rooms("ba")).toEqual(["Bad OG"]);
    cleanupDeps(deps);
  });

  it("matches anywhere in the name, not just its start", async () => {
    // CCU names carry a floor prefix ("OG Bad Heizung"), so a user typing the
    // room means the middle of the string at least as often as its head.
    const { source, deps } = sourceWith(async () => [{ name: "OG Bad Heizung" }]);
    expect(await source.rooms("bad")).toEqual(["OG Bad Heizung"]);
    cleanupDeps(deps);
  });

  it("returns every name for an empty value (the SDK caps the list at 100)", async () => {
    const { source, deps } = sourceWith(async () => ROOMS);
    expect(await source.rooms("")).toEqual(["Bad OG", "Küche", "Wohnzimmer"]);
    cleanupDeps(deps);
  });

  it("skips rows without a usable name instead of suggesting undefined", async () => {
    const { source, deps } = sourceWith(async () => ROOMS);
    expect(await source.rooms("")).not.toContain(undefined);
    cleanupDeps(deps);
  });

  it("suggests device names from the device list", async () => {
    const { source, deps, sessionCall } = sourceWith(async () => DEVICES);
    expect(await source.devices("küche")).toEqual(["Fenster Küche"]);
    expect(sessionCall).toHaveBeenCalledWith("Device.listAllDetail");
    cleanupDeps(deps);
  });

  it("serves a burst of keystrokes from one CCU call", async () => {
    const { source, deps, sessionCall } = sourceWith(async () => ROOMS);
    await source.rooms("b");
    await source.rooms("ba");
    await source.rooms("bad");
    expect(sessionCall).toHaveBeenCalledTimes(1);
    cleanupDeps(deps);
  });

  it("re-reads the CCU once the cached list goes stale", async () => {
    const { source, deps, sessionCall } = sourceWith(async () => ROOMS);
    await source.rooms("b");
    vi.setSystemTime(Date.now() + 61_000);
    await source.rooms("b");
    expect(sessionCall).toHaveBeenCalledTimes(2);
    cleanupDeps(deps);
  });

  it("keeps room and device lists apart", async () => {
    const { source, deps, sessionCall } = sourceWith(async (method) =>
      method === "Room.getAll" ? ROOMS : DEVICES,
    );
    expect(await source.rooms("küche")).toEqual(["Küche"]);
    expect(await source.devices("küche")).toEqual(["Fenster Küche"]);
    expect(sessionCall).toHaveBeenCalledTimes(2);
    cleanupDeps(deps);
  });

  it("answers with no suggestions when the CCU is unreachable", async () => {
    const { source, deps } = sourceWith(async () => { throw new Error("unreachable"); });
    await expect(source.rooms("b")).resolves.toEqual([]);
    cleanupDeps(deps);
  });

  it("answers with no suggestions when the CCU returns a non-list", async () => {
    const { source, deps } = sourceWith(async () => null);
    await expect(source.rooms("b")).resolves.toEqual([]);
    cleanupDeps(deps);
  });

  it("does not cache a failure — the next keystroke retries", async () => {
    let fail = true;
    const { source, deps, sessionCall } = sourceWith(async () => {
      if (fail) throw new Error("down");
      return ROOMS;
    });
    expect(await source.rooms("b")).toEqual([]);
    fail = false;
    expect(await source.rooms("b")).toEqual(["Bad OG"]);
    expect(sessionCall).toHaveBeenCalledTimes(2);
    cleanupDeps(deps);
  });
});
