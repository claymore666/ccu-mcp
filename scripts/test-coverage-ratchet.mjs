#!/usr/bin/env node
// Table-driven tests for coverage-ratchet.mjs. Synthesizes
// coverage-summary.json fixtures and asserts the verdicts, because a ratchet
// that has never been observed to fail is indistinguishable from one that
// cannot fail. Every branch that produces exit 1 or exit 2 gets a case here.
//
// Run: node scripts/test-coverage-ratchet.mjs   (no deps, no build)

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RATCHET = join(dirname(fileURLToPath(import.meta.url)), "coverage-ratchet.mjs");
const TMP = mkdtempSync(join(tmpdir(), "ratchet-test-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

let failures = 0;

// files: { "src/a/x.ts": [stCovered, stTotal, brCovered, brTotal] }
// Keys are written as absolute paths under `cwd`, matching what v8 emits.
function writeSummary(name, files, cwd) {
  const out = { total: {} };
  for (const [rel, [sc, st, bc, bt]] of Object.entries(files)) {
    out[join(cwd, rel)] = {
      statements: { covered: sc, total: st, pct: st ? (100 * sc) / st : 100 },
      branches: { covered: bc, total: bt, pct: bt ? (100 * bc) / bt : 100 },
      functions: { covered: 0, total: 0, pct: 100 },
      lines: { covered: sc, total: st, pct: st ? (100 * sc) / st : 100 },
    };
  }
  const path = join(TMP, `${name}.json`);
  writeFileSync(path, JSON.stringify(out));
  return path;
}

function writeBaseline(name, text) {
  const path = join(TMP, `${name}.baseline.txt`);
  writeFileSync(path, text);
  return path;
}

// wantOut asserts on the diagnostic, not just the exit code. Without it a case
// can pass for the wrong reason: an uncaught TypeError also exits non-zero, so
// "it failed" alone cannot tell a clean verdict from a crash.
function check(name, wantExit, summaryPath, baselinePath, { env = {}, cwd = TMP, wantOut } = {}) {
  const res = spawnSync(process.execPath, [RATCHET, summaryPath, baselinePath], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, CCU_HOST: "", ...env },
  });
  const out = res.stdout + res.stderr;
  const problem =
    res.status !== wantExit
      ? `want exit ${wantExit}, got ${res.status}`
      : wantOut && !out.includes(wantOut)
        ? `expected output to contain ${JSON.stringify(wantOut)}`
        : null;
  if (!problem) {
    console.log(`PASS: ${name}`);
    return res;
  }
  console.log(`FAIL: ${name} (${problem})`);
  console.log(
    out
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  failures++;
  return res;
}

// A directory sitting exactly on its floor, and one comfortably above it.
const BASE = writeBaseline(
  "base",
  `# comments and blank lines are ignored

src/a 80.0 70.0
src/b 50.0 50.0
`,
);

// --- the happy paths -------------------------------------------------------

check(
  "exact hold passes",
  0,
  writeSummary("hold", { "src/a/x.ts": [80, 100, 70, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  BASE,
);

check(
  "improvement passes",
  0,
  writeSummary("up", { "src/a/x.ts": [90, 100, 85, 100], "src/b/y.ts": [61, 100, 60, 100] }, TMP),
  BASE,
);

check(
  "drop within epsilon passes",
  0,
  writeSummary("noise", { "src/a/x.ts": [797, 1000, 70, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  BASE,
);

// --- regressions must fail -------------------------------------------------

check(
  "statement regression fails",
  1,
  writeSummary("down", { "src/a/x.ts": [77, 100, 70, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  BASE,
);

check(
  "branch regression fails",
  1,
  writeSummary("downbr", { "src/a/x.ts": [80, 100, 60, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  BASE,
);

check(
  "regression in the second directory fails",
  1,
  writeSummary("downb", { "src/a/x.ts": [80, 100, 70, 100], "src/b/y.ts": [40, 100, 50, 100] }, TMP),
  BASE,
);

// A drop of exactly epsilon is on the pass side of the boundary; one hair more
// is not. Pins the comparison so a `<=`/`<` slip can't widen the tolerance.
check(
  "drop of exactly epsilon passes",
  0,
  writeSummary("eps", { "src/a/x.ts": [795, 1000, 70, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  BASE,
);
check(
  "drop of epsilon plus a hair fails",
  1,
  writeSummary("eps2", { "src/a/x.ts": [7949, 10000, 70, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  BASE,
);

check(
  "RATCHET_EPSILON is honoured",
  0,
  writeSummary("eps3", { "src/a/x.ts": [70, 100, 70, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  BASE,
  { env: { RATCHET_EPSILON: "10" } },
);

// --- drift between baseline and tree ---------------------------------------

check(
  "baselined directory absent from coverage fails",
  1,
  writeSummary("gone", { "src/a/x.ts": [80, 100, 70, 100] }, TMP),
  BASE,
  { wantOut: "src/b: in baseline but absent from the coverage report" },
);

// The hole a baseline-driven loop leaves open: iterate the baseline only, and
// a brand-new untested directory is never looked at.
check(
  "new directory missing from the baseline fails",
  1,
  writeSummary(
    "new",
    {
      "src/a/x.ts": [80, 100, 70, 100],
      "src/b/y.ts": [50, 100, 50, 100],
      "src/c/z.ts": [0, 100, 0, 100],
    },
    TMP,
  ),
  BASE,
  { wantOut: "src/c: covered by tests but absent from" },
);

// --- exemptions ------------------------------------------------------------

const EXEMPT_BASE = writeBaseline(
  "exempt",
  `!exempt src/a/entry.ts
src/a 80.0 70.0
src/b 50.0 50.0
`,
);

// Same fixture, with and without the exemption: proves the exempt file is
// actually dropped from the aggregate rather than the rule being inert.
const WITH_ENTRY = writeSummary(
  "withentry",
  {
    "src/a/x.ts": [80, 100, 70, 100],
    "src/a/entry.ts": [0, 100, 0, 100],
    "src/b/y.ts": [50, 100, 50, 100],
  },
  TMP,
);
check("exempt file is excluded from its directory's aggregate", 0, WITH_ENTRY, EXEMPT_BASE);
check("without the exemption the same tree fails", 1, WITH_ENTRY, BASE);

// A renamed exempt file must not fail open — otherwise the replacement drags
// the group down silently while the dead exemption looks like it's working.
check(
  "stale exemption fails",
  1,
  writeSummary("stale", { "src/a/x.ts": [80, 100, 70, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  EXEMPT_BASE,
  { wantOut: "!exempt src/a/entry.ts: no such file" },
);

// --- weighting -------------------------------------------------------------

// 1 covered of 1 in a tiny file, 0 of 99 in a big one is 1% weighted, but 50%
// as a naive mean of per-file percentages. The floor sits at 40 — between the
// two — so the case can only pass if the aggregate is genuinely weighted. With
// the floor at 80 both readings fail and the test proves nothing.
check(
  "aggregate is weighted by statement count, not a mean of file percentages",
  1,
  writeSummary(
    "weight",
    {
      "src/a/tiny.ts": [1, 1, 1, 1],
      "src/a/big.ts": [0, 99, 0, 99],
      "src/b/y.ts": [50, 100, 50, 100],
    },
    TMP,
  ),
  writeBaseline("weightbase", "src/a 40.0 40.0\nsrc/b 50.0 50.0\n"),
  { wantOut: "src/a statements: 1.00% vs floor 40.0%" },
);

// --- harness errors must exit 2, never 0 or 1 ------------------------------

check("missing coverage summary exits 2", 2, join(TMP, "nope.json"), BASE);
check(
  "missing baseline exits 2",
  2,
  writeSummary("ok1", { "src/a/x.ts": [80, 100, 70, 100], "src/b/y.ts": [50, 100, 50, 100] }, TMP),
  join(TMP, "nope.txt"),
);

const OK = writeSummary(
  "ok2",
  { "src/a/x.ts": [80, 100, 70, 100], "src/b/y.ts": [50, 100, 50, 100] },
  TMP,
);

// A non-numeric floor would become NaN, and every NaN comparison is false, so
// the directory would pass unconditionally. Must be rejected at parse time.
check("non-numeric floor exits 2", 2, OK, writeBaseline("nan", "src/a 80.0 hgh\n"));
check("out-of-range floor exits 2", 2, OK, writeBaseline("range", "src/a 80.0 140\n"));
check("wrong field count exits 2", 2, OK, writeBaseline("short", "src/a 80.0\n"));
check("duplicate directory entry exits 2", 2, OK, writeBaseline("dup", "src/a 80.0 70.0\nsrc/a 10.0 10.0\n"));
check("malformed !exempt exits 2", 2, OK, writeBaseline("badex", "!exempt a b\nsrc/a 80.0 70.0\n"));
check("negative RATCHET_EPSILON exits 2", 2, OK, BASE, { env: { RATCHET_EPSILON: "-1" } });
check("non-numeric RATCHET_EPSILON exits 2", 2, OK, BASE, { env: { RATCHET_EPSILON: "wide" } });

// Truncated JSON is a plausible real failure (interrupted run, full disk); it
// must read as "cannot check", not as a clean tree.
check("corrupt coverage summary exits 2", 2, writeBaseline("corrupt", "{not json"), BASE);

// --- --print-measured ------------------------------------------------------

{
  const before = readFileSync(BASE, "utf-8");
  const res = spawnSync(process.execPath, [RATCHET, OK, "--print-measured"], {
    cwd: TMP,
    encoding: "utf-8",
  });
  const ok =
    res.status === 0 &&
    res.stdout.includes("src/a 80.0 70.0") &&
    readFileSync(BASE, "utf-8") === before;
  console.log(`${ok ? "PASS" : "FAIL"}: --print-measured reports floors and writes nothing`);
  if (!ok) {
    console.log(`    exit ${res.status}\n${res.stdout}${res.stderr}`);
    failures++;
  }
}

// Without this, --print-measured reported src at 47.1 instead of 96.3 on the
// real repo, because it ignored the src/index.ts exemption. Pasting that back
// would have dropped the floor 49 points and looked like routine maintenance.
{
  const res = spawnSync(
    process.execPath,
    [RATCHET, WITH_ENTRY, "--print-measured", EXEMPT_BASE],
    { cwd: TMP, encoding: "utf-8" },
  );
  // src/a is 80/100 once the 0/100 entry.ts is dropped; 40.0 if it is not.
  const ok =
    res.status === 0 &&
    res.stdout.includes("src/a 80.0 70.0") &&
    !res.stdout.includes("src/a 40.0") &&
    res.stdout.includes("src/a/entry.ts");
  console.log(`${ok ? "PASS" : "FAIL"}: --print-measured applies the baseline's exemptions`);
  if (!ok) {
    console.log(`    exit ${res.status}\n${res.stdout}${res.stderr}`);
    failures++;
  }
}

// A missing baseline must say so rather than quietly print unexempted numbers.
{
  const res = spawnSync(
    process.execPath,
    [RATCHET, WITH_ENTRY, "--print-measured", join(TMP, "no-such-baseline.txt")],
    { cwd: TMP, encoding: "utf-8" },
  );
  const ok = res.status === 0 && res.stdout.includes("exemptions NOT applied");
  console.log(`${ok ? "PASS" : "FAIL"}: --print-measured warns when it has no baseline`);
  if (!ok) {
    console.log(`    exit ${res.status}\n${res.stdout}${res.stderr}`);
    failures++;
  }
}

// --- summary ---------------------------------------------------------------

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall coverage-ratchet tests passed");
