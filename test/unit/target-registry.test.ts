import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TargetRegistry, resolveTarget, assertWritable } from "../../src/ccu/target-registry.js";
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
    expect(reg.active.profile.name).toBe("prod");
    expect(reg.active.profile.protected).toBe(true);
  });

  it("getByName / has are case-insensitive; unknown is undefined", () => {
    const reg = new TargetRegistry(appConfig([profile("Prod"), profile("dev")], "Prod", tempDir), logger, tempDir);
    expect(reg.getByName("prod")!.profile.name).toBe("Prod");
    expect(reg.has("DEV")).toBe(true);
    expect(reg.getByName("nope")).toBeUndefined();
    expect(reg.has("nope")).toBe(false);
  });

  it("use() switches the active target and returns it", () => {
    const reg = new TargetRegistry(appConfig([profile("prod"), profile("dev")], "prod", tempDir), logger, tempDir);
    const t = reg.use("dev");
    expect(t.profile.name).toBe("dev");
    expect(reg.active.profile.name).toBe("dev");
  });

  it("use() on an unknown target throws a NOT_FOUND CcuError", () => {
    const reg = new TargetRegistry(appConfig([profile("prod")], "prod", tempDir), logger, tempDir);
    expect(() => reg.use("ghost")).toThrowError(CcuError);
    try { reg.use("ghost"); } catch (e) { expect((e as CcuError).structured.error).toBe("NOT_FOUND"); }
  });

  it("each target gets its own resolver, caches, and sysvar holder", () => {
    const reg = new TargetRegistry(appConfig([profile("prod"), profile("dev")], "prod", tempDir), logger, tempDir);
    const [prod, dev] = reg.list();
    expect(prod!.resolver).not.toBe(dev!.resolver);
    expect(prod!.deviceTypeCache).not.toBe(dev!.deviceTypeCache);
    expect(prod!.sysVarTypeCache).not.toBe(dev!.sysVarTypeCache);
    expect(prod!.unlocked).toBe(false);
  });

  it("saveCaches writes a distinct file per target; default keeps the legacy name", async () => {
    const reg = new TargetRegistry(appConfig([profile("default"), profile("dev")], "default", tempDir), logger, tempDir);
    const [def, dev] = reg.list();
    (def!.deviceTypeCache as any).cache.set("HmIP-DEF", { interface: "HmIP-RF", channels: {} });
    (dev!.deviceTypeCache as any).cache.set("HmIP-DEV", { interface: "HmIP-RF", channels: {} });
    await reg.saveCaches();
    const files = (await readdir(tempDir)).sort();
    expect(files).toContain("device-type-cache.json");      // legacy name for "default"
    expect(files).toContain("device-type-cache.dev.json");  // suffixed for "dev"
  });
});

describe("resolveTarget", () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "ccu-resolve-")); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it("returns the active target when no name is given", () => {
    const reg = new TargetRegistry(appConfig([profile("prod"), profile("dev")], "prod", tempDir), logger, tempDir);
    expect(resolveTarget(reg).profile.name).toBe("prod");
  });

  it("returns the named target without switching active", () => {
    const reg = new TargetRegistry(appConfig([profile("prod"), profile("dev")], "prod", tempDir), logger, tempDir);
    expect(resolveTarget(reg, "dev").profile.name).toBe("dev");
    expect(reg.active.profile.name).toBe("prod"); // unchanged
  });

  it("throws NOT_FOUND for an unknown name", () => {
    const reg = new TargetRegistry(appConfig([profile("prod")], "prod", tempDir), logger, tempDir);
    expect(() => resolveTarget(reg, "ghost")).toThrowError(/Unknown CCU target/);
  });
});

describe("assertWritable", () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "ccu-guard-")); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  function target(opts?: Partial<Pick<CcuProfile, "protected" | "readonly">>) {
    const reg = new TargetRegistry(appConfig([profile("t", opts)], "t", tempDir), logger, tempDir);
    return reg.active;
  }

  it("allows writes to an unprotected target", () => {
    expect(() => assertWritable(target(), undefined)).not.toThrow();
  });

  it("refuses a read-only target even with confirm", () => {
    expect(() => assertWritable(target({ readonly: true }), true)).toThrowError(/read-only/);
  });

  it("refuses a protected target without confirm, then unlocks with confirm:true", () => {
    const t = target({ protected: true });
    expect(() => assertWritable(t, undefined)).toThrowError(/protected/);
    expect(t.unlocked).toBe(false);
    // confirm unlocks for the session
    expect(() => assertWritable(t, true)).not.toThrow();
    expect(t.unlocked).toBe(true);
    // subsequent writes no longer need confirm
    expect(() => assertWritable(t, undefined)).not.toThrow();
  });
});
