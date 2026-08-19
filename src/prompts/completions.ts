import type { ServerDeps } from "../server.js";
import type { CcuDevice } from "../ccu/types.js";
import { withRetry } from "../middleware/retry.js";
import { expectArray } from "../utils.js";

/**
 * Completion sources for prompt arguments (`completion/complete`).
 *
 * A completion request fires while the user is still typing, so it must be
 * cheap and it must never fail loudly: an empty list is a fine answer, an
 * exception in the middle of an autocomplete is not. Every fetch is therefore
 * wrapped — any CCU failure yields no suggestions and the argument stays free
 * text.
 *
 * The lists are cached for CACHE_MS. Without that, one keystroke would be one
 * `Device.listAllDetail` against a small embedded box; with it, a burst of
 * typing costs a single call. The TTL is short because rooms and device names
 * change in the CCU WebUI while this server runs, and a name that autocompletes
 * to something that no longer exists is worse than no suggestion.
 */
const CACHE_MS = 60_000;

type Entry = { at: number; values: Promise<string[]> };

export class CompletionSource {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly deps: ServerDeps) {}

  /** Room names, filtered by what the user has typed so far. */
  rooms = (typed: string): Promise<string[]> =>
    this.filtered("Room.getAll", typed, (rows) =>
      rows.map((r) => (r as { name?: unknown }).name).filter((n): n is string => typeof n === "string"),
    );

  /** Device names (not channels — a prompt argument names a device). */
  devices = (typed: string): Promise<string[]> =>
    this.filtered("Device.listAllDetail", typed, (rows) =>
      (rows as CcuDevice[]).map((d) => d.name).filter((n): n is string => typeof n === "string"),
    );

  private async filtered(
    method: string,
    typed: string,
    extract: (rows: unknown[]) => string[],
  ): Promise<string[]> {
    const all = await this.load(method, extract);
    // Substring, case-insensitive: CCU names are commonly "OG Bad Heizung",
    // so a user typing "bad" means the middle of the name at least as often as
    // its start. An empty value asks for everything (the SDK caps at 100).
    const needle = typed.toLowerCase();
    return needle ? all.filter((v) => v.toLowerCase().includes(needle)) : all;
  }

  private load(method: string, extract: (rows: unknown[]) => string[]): Promise<string[]> {
    const hit = this.cache.get(method);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.values;

    const { rateLimiter, logger } = this.deps;
    const values = (async () => {
      try {
        await rateLimiter.acquire();
        const rows = expectArray(
          await withRetry(() => this.deps.session.call(method), method, logger, { rateLimiter }),
          method,
        );
        return extract(rows);
      } catch {
        // No suggestions rather than a failed completion. Do not cache the
        // failure for the full TTL — drop it so the next keystroke retries.
        this.cache.delete(method);
        return [];
      }
    })();

    this.cache.set(method, { at: Date.now(), values });
    return values;
  }
}
