import { describe, it, expect, afterEach } from "vitest";
import { createTestServer, callTool, parseToolResult, cleanupDeps } from "./_helpers.js";
import type { ServerDeps } from "../../src/server.js";

describe("CCU target tools (issue #69)", () => {
  let deps: ServerDeps;
  afterEach(() => deps && cleanupDeps(deps));

  function twoTargets() {
    return createTestServer({
      targets: [
        { name: "prod", protected: true, password: "PROD-SECRET", sessionCall: async () => "prod-ok" },
        { name: "dev", sessionCall: async () => "dev-ok" },
      ],
    });
  }

  it("list_ccu_targets lists all targets, marks the active one, never leaks passwords", async () => {
    const t = twoTargets(); deps = t.deps;
    const res = parseToolResult(await callTool(t.server, "list_ccu_targets")) as any;
    expect(res.active).toBe("prod");
    expect(res.targets.map((x: any) => x.name)).toEqual(["prod", "dev"]);
    const prod = res.targets.find((x: any) => x.name === "prod");
    expect(prod.active).toBe(true);
    expect(prod.protected).toBe(true);
    expect(prod).not.toHaveProperty("password");
    // Hard redaction guard: the password must not appear anywhere in the output.
    expect(JSON.stringify(res)).not.toContain("PROD-SECRET");
  });

  it("get_connection_info reports the active target", async () => {
    const t = twoTargets(); deps = t.deps;
    const res = parseToolResult(await callTool(t.server, "get_connection_info")) as any;
    expect(res.name).toBe("prod");
    expect(res.active).toBe(true);
    expect(res.protected).toBe(true);
    expect(JSON.stringify(res)).not.toContain("PROD-SECRET");
  });

  it("use_ccu switches the active target and routes later calls to it", async () => {
    const t = twoTargets(); deps = t.deps;
    const switched = parseToolResult(await callTool(t.server, "use_ccu", { profile: "dev" })) as any;
    expect(switched.name).toBe("dev");
    expect(switched.active).toBe(true);

    // get_connection_info now reflects dev
    const info = parseToolResult(await callTool(t.server, "get_connection_info")) as any;
    expect(info.name).toBe("dev");

    // a read now hits the dev session
    const val = parseToolResult(await callTool(t.server, "get_value", { address: "ABC:1", valueKey: "STATE", interface: "X" })) as any;
    expect(val.value).toBe("dev-ok");
  });

  it("use_ccu on an unknown target returns a NOT_FOUND error", async () => {
    const t = twoTargets(); deps = t.deps;
    const res: any = await callTool(t.server, "use_ccu", { profile: "nope" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("NOT_FOUND");
  });

  it("per-call target reads another target without switching the active one", async () => {
    const t = twoTargets(); deps = t.deps;
    // active is prod; read dev via the per-call target override
    const val = parseToolResult(await callTool(t.server, "get_value", { address: "ABC:1", valueKey: "STATE", interface: "X", target: "dev" })) as any;
    expect(val.value).toBe("dev-ok");
    // active is still prod
    const info = parseToolResult(await callTool(t.server, "get_connection_info")) as any;
    expect(info.name).toBe("prod");
  });
});

describe("protected-target write guard (issue #69)", () => {
  let deps: ServerDeps;
  afterEach(() => deps && cleanupDeps(deps));

  it("refuses a write to a protected target without confirm:true", async () => {
    const t = createTestServer({ protected: true, sessionCall: async () => "ok" });
    deps = t.deps;
    const res: any = await callTool(t.server, "set_value", { address: "ABC:1", valueKey: "STATE", value: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("protected");
  });

  it("allows the write with confirm:true and stays unlocked for the session", async () => {
    let writes = 0;
    const t = createTestServer({
      protected: true,
      sessionCall: async (method: string) => { if (method === "Interface.setValue") writes++; return null; },
    });
    deps = t.deps;

    const ok: any = await callTool(t.server, "set_value", { address: "ABC:1", valueKey: "STATE", value: true, interface: "X", type: "bool", confirm: true });
    expect(ok.isError).toBeFalsy();
    expect(writes).toBe(1);

    // second write needs no confirm (unlocked for this session)
    const ok2: any = await callTool(t.server, "set_value", { address: "ABC:1", valueKey: "STATE", value: false, interface: "X", type: "bool" });
    expect(ok2.isError).toBeFalsy();
    expect(writes).toBe(2);
  });

  it("a read-only target refuses writes even with confirm:true", async () => {
    const t = createTestServer({ readonly: true, sessionCall: async () => null });
    deps = t.deps;
    const res: any = await callTool(t.server, "set_value", { address: "ABC:1", valueKey: "STATE", value: true, interface: "X", type: "bool", confirm: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("read-only");
  });

  it("an unprotected target writes without confirm", async () => {
    let writes = 0;
    const t = createTestServer({
      sessionCall: async (method: string) => { if (method === "Interface.setValue") writes++; return null; },
    });
    deps = t.deps;
    const ok: any = await callTool(t.server, "set_value", { address: "ABC:1", valueKey: "STATE", value: true, interface: "X", type: "bool" });
    expect(ok.isError).toBeFalsy();
    expect(writes).toBe(1);
  });
});
