import { describe, it, expect } from "vitest";
import { createTestServer, cleanupDeps, getPrompt } from "./_helpers.js";

describe("prompt registry", () => {
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
