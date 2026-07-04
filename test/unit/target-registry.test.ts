import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TargetRegistry, TargetSelection, resolveTarget, assertWritable } from "../../src/ccu/target-registry.js";
import { Logger } from "../../src/logger.js";
import type { AppConfig } from "../../src/config.js";
import type { CcuProfile } from "../../src/ccu/types.js";
import { CcuError } from "../../src/middleware/error-mapper.js";

const logger = new Logger("error");

function profile(name: string, opts?: Partial<Pick<CcuProfile, "protected" | "readonly">>): CcuProfile {
  return {
    name,
    protected: opts?.protected ?? false,
    readonly: opts?.readonly ?? false,
    ccu: { host: `${name}-host`, port: 80, https: false, tlsVerify: false, user: "Admin", password: "", timeout: 5000, scriptTimeout: 10000 },
  };
}

function appConfig(profiles: CcuProfile[], defaultProfile: string, cacheDir: string): AppConfig {
  return {
    ccu: profiles.find((p) => p.name === defaultProfile)!.ccu,
    profiles,
    defaultProfile,
    mcp: { transport: "stdio", port: 3000, allowedOrigins: [], allowedHosts: [], allowPlaintext: false, authTokenGraceMs: 86400000 },
    cache: { dir: cacheDir, ttl: 86400 },
    rateLimiter: { burst: 20, rate: 10 },
    resourcePollInterval: 60,
  };
}

describe("TargetRegistry", () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "ccu-registry-")); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it("builds one target per profile and makes the default active", () => {
    const reg = new TargetRegistry(appConfig([profile("prod", { protected: true }), profile("dev")], "prod", tempDir), logger, tempDir);
    expect(reg.list().map((t) => t.profile.name)).toEqual(["prod", "dev"]);
    expect(reg.default.profile.name).toBe("prod");
    expect(reg.default.profile.protected).toBe(true);
    // A fresh per-MCP-session selection starts on the default target.
    const sel = new TargetSelection(reg);
    expect(sel.active.profile.name).toBe("prod");
  });

  it("getByName / has are case-insensitive; unknown is undefined", () => {
    const reg = new TargetRegistry(appConfig([profile("Prod"), profile("dev")], "Prod", tempDir), logger, tempDir);
    expect(reg.getByName("prod")!.profile.name).toBe("Prod");
    expect(reg.has("DEV")).toBe(true);
    expect(reg.getByName("nope")).toBeUndefined();
    expect(reg.has("nope")).toBe(false);
  });

  it("use() switches only that selection's active target and returns it", () => {
    const reg = new TargetRegistry(appConfig([profile("prod"), profile("dev")], "prod", tempDir), logger, tempDir);
    const sel = new TargetSelection(reg);
    const other = new TargetSelection(reg);
    const t = sel.use("dev");
    expect(t.profile.name).toBe("dev");
    expect(sel.active.profile.name).toBe("dev");
    // Another MCP session's selection is unaffected (issue: shared active pointer).
    expect(other.active.profile.name).toBe("prod");
  });

  it("use() on an unknown target throws a NOT_FOUND CcuError", () => {
    const reg = new TargetRegistry(appConfig([profile("prod")], "prod", tempDir), logger, tempDir);
    const sel = new TargetSelection(reg);
    expect(() => sel.use("ghost")).toThrowError(CcuError);
    try { sel.use("ghost"); } catch (e) { expect((e as CcuError).structured.error).toBe("NOT_FOUND"); }
  });

  it("each target gets its own resolver, caches, and sysvar holder", () => {
    const reg = new TargetRegistry(appConfig([profile("prod"), profile("dev")], "prod", tempDir), logger, tempDir);
    const [prod, dev] = reg.list();
    expect(prod!.resolver).not.toBe(dev!.resolver);
    expect(prod!.deviceTypeCache).not.toBe(dev!.deviceTypeCache);
    expect(prod!.sysVarTypeCache).not.toBe(dev!.sysVarTypeCache);
    expect(new TargetSelection(reg).isUnlocked(prod!)).toBe(false);
  });

  it("saveCaches writes a distinct file per target; default keeps the legacy name", async () => {
    const reg = new TargetRegistry(appConfig([profile("default"), profile("dev")], "default", tempDir), logger, tempDir);
    const [def, dev] = reg.list();
    (def!.deviceTypeCache as any).cache.set("HmIP-DEF", { interface: "HmIP-RF", channels: {} });
    (dev!.deviceTypeCache as any).cache.set("HmIP-DEV", { interface: "HmIP-RF", channels: {} });
    await reg.saveCaches();
    const files = (await readdir(tempDir)).sort();
    expect(files).toContain("device-type-cache.json"); // legacy name for "default"
    // Named profiles get a readable slug plus a short hash of the name.
    expect(files.some((f) => /^device-type-cache\.dev-[0-9a-f]{8}\.json$/.test(f))).toBe(true);
  });

  it("names differing only by punctuation get distinct cache files (no collision)", async () => {
    // "my-ccu" and "my.ccu" both slugify to "my-ccu"; without the name hash they
    // would share one device-type-cache file and cross-contaminate two CCUs.
    const reg = new TargetRegistry(appConfig([profile("my-ccu"), profile("my.ccu")], "my-ccu", tempDir), logger, tempDir);
    const [a, b] = reg.list();
    (a!.deviceTypeCache as any).cache.set("HmIP-A", { interface: "HmIP-RF", channels: {} });
    (b!.deviceTypeCache as any).cache.set("HmIP-B", { interface: "HmIP-RF", channels: {} });
    await reg.saveCaches();
    const files = (await readdir(tempDir)).filter((f) => f.startsWith("device-type-cache."));
    // Two distinct files written, not one shared file.
    expect(files.length).toBe(2);
    expect(new Set(files).size).toBe(2);
  });
});

describe("resolveTarget", () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "ccu-resolve-")); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it("returns the selection's active target when no name is given", () => {
    const reg = new TargetRegistry(appConfig([profile("prod"), profile("dev")], "prod", tempDir), logger, tempDir);
    const sel = new TargetSelection(reg);
    expect(resolveTarget(sel).profile.name).toBe("prod");
  });

  it("returns the named target without switching active", () => {
    const reg = new TargetRegistry(appConfig([profile("prod"), profile("dev")], "prod", tempDir), logger, tempDir);
    const sel = new TargetSelection(reg);
    expect(resolveTarget(sel, "dev").profile.name).toBe("dev");
    expect(sel.active.profile.name).toBe("prod"); // unchanged
  });

  it("throws NOT_FOUND for an unknown name", () => {
    const reg = new TargetRegistry(appConfig([profile("prod")], "prod", tempDir), logger, tempDir);
    const sel = new TargetSelection(reg);
    expect(() => resolveTarget(sel, "ghost")).toThrowError(/Unknown CCU target/);
  });
});

describe("assertWritable", () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "ccu-guard-")); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  function setup(opts?: Partial<Pick<CcuProfile, "protected" | "readonly">>) {
    const reg = new TargetRegistry(appConfig([profile("t", opts)], "t", tempDir), logger, tempDir);
    const sel = new TargetSelection(reg);
    return { sel, t: sel.active };
  }

  it("allows writes to an unprotected target", () => {
    const { sel, t } = setup();
    expect(() => assertWritable(sel, t, undefined)).not.toThrow();
  });

  it("refuses a read-only target even with confirm", () => {
    const { sel, t } = setup({ readonly: true });
    expect(() => assertWritable(sel, t, true)).toThrowError(/read-only/);
  });

  it("refuses a protected target without confirm, then unlocks with confirm:true", () => {
    const { sel, t } = setup({ protected: true });
    expect(() => assertWritable(sel, t, undefined)).toThrowError(/protected/);
    expect(sel.isUnlocked(t)).toBe(false);
    // confirm unlocks for the session
    expect(() => assertWritable(sel, t, true)).not.toThrow();
    expect(sel.isUnlocked(t)).toBe(true);
    // subsequent writes no longer need confirm
    expect(() => assertWritable(sel, t, undefined)).not.toThrow();
  });

  it("an unlock in one selection does not leak into another (per-MCP-session)", () => {
    const reg = new TargetRegistry(appConfig([profile("t", { protected: true })], "t", tempDir), logger, tempDir);
    const a = new TargetSelection(reg);
    const b = new TargetSelection(reg);
    assertWritable(a, a.active, true); // client A unlocks
    expect(a.isUnlocked(a.active)).toBe(true);
    // client B still needs its own confirm
    expect(b.isUnlocked(b.active)).toBe(false);
    expect(() => assertWritable(b, b.active, undefined)).toThrowError(/protected/);
  });

  // Issue #72: high-blast-radius tools (run_script, delete_system_variable)
  // never ride on the session unlock — every call needs its own confirm.
  it("alwaysConfirm ignores the session unlock: each call needs confirm:true", () => {
    const { sel, t } = setup({ protected: true });
    assertWritable(sel, t, true); // ordinary write unlocks the session
    expect(sel.isUnlocked(t)).toBe(true);
    // ...but an alwaysConfirm tool still refuses without its own confirm
    expect(() => assertWritable(sel, t, undefined, { alwaysConfirm: true })).toThrowError(/EVERY call/);
    expect(() => assertWritable(sel, t, true, { alwaysConfirm: true })).not.toThrow();
    // and refuses again on the next call — no per-call carryover
    expect(() => assertWritable(sel, t, undefined, { alwaysConfirm: true })).toThrowError(/EVERY call/);
  });

  it("a confirmed alwaysConfirm call does not unlock the session for other writes", () => {
    const { sel, t } = setup({ protected: true });
    expect(() => assertWritable(sel, t, true, { alwaysConfirm: true })).not.toThrow();
    expect(sel.isUnlocked(t)).toBe(false);
    expect(() => assertWritable(sel, t, undefined)).toThrowError(/protected/);
  });

  it("alwaysConfirm is a no-op gate on unprotected targets and still refuses readonly", () => {
    const open = setup();
    expect(() => assertWritable(open.sel, open.t, undefined, { alwaysConfirm: true })).not.toThrow();
    const ro = setup({ readonly: true });
    expect(() => assertWritable(ro.sel, ro.t, true, { alwaysConfirm: true })).toThrowError(/read-only/);
  });
});
