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
   */
  replaceWith(other: AuthTokens): void {
    this.entries = other.entries;
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

async function persist(dataDir: string, state: PersistedToken, logger: Logger): Promise<void> {
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
  } catch (err) {
    logger.error("auth_token_save_failed", { error: (err as Error).message });
  }
}

function announce(token: string, dataDir: string, rotated: boolean): void {
  const envPath = join(dataDir, ENV_FILENAME);
  const what = rotated ? "Rotated auth token" : "Generated auth token";
  // stderr so the operator can copy it; never goes through the structured logger.
  process.stderr.write(`\n[ccu-mcp] ${what}: ${token}\n`);
  process.stderr.write(`[ccu-mcp] Token saved to ${envPath}\n`);
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
 *     it carries an issued-at; once it lapses we rotate on startup: a fresh
 *     token is generated and the just-replaced one stays valid for `graceMs`
 *     so in-flight clients aren't cut off mid-migration.
 *  3. If neither exists, generate and persist a new token.
 */
export async function resolveAuthTokens(
  opts: ResolveAuthTokensOptions,
  logger: Logger,
  now: number = Date.now(),
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
    } else if (now - state.issued >= ttlMs) {
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

  if (changed) await persist(dataDir, state, logger);
  if (minted) announce(state.token!, dataDir, rotated);

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
  const timer = setInterval(() => {
    resolveAuthTokens(opts, logger, Date.now() + intervalMs)
      .then((fresh) => tokens.replaceWith(fresh))
      .catch((err: unknown) => {
        logger.error("auth_token_rotation_failed", { error: (err as Error).message });
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
