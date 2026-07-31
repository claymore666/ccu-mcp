import { existsSync } from "node:fs";
import { join } from "node:path";

/** The built server every e2e suite spawns. */
export const DIST = join(__dirname, "../../dist/index.js");

// `describe.skipIf(!existsSync(DIST))` is convenient locally — bare
// `npx vitest` with no build shouldn't explode. But it makes a missing dist/ a
// SILENT PASS: every e2e block skips and the run still exits 0, which is
// indistinguishable from "the e2e suites passed". Since these six blocks are
// ALL the integration coverage there is, that is exactly the false green
// CLAUDE.md warns about in prose (issue #128).
//
// `npm test` builds via `pretest`, so this can only fire if that guarantee is
// removed or reordered. In CI, say so loudly rather than reporting success.
if (process.env.CI && !existsSync(DIST)) {
  throw new Error(
    "dist/ is missing in CI — the e2e suites would silently skip and the run would still pass. " +
      "Run `npm run build` first (`npm test` does this via pretest).",
  );
}

/** Gate for `describe.skipIf(...)`. Evaluated once, after the CI check above. */
export const distMissing = !existsSync(DIST);

/**
 * A listening port for an e2e server, unique per (vitest worker, slot).
 *
 * Was `20000 + Math.floor(Math.random() * 20000)` in four separate blocks, with
 * no coordination and no retry. Vitest runs files in parallel, so two servers
 * could draw the same port; the second got EADDRINUSE, exited, and the readiness
 * poll then failed with "server did not start" — pointing at the CCU mock rather
 * than at the port clash. Rare, unreproducible, and far more expensive to
 * diagnose than to prevent (issue #128).
 *
 * `slot` must be distinct per describe block within a file.
 */
export function e2ePort(slot: number): number {
  const worker = Number(process.env.VITEST_WORKER_ID ?? 1);
  return 20000 + worker * 100 + slot;
}
