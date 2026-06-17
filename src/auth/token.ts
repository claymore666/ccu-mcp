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
  constructor(private readonly entries: TokenEntry[]) {}

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

async function persist(dataDir: string, state: PersistedToken, logger: Logger): Promise<void> {
  const envPath = join(dataDir, ENV_FILENAME);
  try {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = envPath + ".tmp";
    // 0600: file contains the bearer token(s) for the HTTP transport
    await writeFile(tmpPath, serialize(state), { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, envPath);
  } catch (err) {
    logger.error("auth_token_save_failed", { error: (err as Error).message });
  }
}

function announce(token: string, dataDir: string, rotated: boolean): void {
  const envPath = join(dataDir, ENV_FILENAME);
  const what = rotated ? "Rotated auth token" : "Generated auth token";
  // stderr so the operator can copy it; never goes through the structured logger.
  process.stderr.write(`\n[debmatic-mcp] ${what}: ${token}\n`);
  process.stderr.write(`[debmatic-mcp] Token saved to ${envPath}\n`);
  process.stderr.write(`[debmatic-mcp] Use this token in your MCP client configuration.\n\n`);
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
