#!/usr/bin/env node
// Per-directory coverage ratchet. vitest.config.ts already enforces GLOBAL
// thresholds; this enforces a floor per directory underneath them, because a
// global average hides local collapse — src/ccu could lose 20 points and the
// global number would barely move, absorbed by the well-covered directories
// around it.
//
// Hermetic: coverage is a pure function of the commit under test, so this
// belongs inside the `build-and-test` contract (see .github/workflows/ci.yml).
//
// Usage:
//   node scripts/coverage-ratchet.mjs <coverage-summary.json> <baseline-file>
//   node scripts/coverage-ratchet.mjs <coverage-summary.json> --print-measured [baseline]
//
// --print-measured reads the baseline (default .github/coverage-baseline.txt)
// for its !exempt lines, so its output can be pasted back safely.
//
// Exit codes: 0 pass, 1 ratchet failure, 2 cannot check (usage/harness error).
// 1 and 2 are kept distinct so a broken harness can never read as a pass OR
// as a coverage regression — the same rule scripts/test-actionlint.sh follows.
//
// RATCHET_EPSILON (default 0.5): tolerated drop in percentage points. Coverage
// here is deterministic run-to-run (verified byte-identical across repeat local
// runs), so this is not noise absorption — it is headroom for cross-environment
// drift: a different Node patch release can shift v8's statement attribution
// slightly, and CI's Node is not pinned to the developer's.

import { readFileSync, existsSync } from "node:fs";
import { relative, dirname } from "node:path";

const METRICS = ["statements", "branches"];
const DEFAULT_BASELINE = ".github/coverage-baseline.txt";
const EPSILON = Number(process.env.RATCHET_EPSILON ?? "0.5");

function die(msg) {
  console.error(msg);
  process.exit(2);
}

const [summaryPath, baselinePath] = process.argv.slice(2);
if (!summaryPath || !baselinePath) {
  die(
    "usage: coverage-ratchet.mjs <coverage-summary.json> <baseline-file|--print-measured [baseline]>",
  );
}
if (!Number.isFinite(EPSILON) || EPSILON < 0) {
  die(`RATCHET_EPSILON must be a non-negative number, got ${process.env.RATCHET_EPSILON}`);
}

// --- measured -------------------------------------------------------------

let summary;
try {
  summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
} catch (err) {
  die(
    `cannot read ${summaryPath}: ${err.message}\n` +
      "Run `npm test -- --coverage` first; vitest.config.ts must list the " +
      "`json-summary` reporter.",
  );
}

// coverage-summary.json keys are absolute paths, except the "total" rollup.
// Relativise against cwd so the baseline can hold stable repo-relative dirs.
function measuredGroups(exempt) {
  const groups = new Map();
  const seenFiles = new Set();
  for (const [abs, file] of Object.entries(summary)) {
    if (abs === "total") continue;
    const rel = relative(process.cwd(), abs).split("\\").join("/");
    seenFiles.add(rel);
    if (exempt.has(rel)) continue;
    // Group by the file's own directory. No fixed depth: a newly nested
    // src/a/b/ becomes its own group, which is then unbaselined and fails —
    // a new subsystem cannot slip in uncovered.
    const dir = dirname(rel);
    let g = groups.get(dir);
    if (!g) {
      g = { statements: [0, 0], branches: [0, 0] };
      groups.set(dir, g);
    }
    for (const m of METRICS) {
      g[m][0] += file[m].covered;
      g[m][1] += file[m].total;
    }
  }
  // Aggregate from covered/total counts rather than averaging per-file
  // percentages: a 3-statement file at 0% must not weigh as much as a
  // 300-statement file at 100%.
  const pct = ([covered, total]) => (total === 0 ? 100 : (100 * covered) / total);
  return {
    seenFiles,
    groups: new Map(
      [...groups].map(([dir, g]) => [
        dir,
        Object.fromEntries(METRICS.map((m) => [m, pct(g[m])])),
      ]),
    ),
  };
}

// --- baseline -------------------------------------------------------------

function parseBaseline(path) {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    die(`cannot read baseline ${path}: ${err.message}`);
  }
  const floors = new Map();
  const exempt = new Set();
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts[0] === "!exempt") {
      if (parts.length !== 2) {
        die(`${path}:${i + 1}: !exempt takes exactly one path, got: ${line}`);
      }
      exempt.add(parts[1]);
      return;
    }
    if (parts.length !== 1 + METRICS.length) {
      die(
        `${path}:${i + 1}: expected "<dir> ${METRICS.map((m) => `<${m}>`).join(" ")}", got: ${line}`,
      );
    }
    const [dir, ...nums] = parts;
    if (floors.has(dir)) die(`${path}:${i + 1}: duplicate entry for ${dir}`);
    const want = {};
    nums.forEach((n, j) => {
      const v = Number(n);
      // Guards a silent-pass mode: "src/ccu 91.6 hgh" would parse to NaN, and
      // every NaN comparison is false, so the directory would sail through.
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        die(`${path}:${i + 1}: ${METRICS[j]} floor must be 0-100, got: ${n}`);
      }
      want[METRICS[j]] = v;
    });
    floors.set(dir, want);
  });
  return { floors, exempt };
}

// --- print-measured -------------------------------------------------------

if (baselinePath === "--print-measured") {
  // Seeding/raising aid. Deliberately prints to stdout instead of writing the
  // baseline: floors move only through a reviewed edit with the reason
  // recorded in the file, never as a side effect of running the tool.
  //
  // It MUST apply the existing exemptions. Ignoring them reported src at 47.1
  // instead of 96.3, because src/index.ts measures 0% as a subprocess artifact
  // — and pasting that number would have dropped the floor 49 points while
  // looking like routine maintenance.
  const existing = process.argv[4] ?? DEFAULT_BASELINE;
  let exempt = new Set();
  if (existsSync(existing)) {
    exempt = parseBaseline(existing).exempt;
    if (exempt.size) {
      console.log(`# exemptions applied from ${existing}: ${[...exempt].sort().join(", ")}`);
    }
  } else {
    console.log(`# WARNING: no baseline at ${existing} — exemptions NOT applied`);
  }
  const { groups } = measuredGroups(exempt);
  for (const [dir, got] of [...groups].sort()) {
    console.log(
      `${dir} ${METRICS.map((m) => (Math.floor(got[m] * 10) / 10).toFixed(1)).join(" ")}`,
    );
  }
  process.exit(0);
}

// --- compare --------------------------------------------------------------

const { floors, exempt } = parseBaseline(baselinePath);
const { groups, seenFiles } = measuredGroups(exempt);

let fail = 0;
const note = (ok, msg) => {
  console.log(`${ok ? "PASS " : "FAIL "} ${msg}`);
  if (!ok) fail = 1;
};

// A stale exemption is how this gate would rot into decoration: src/index.ts
// gets renamed, the exemption stops matching anything, and nobody notices that
// the replacement file is now silently dragging its group down (or worse, is
// itself exempt by a path that no longer means what it meant).
for (const path of [...exempt].sort()) {
  if (!seenFiles.has(path)) {
    note(false, `!exempt ${path}: no such file in the coverage report — moved or deleted? Update ${baselinePath}.`);
  }
}

// Unbaselined directories fail. Without this the ratchet is trivially
// bypassable: add src/newthing/ with no tests, and a baseline-driven loop
// never looks at it.
for (const dir of [...groups.keys()].sort()) {
  if (!floors.has(dir)) {
    note(
      false,
      `${dir}: covered by tests but absent from ${baselinePath} — new directory? ` +
        `Add a floor (see --print-measured).`,
    );
  }
}

for (const [dir, want] of [...floors].sort()) {
  const got = groups.get(dir);
  if (!got) {
    note(false, `${dir}: in baseline but absent from the coverage report — deleted or renamed? Update ${baselinePath} deliberately.`);
    continue;
  }
  for (const m of METRICS) {
    const g = got[m];
    const w = want[m];
    const shown = `${g.toFixed(2)}% vs floor ${w.toFixed(1)}%`;
    if (g + EPSILON < w) {
      note(false, `${dir} ${m}: ${shown} (epsilon ${EPSILON})`);
    } else if (g >= w + 1) {
      // Only nudge on a full point, so ordinary +0.2 drift doesn't spam every
      // run with advice nobody acts on.
      note(true, `${dir} ${m}: ${shown} — beats the floor, consider raising it`);
    } else {
      note(true, `${dir} ${m}: ${shown}`);
    }
  }
}

if (process.env.CCU_HOST) {
  console.log(
    "\nNOTE: CCU_HOST is set, so the live-integration suites ran and these " +
      "numbers are HIGHER than CI will measure. Do not raise floors from this run.",
  );
}

if (fail) {
  console.log(
    `\nCoverage ratchet failed. Add tests covering what this change touches; ` +
      `lowering a floor in ${baselinePath} requires the reason recorded in the file.`,
  );
}
process.exit(fail);
