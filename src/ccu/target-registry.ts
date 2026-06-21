import type { AppConfig } from "../config.js";
import type { CcuProfile } from "./types.js";
import type { Logger } from "../logger.js";
import type { RateLimiter } from "../middleware/rate-limiter.js";
import { SessionManager } from "./session.js";
import { Resolver } from "../middleware/resolver.js";
import { DeviceTypeCache } from "../cache/device-type-cache.js";
import { CcuError } from "../middleware/error-mapper.js";

/** Short-lived sysvar name→type cache (issue #9), now scoped per target. */
export interface SysVarTypeCacheHolder {
  entry: { ts: number; types: Map<string, string> } | null;
}

/**
 * One connected CCU target: its profile (connection + policy), its own session,
 * resolver, device-type cache, and sysvar-type cache. Caches are per-target so
 * a dev and prod CCU never pollute each other.
 */
export interface Target {
  profile: CcuProfile;
  session: SessionManager;
  resolver: Resolver;
  deviceTypeCache: DeviceTypeCache;
  sysVarTypeCache: SysVarTypeCacheHolder;
  /**
   * Writes to a `protected` target are unlocked for the rest of the session
   * once the caller confirms once (the "ask once per session" model). Always
   * false → no effect for non-protected targets.
   */
  unlocked: boolean;
}

// Filesystem-safe per-target suffix for cache/session filenames.
function fileSuffix(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Holds every configured CCU target and which one is active. Tools reach the
 * active target via ServerDeps getters; an optional per-call `target` arg routes
 * a single call elsewhere via resolveTarget().
 */
export class TargetRegistry {
  private readonly targets = new Map<string, Target>(); // keyed by lowercased name
  private readonly order: string[] = []; // actual names, config order
  private activeKey: string;

  constructor(config: AppConfig, logger: Logger, cacheDir: string) {
    for (const profile of config.profiles) {
      // The back-compat single "default" profile keeps the historical filenames
      // so existing on-disk session/cache still load; named profiles get a suffix.
      const suffix = profile.name === "default" ? "" : `.${fileSuffix(profile.name)}`;
      const target: Target = {
        profile,
        session: new SessionManager(profile.ccu, logger, cacheDir, `session${suffix}.json`),
        resolver: new Resolver(),
        deviceTypeCache: new DeviceTypeCache(cacheDir, config.cache.ttl, logger, `device-type-cache${suffix}.json`),
        sysVarTypeCache: { entry: null },
        unlocked: false,
      };
      this.targets.set(profile.name.toLowerCase(), target);
      this.order.push(profile.name);
    }
    this.activeKey = config.defaultProfile.toLowerCase();
  }

  get active(): Target {
    return this.targets.get(this.activeKey)!;
  }

  getByName(name: string): Target | undefined {
    return this.targets.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.targets.has(name.toLowerCase());
  }

  /** All targets in configured order. */
  list(): Target[] {
    return this.order.map((n) => this.targets.get(n.toLowerCase())!);
  }

  /** Switch the active target; throws NOT_FOUND on an unknown name. */
  use(name: string): Target {
    const t = this.getByName(name);
    if (!t) {
      throw new CcuError({
        error: "NOT_FOUND",
        code: 0,
        message: `Unknown CCU target: ${name}`,
        hint: `Configured targets: ${this.order.join(", ")}. Call list_ccu_targets.`,
      });
    }
    this.activeKey = t.profile.name.toLowerCase();
    return t;
  }

  /** Log in the active target (other targets log in lazily on first use). */
  async loginActive(): Promise<void> {
    await this.active.session.login();
  }

  /** Load each target's device-type cache from disk. */
  async loadCaches(): Promise<void> {
    await Promise.all(this.list().map((t) => t.deviceTypeCache.loadFromDisk()));
  }

  /** Warm only the active target's cache (others warm lazily on first query). */
  warmActive(rateLimiter: RateLimiter): Promise<void> {
    const t = this.active;
    return t.deviceTypeCache.warm(t.session, rateLimiter);
  }

  async saveCaches(): Promise<void> {
    await Promise.allSettled(this.list().map((t) => t.deviceTypeCache.saveToDisk()));
  }

  async logoutAll(): Promise<void> {
    await Promise.allSettled(this.list().map((t) => t.session.logout()));
  }

  destroyAll(): void {
    for (const t of this.list()) t.session.destroy();
  }
}

/**
 * Resolve the target for a tool call: the optional per-call `target` name, or
 * the active target when omitted. Throws NOT_FOUND for an unknown name.
 */
export function resolveTarget(targets: TargetRegistry, name?: string): Target {
  if (!name) return targets.active;
  const t = targets.getByName(name);
  if (!t) {
    throw new CcuError({
      error: "NOT_FOUND",
      code: 0,
      message: `Unknown CCU target: ${name}`,
      hint: "Call list_ccu_targets to see configured targets.",
    });
  }
  return t;
}

/**
 * Gate a write against a target's policy. `readonly` targets always refuse;
 * `protected` targets refuse until the caller passes confirm:true once, which
 * unlocks writes to that target for the rest of the session.
 */
export function assertWritable(target: Target, confirm: boolean | undefined): void {
  if (target.profile.readonly) {
    throw new CcuError({
      error: "INVALID_INPUT",
      code: 0,
      message: `CCU target "${target.profile.name}" is read-only; writes are refused.`,
      hint: "Switch to a writable target with use_ccu, or clear its readonly flag in config.",
    });
  }
  if (target.profile.protected && !target.unlocked) {
    if (confirm !== true) {
      throw new CcuError({
        error: "INVALID_INPUT",
        code: 0,
        message: `CCU target "${target.profile.name}" is protected. Re-issue with confirm:true to authorize writes for this session.`,
        hint: "Safety gate on a production CCU. Pass confirm:true to proceed; later writes this session won't need it.",
      });
    }
    target.unlocked = true;
  }
}
