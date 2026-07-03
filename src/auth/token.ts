import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.js";

const ENV_FILENAME = ".env";

/** sha256 of a token — fixed width so timingSafeEqual never sees a length mismatch. */
function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

interface TokenEntry {
  /** sha256 of the accepted token. */
  hash: Buffer;
  /** Epoch ms after which this token is rejected; null = never expires. */
  expiresAt: number | null;
  /** For diagnostics only — never the token itself. */
  label: string;
}

/**
 * A set of currently-acceptable bearer tokens. Expiry is evaluated live at
 * verification time (against `now`), so a token stops validating the moment it
 * lapses — no restart or background timer needed.
 */
export class AuthTokens {
  constructor(private entries: TokenEntry[]) {}

  /**
   * Swap in the entries of a freshly-resolved set. Used by runtime rotation:
   * requests hold a reference to ONE AuthTokens instance, so rotation must
   * mutate it in place rather than build a new object nobody consults.
   *
   * In-memory graced entries (from adoptWithGrace) survive the swap until
   * their own expiry — they exist ONLY in memory, so rebuilding from the
   * persisted file alone would cut the promised grace short at the very next
   * rotation tick.
   */
  replaceWith(other: AuthTokens, now: number = Date.now()): void {
    const keptGraced = this.entries.filter(
      (e) =>
        e.label.endsWith("-graced") &&
        e.expiresAt !== null &&
        now <= e.expiresAt &&
        !other.entries.some((o) => o.hash.equals(e.hash)),
    );
    this.entries = [...other.entries, ...keptGraced];
  }

  /**
   * Adopt a freshly-resolved set while keeping the CURRENT tokens valid for a
   * grace window. Used when persistence recovers after a broken data dir: the
   * in-memory startup token clients were given must not 401 instantly — it
   * gets the same overlap a normal rotation grants the outgoing token.
   * Expired entries are pruned and duplicates skipped, so repeated recoveries
   * can't grow the set (and per-request verify cost) without bound.
   */
  adoptWithGrace(other: AuthTokens, graceMs: number, now: number = Date.now()): void {
    const cutoff = now + graceMs;
    const graced = this.entries
      .filter((e) => e.expiresAt === null || now <= e.expiresAt)
      .filter((e) => !other.entries.some((o) => o.hash.equals(e.hash)))
      .map((e) => ({
        ...e,
        expiresAt: e.expiresAt === null ? cutoff : Math.min(e.expiresAt, cutoff),
        label: e.label.endsWith("-graced") ? e.label : `${e.label}-graced`,
      }));
    this.entries = [...other.entries, ...graced];
  }

  /**
   * Timing-safe check of a presented token against every entry. Compares against
   * ALL entries (no early return) so neither a match nor expiry leaks via timing,
   * preserving the original single-token guarantee across the rotation set.
   */
  verify(presented: string, now: number = Date.now()): boolean {
    // Empty / missing credentials never match. Cheap, and the only thing the
    // short-circuit leaks ("no token presented") is already visible in the 401
    // challenge the caller sends back.
    if (!presented) return false;
    const ph = sha256(presented);
    let ok = false;
    for (const entry of this.entries) {
      const match = timingSafeEqual(ph, entry.hash);
      const live = entry.expiresAt === null || now <= entry.expiresAt;
      ok = ok || (match && live);
    }
    return ok;
  }

  /** Count of entries still live at `now` — for the startup log, exposes no secrets. */
  liveCount(now: number = Date.now()): number {
    return this.entries.filter((e) => e.expiresAt === null || now <= e.expiresAt).length;
  }
}

export interface ResolveAuthTokensOptions {
  /** Explicit operator-managed token (`MCP_AUTH_TOKEN`). Highest priority. */
  envToken?: string;
  /** Previous operator-managed token kept valid for the rotation overlap (`MCP_AUTH_TOKEN_PREVIOUS`). */
  envPreviousToken?: string;
  /** Where the auto-generated token + its metadata are persisted. */
  dataDir: string;
  /** Lifetime of the auto-generated token in ms; undefined ⇒ never expires. */
  ttlMs?: number;
  /** Overlap after an auto-rotation during which the just-replaced token still validates. */
  graceMs: number;
  /**
   * Announce a freshly-minted token even when persisting it FAILED. True for
   * startup (an in-memory token beats none); rotation ticks pass false so a
   * broken data dir doesn't announce a new never-persisted token every tick.
   */
  announceUnpersisted?: boolean;
}

/** Persisted shape of the auto-generated token file. */
interface PersistedToken {
  token?: string;
  issued?: number;
  previous?: string;
  previousExpires?: number;
}

function parsePersisted(content: string): PersistedToken {
  // trim: tolerate a trailing \r if the file was edited with CRLF (issue #13)
  const read = (key: string): string | undefined =>
    content.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim();
  const readNum = (key: string): number | undefined => {
    const raw = read(key);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    token: read("MCP_AUTH_TOKEN"),
    issued: readNum("MCP_AUTH_TOKEN_ISSUED"),
    previous: read("MCP_AUTH_TOKEN_PREVIOUS"),
    previousExpires: readNum("MCP_AUTH_TOKEN_PREVIOUS_EXPIRES"),
  };
}

function serialize(state: PersistedToken): string {
  const lines = [`MCP_AUTH_TOKEN=${state.token}`];
  if (state.issued !== undefined) lines.push(`MCP_AUTH_TOKEN_ISSUED=${state.issued}`);
  if (state.previous !== undefined) {
    lines.push(`MCP_AUTH_TOKEN_PREVIOUS=${state.previous}`);
    if (state.previousExpires !== undefined) {
      lines.push(`MCP_AUTH_TOKEN_PREVIOUS_EXPIRES=${state.previousExpires}`);
    }
  }
  return lines.join("\n") + "\n";
}

// The keys this module owns inside the .env file. Everything else in the file
// belongs to the operator and must survive a rewrite.
const MANAGED_KEY_RE = /^MCP_AUTH_TOKEN(_ISSUED|_PREVIOUS|_PREVIOUS_EXPIRES)?=/;

async function persist(dataDir: string, state: PersistedToken, logger: Logger): Promise<boolean> {
  const envPath = join(dataDir, ENV_FILENAME);
  try {
    await mkdir(dataDir, { recursive: true });
    // Preserve operator-added lines (it's a normal dotenv file and the announce
    // message points operators at it) — only the managed token keys are replaced.
    let foreign: string[] = [];
    try {
      foreign = (await readFile(envPath, "utf-8"))
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "" && !MANAGED_KEY_RE.test(line));
    } catch {
      // No existing file — nothing to preserve.
    }
    const content = serialize(state) + (foreign.length > 0 ? foreign.join("\n") + "\n" : "");
    const tmpPath = envPath + ".tmp";
    // 0600: file contains the bearer token(s) for the HTTP transport
    await writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, envPath);
    return true;
  } catch (err) {
    logger.error("auth_token_save_failed", { error: (err as Error).message });
    return false;
  }
}

function announce(token: string, dataDir: string, rotated: boolean, saved: boolean): void {
  const envPath = join(dataDir, ENV_FILENAME);
  const what = rotated ? "Rotated auth token" : "Generated auth token";
  // stderr so the operator can copy it; never goes through the structured logger.
  process.stderr.write(`\n[ccu-mcp] ${what}: ${token}\n`);
  if (saved) {
    process.stderr.write(`[ccu-mcp] Token saved to ${envPath}\n`);
  } else {
    process.stderr.write(
      `[ccu-mcp] WARNING: the token could NOT be saved to ${envPath} — it is valid for this run only. Fix the data dir permissions.\n`,
    );
  }
  process.stderr.write(`[ccu-mcp] Use this token in your MCP client configuration.\n\n`);
}

/**
 * Resolve the set of currently-valid bearer tokens (issue #52).
 *
 * Precedence mirrors the original single-token resolver:
 *  1. Explicit `MCP_AUTH_TOKEN` (operator-managed, never auto-expired). An
 *     optional `MCP_AUTH_TOKEN_PREVIOUS` is accepted alongside it for the
 *     rotation overlap; the operator ends the overlap by dropping it + restart.
 *     TTL does not apply to operator-supplied tokens — the operator owns them.
 *  2. The auto-generated token persisted under `dataDir/.env`. With `ttlMs` set
 *     it carries an issued-at; once it lapses we rotate (at startup and via
 *     the runtime rotation ticks): a fresh token is generated and the
 *     just-replaced one stays valid for `graceMs` so in-flight clients aren't
 *     cut off mid-migration.
 *  3. If neither exists, generate and persist a new token.
 *
 * `lookaheadMs` advances ONLY the TTL-expiry decision (rotate slightly early
 * so there is no 401 window between hard expiry and the next tick). Pruning
 * and timestamp stamping always use the REAL clock — a skewed prune clock
 * could drop the outgoing token before its promised grace end.
 */
export async function resolveAuthTokens(
  opts: ResolveAuthTokensOptions,
  logger: Logger,
  now: number = Date.now(),
  lookaheadMs: number = 0,
): Promise<AuthTokens> {
  // 1. Explicit env token(s) — operator-managed, no TTL, file untouched.
  if (opts.envToken) {
    logger.info("auth_token_from_env", { previous: Boolean(opts.envPreviousToken) });
    const entries: TokenEntry[] = [
      { hash: sha256(opts.envToken), expiresAt: null, label: "env" },
    ];
    if (opts.envPreviousToken) {
      entries.push({ hash: sha256(opts.envPreviousToken), expiresAt: null, label: "env-previous" });
    }
    return new AuthTokens(entries);
  }

  // 2 + 3. File-backed auto-generated token.
  const { dataDir, ttlMs, graceMs } = opts;
  let state: PersistedToken = {};
  try {
    state = parsePersisted(await readFile(join(dataDir, ENV_FILENAME), "utf-8"));
  } catch {
    // File doesn't exist (or is unreadable) — fall through to generation.
  }

  let changed = false;
  let minted = false; // brand-new token this run (generate or rotate) → announce
  let rotated = false;
  const preRotationState: PersistedToken = { ...state };

  if (!state.token) {
    // 3. No usable token — generate.
    state = { token: randomBytes(32).toString("base64url"), issued: now };
    changed = true;
    minted = true;
    logger.info("auth_token_generated");
  } else if (ttlMs !== undefined) {
    if (state.issued === undefined) {
      // Legacy file written before TTL existed: start the clock now rather than
      // expiring a token whose true age we can't know.
      state.issued = now;
      changed = true;
    } else if (now + lookaheadMs - state.issued >= ttlMs) {
      // Expired → rotate. Keep the old token valid for the grace overlap.
      state = {
        token: randomBytes(32).toString("base64url"),
        issued: now,
        previous: state.token,
        previousExpires: now + graceMs,
      };
      changed = true;
      minted = true;
      rotated = true;
      logger.info("auth_token_rotated", { graceMs });
    }
  }

  // Drop a previously-rotated token once its grace window has fully elapsed.
  if (
    state.previous !== undefined &&
    state.previousExpires !== undefined &&
    now > state.previousExpires
  ) {
    delete state.previous;
    delete state.previousExpires;
    changed = true;
  }

  let saved = true;
  if (changed) {
    saved = await persist(dataDir, state, logger);
    if (!saved && rotated) {
      // A rotation that can't be persisted must not take effect: the next
      // check would re-read the unchanged file and rotate AGAIN, minting and
      // announcing a fresh token every interval (each invalidating the last).
      // Keep the pre-rotation state; auth_token_save_failed points the
      // operator at the real problem (unwritable data dir). Deliberate
      // trade-off: once the old token's hard expiry passes, verify() rejects
      // everything until the data dir is fixed — a deterministic, logged
      // lockout beats silently churning through announced tokens.
      state = preRotationState;
      minted = false;
      rotated = false;
    }
  }
  if (minted && (saved || opts.announceUnpersisted !== false)) {
    announce(state.token!, dataDir, rotated, saved);
  }

  const entries: TokenEntry[] = [
    {
      hash: sha256(state.token!),
      expiresAt: ttlMs !== undefined && state.issued !== undefined ? state.issued + ttlMs : null,
      label: "generated",
    },
  ];
  if (state.previous !== undefined && state.previousExpires !== undefined) {
    entries.push({
      hash: sha256(state.previous),
      expiresAt: state.previousExpires,
      label: "rotated-out",
    });
  }
  return new AuthTokens(entries);
}

const ROTATION_CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Keep the auto-generated token rotating while the server RUNS. `verify()`
 * enforces expiry live, but without this the replacement token would only be
 * minted at the next restart — a server up past the TTL would 401 every client
 * permanently. Re-resolves the persisted state periodically; the `now`
 * lookahead of one interval rotates just BEFORE the hard expiry, so there is
 * no 401 window (the outgoing token stays valid through the grace overlap).
 *
 * Only meaningful for the file-backed token path with a TTL; do not call for
 * operator-managed env tokens. Returns a stop function for shutdown.
 */
export function startAutoRotation(
  tokens: AuthTokens,
  opts: ResolveAuthTokensOptions,
  logger: Logger,
  intervalMs: number = ROTATION_CHECK_INTERVAL_MS,
): () => void {
  const hasPersistedToken = async (): Promise<boolean> => {
    try {
      return Boolean(parsePersisted(await readFile(join(opts.dataDir, ENV_FILENAME), "utf-8")).token);
    } catch {
      return false;
    }
  };
  const tick = (): void => {
    void (async () => {
      // Only ADOPT what ends up persisted. If the startup save failed
      // (unwritable data dir), blindly adopting each tick's resolve would
      // mint + announce a brand-new token every interval, 401ing the
      // previous one. Announce is suppressed for unpersisted mints, and the
      // in-memory startup token stays valid until the data dir is fixed —
      // at which point the resolve below persists a fresh token, announces
      // it, and rotation resumes without a restart. The interval is passed
      // as LOOKAHEAD (rotate-early decision only); pruning uses the real
      // clock so a short grace window is never cut off by the skew.
      const hadPersisted = await hasPersistedToken();
      const fresh = await resolveAuthTokens(
        { ...opts, announceUnpersisted: false },
        logger,
        Date.now(),
        intervalMs,
      );
      if (hadPersisted) {
        tokens.replaceWith(fresh);
      } else if (await hasPersistedToken()) {
        // Persistence just recovered: the newly persisted token replaces the
        // unpersisted in-memory one, but clients holding the old one get the
        // usual grace overlap instead of an instant 401.
        tokens.adoptWithGrace(fresh, opts.graceMs);
      }
    })().catch((err: unknown) => {
      logger.error("auth_token_rotation_failed", { error: (err as Error).message });
    });
  };
  // Run once immediately: a token expiring within the FIRST interval after
  // startup would otherwise 401 until the first timer tick (the startup
  // resolve has no lookahead).
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
