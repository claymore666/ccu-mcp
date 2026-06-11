import { describe, it, expect, vi } from "vitest";
import { createTestServer, cleanupDeps, readResource } from "./_helpers.js";

const CCU_RESPONSES: Record<string, unknown> = {
  "Device.listAllDetail": [{ id: "1", name: "Dev" }],
  "Room.getAll": [{ id: "r1", name: "Bad" }],
  "Subsection.getAll": [{ id: "f1", name: "Heizung" }],
  "Program.getAll": [{ id: "p1", name: "Prog" }],
  "SysVar.getAll": [{ id: "v1", name: "Var" }],
  "Interface.listInterfaces": [{ name: "HmIP-RF", port: 2010 }],
  "CCU.getVersion": "3.85.7",
  "CCU.getSerial": "NEQ123",
};

function createServerWithCcu() {
  return createTestServer({
    sessionCall: vi.fn().mockImplementation(async (method: string) => CCU_RESPONSES[method] ?? null),
  });
}

describe("resource registry", () => {
  const DATA_RESOURCES = [
    ["homematic://devices", "Dev"],
    ["homematic://rooms", "Bad"],
    ["homematic://functions", "Heizung"],
    ["homematic://programs", "Prog"],
    ["homematic://sysvars", "Var"],
    ["homematic://interfaces", "HmIP-RF"],
  ] as const;

  for (const [uri, marker] of DATA_RESOURCES) {
    it(`${uri} returns CCU data as JSON`, async () => {
      const { server, deps } = createServerWithCcu();
      const result: any = await readResource(server, uri);

      expect(result.contents[0].uri).toBe(uri);
      expect(result.contents[0].mimeType).toBe("application/json");
      const parsed = JSON.parse(result.contents[0].text);
      expect(JSON.stringify(parsed)).toContain(marker);
      cleanupDeps(deps);
    });
  }

  it("homematic://device-types serves the local cache", async () => {
    const { server, deps } = createServerWithCcu();
    const result: any = await readResource(server, "homematic://device-types");
    expect(JSON.parse(result.contents[0].text)).toEqual({});
    cleanupDeps(deps);
  });

  it("homematic://system returns version and serial, with serverVersion", async () => {
    const { server, deps } = createServerWithCcu();
    const result: any = await readResource(server, "homematic://system");
    const info = JSON.parse(result.contents[0].text);
    expect(info.version).toBe("3.85.7");
    expect(info.serial).toBe("NEQ123");
    expect(info.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
    cleanupDeps(deps);
  });

  it("homematic://system degrades to null fields when CCU calls fail", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockRejectedValue(new Error("unreachable")),
    });
    const result: any = await readResource(server, "homematic://system");
    const info = JSON.parse(result.contents[0].text);
    expect(info.version).toBeNull();
    expect(info.serial).toBeNull();
    cleanupDeps(deps);
  });
});
