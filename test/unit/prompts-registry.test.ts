import { describe, it, expect, vi } from "vitest";
import { createTestServer, cleanupDeps, getPrompt } from "./_helpers.js";

describe("prompt registry", () => {
  it("gives every prompt a display title as well as a description", () => {
    const { server, deps } = createTestServer();
    const prompts = (server as any)._registeredPrompts as Record<string, { title?: string; description?: string }>;
    expect(Object.keys(prompts).length).toBeGreaterThan(0);
    for (const [name, p] of Object.entries(prompts)) {
      expect(p.title, `prompt ${name} has no title`).toBeTruthy();
      expect(p.description, `prompt ${name} has no description`).toBeTruthy();
    }
    cleanupDeps(deps);
  });

  it("completes room and device arguments from the live CCU", async () => {
    // Driven through the SDK's own completion/complete handler, so this covers
    // the wiring (completable arguments → capability → handler), not just that
    // a completer function exists somewhere.
    const { server, deps } = createTestServer({
      sessionCall: vi.fn(async (method: string) =>
        method === "Room.getAll" ? [{ name: "Bad OG" }, { name: "Küche" }] : [{ name: "Heizung Bad" }],
      ),
    });
    const complete = (name: string, argument: { name: string; value: string }) =>
      (server.server as any)._requestHandlers.get("completion/complete")(
        { method: "completion/complete", params: { ref: { type: "ref/prompt", name }, argument } },
        {},
      );

    expect((await complete("room-status", { name: "room", value: "ba" })).completion.values).toEqual(["Bad OG"]);
    expect((await complete("set-heating", { name: "room", value: "" })).completion.values).toEqual(["Bad OG", "Küche"]);
    expect((await complete("device-info", { name: "device", value: "bad" })).completion.values).toEqual(["Heizung Bad"]);
    // A free-text argument stays free text — no suggestions, no error.
    expect((await complete("set-heating", { name: "temperature", value: "2" })).completion.values).toEqual([]);
    cleanupDeps(deps);
  });

  const STATIC_PROMPTS = [
    ["check-windows", "window and door sensors"],
    ["good-night", "Prepare the house for night"],
    ["diagnostics", "get_service_messages"],
  ] as const;

  for (const [name, marker] of STATIC_PROMPTS) {
    it(`${name} returns a user message mentioning "${marker}"`, async () => {
      const { server, deps } = createTestServer();
      const result: any = await getPrompt(server, name);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content.text).toContain(marker);
      cleanupDeps(deps);
    });
  }

  it("room-status interpolates the room argument", async () => {
    const { server, deps } = createTestServer();
    const result: any = await getPrompt(server, "room-status", { room: "Bad OG" });
    expect(result.messages[0].content.text).toContain('"Bad OG"');
    cleanupDeps(deps);
  });

  it("set-heating interpolates room and temperature", async () => {
    const { server, deps } = createTestServer();
    const result: any = await getPrompt(server, "set-heating", { room: "Küche", temperature: "21.5" });
    const text = result.messages[0].content.text;
    expect(text).toContain('"Küche"');
    expect(text).toContain("21.5°C");
    expect(text).toContain("SET_POINT_TEMPERATURE");
    cleanupDeps(deps);
  });

  it("device-info interpolates the device argument", async () => {
    const { server, deps } = createTestServer();
    const result: any = await getPrompt(server, "device-info", { device: "000A1BE9A71F15" });
    expect(result.messages[0].content.text).toContain('"000A1BE9A71F15"');
    cleanupDeps(deps);
  });
});
