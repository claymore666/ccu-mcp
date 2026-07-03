import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { CcuProfile } from "./types.js";
import type { Logger } from "../logger.js";
import type { RateLimiter } from "../middleware/rate-limiter.js";
import { SessionManager } from "./session.js";
import { Resolver } from "../middleware/resolver.js";
import { DeviceTypeCache } from "../cache/device-type-cache.js";
import { CcuError } from "../middleware/error-mapper.js";

/** Short-lived sysvar name→type(+enum labels) cache (issue #9), scoped per target. */
export interface SysVarTypeCacheHolder {
  entry: { ts: number; types: Map<string, { type: string; valueList?: string }> } | null;
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
}

// Filesystem-safe, collision-free per-target suffix for cache/session filenames.
// The readable slug alone can collide for names that differ only in punctuation
// ("my-ccu" vs "my.ccu" both slugify to "my-ccu"), which would make two distinct
// targets share one on-disk session/device-type-cache file. Append a short hash
// of the canonical (lowercased) name so distinct names always map to distinct
// files, keeping the slug only for human readability. (The session file is also
// host/port/user-guarded on restore, but the device-type cache file is not, so
// the filename must carry the uniqueness.)
function fileSuffix(name: string): string {
  const canonical = name.toLowerCase();
  const slug = canonical.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return slug ? `${slug}-${hash}` : hash;
}

/**
 * Holds every configured CCU target (shared, process-wide). WHICH target is
 * active — and which protected targets are unlocked — is per-MCP-session state
 * and lives in TargetSelection, so in HTTP mode one client's use_ccu/confirm
 * cannot retarget or de-gate another client's calls.
 */
export class TargetRegistry {
  private readonly targets = new Map<string, Target>(); // keyed by lowercased name
  private readonly order: string[] = []; // actual names, config order
  /** Lowercased name of the startup-default target. */
  readonly defaultKey: string;

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
      };
      this.targets.set(profile.name.toLowerCase(), target);
      this.order.push(profile.name);
    }
    this.defaultKey = config.defaultProfile.toLowerCase();
  }

  /** The startup-default target (process-level consumers: health, poller). */
  get default(): Target {
    return this.targets.get(this.defaultKey)!;
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

  /** All configured target names, config order (for error hints). */
  names(): string[] {
    return [...this.order];
  }

  /** Log in the default target (others log in lazily on first use). */
  async loginDefault(): Promise<void> {
    await this.default.session.login();
  }

  /** Load each target's device-type cache from disk. */
  async loadCaches(): Promise<void> {
    await Promise.all(this.list().map((t) => t.deviceTypeCache.loadFromDisk()));
  }

  /** Warm only the default target's cache (others warm lazily on switch). */
  warmDefault(rateLimiter: RateLimiter): Promise<void> {
    const t = this.default;
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
 * Per-MCP-session view onto the registry: which target is active for THIS
 * client, and which protected targets THIS client has unlocked. One instance
 * per McpServer (stdio has exactly one; HTTP mode one per Mcp-Session-Id), so
 * neither use_ccu switches nor confirm-unlocks leak across clients.
 */
export class TargetSelection {
  private activeKey: string;
  private readonly unlockedKeys = new Set<string>();

  constructor(private readonly registry: TargetRegistry) {
    this.activeKey = registry.defaultKey;
  }

  get active(): Target {
    return this.registry.getByName(this.activeKey)!;
  }

  /** Switch this session's active target; throws NOT_FOUND on an unknown name. */
  use(name: string): Target {
    const t = this.registry.getByName(name);
    if (!t) {
      throw new CcuError({
        error: "NOT_FOUND",
        code: 0,
        message: `Unknown CCU target: ${name}`,
        hint: `Configured targets: ${this.registry.names().join(", ")}. Call list_ccu_targets.`,
      });
    }
    this.activeKey = t.profile.name.toLowerCase();
    return t;
  }

  isUnlocked(target: Target): boolean {
    return this.unlockedKeys.has(target.profile.name.toLowerCase());
  }

  unlock(target: Target): void {
    this.unlockedKeys.add(target.profile.name.toLowerCase());
  }

  /** Lookup a target by name in the shared registry (used by resolveTarget). */
  registryLookup(name: string): Target | undefined {
    return this.registry.getByName(name);
  }
}

/**
 * Resolve the target for a tool call: the optional per-call `target` name, or
 * this session's active target when omitted. Throws NOT_FOUND for an unknown name.
 */
export function resolveTarget(selection: TargetSelection, name?: string): Target {
  if (!name) return selection.active;
  const t = selection.registryLookup(name);
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
 *
 * `alwaysConfirm` marks a high-blast-radius tool (run_script,
 * delete_system_variable): the session unlock never applies — every call
 * needs its own confirm:true, and a confirmed call does NOT unlock the
 * session for other writes (issue #72). run_script bypasses all value/type
 * guards the typed tools enforce, so it must not ride on a confirmation that
 * was given for a harmless set_value.
 */
export function assertWritable(
  selection: TargetSelection,
  target: Target,
  confirm: boolean | undefined,
  opts?: { alwaysConfirm?: boolean },
): void {
  if (target.profile.readonly) {
    throw new CcuError({
      error: "INVALID_INPUT",
      code: 0,
      message: `CCU target "${target.profile.name}" is read-only; writes are refused.`,
      hint: "Switch to a writable target with use_ccu, or clear its readonly flag in config.",
    });
  }
  if (!target.profile.protected) return;
  if (opts?.alwaysConfirm) {
    if (confirm !== true) {
      throw new CcuError({
        error: "INVALID_INPUT",
        code: 0,
        message: `CCU target "${target.profile.name}" is protected. This tool requires confirm:true on EVERY call — the session unlock does not apply to it.`,
        hint: "High-impact operation on a protected CCU. Pass confirm:true with this call to proceed.",
      });
    }
    return; // per-call authorization only — never unlocks the session
  }
  if (!selection.isUnlocked(target)) {
    if (confirm !== true) {
      throw new CcuError({
        error: "INVALID_INPUT",
        code: 0,
        message: `CCU target "${target.profile.name}" is protected. Re-issue with confirm:true to authorize writes for this session.`,
        hint: "Safety gate on a production CCU. Pass confirm:true to proceed; later writes this session won't need it (except run_script and delete_system_variable, which confirm every call).",
      });
    }
    selection.unlock(target);
  }
}
