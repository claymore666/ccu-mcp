#!/usr/bin/env node
// Failsafe gate: ONE Node major, everywhere. Exits non-zero (with a
// remediation hint) when the four places that pick a Node version disagree.
//
// Why this exists: the Node major lives in four files that no single change
// touches, and nothing here builds the Dockerfile before a release. When
// Dependabot auto-merged `node:24-alpine` -> `node:26-alpine` (#169), every
// check stayed green — the published container would have been the first thing
// to run that major, on a base the test suite had never executed on. An
// average of green checks hid it; this reads the four numbers and compares.
//
// Checks (package.json `engines.node` is the reference — it is the floor the
// package publicly claims, and the number consumers actually depend on):
//   1. Dockerfile   FROM node:<major>-…    == engines major, every stage
//   2. workflows    node-version: "<major>" == engines major, every occurrence
//   3. package.json @types/node ^<major>   == engines major
//
// A source that matches NOTHING is a failure, not a pass: a Dockerfile with no
// `FROM node:` line, or a workflow directory with no `node-version:` anywhere,
// means this gate has quietly stopped checking the thing it was written for.
//
// Usage:
//   node scripts/check-node-version.mjs      # exit 0 in sync, 1 on drift
//
// Test seam: PKG_FILE / DOCKERFILE / WORKFLOW_DIR point the check at synthetic
// fixtures (see test/unit/node-version-sync.test.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PKG = process.env.PKG_FILE ?? "package.json";
const DOCKERFILE = process.env.DOCKERFILE ?? "Dockerfile";
const WORKFLOW_DIR = process.env.WORKFLOW_DIR ?? ".github/workflows";

const problems = [];
const rows = [];

const pkg = JSON.parse(readFileSync(PKG, "utf8"));

// The reference. `>=24`, `^24.1.0`, `24.x` — take the first number in the
// range, which is the major every form of it starts with.
const enginesRange = pkg.engines?.node ?? "";
const reference = /(\d+)/.exec(enginesRange)?.[1] ?? null;
rows.push([`${PKG} engines.node`, enginesRange || "(missing)"]);
if (reference === null) {
  console.error(`::error::${PKG} engines.node "${enginesRange}" has no major version to read.`);
  process.exit(1);
}

const expect = (label, found, where) => {
  rows.push([label, where]);
  if (found !== reference) {
    problems.push(`${label} is Node ${found}, but ${PKG} engines.node is ">=${reference}"`);
  }
};

// 1. Dockerfile — every stage. Multi-stage builds have caught this before:
// bumping the runtime stage and forgetting the builder compiles on one major
// and runs on another.
const dockerfile = readFileSync(DOCKERFILE, "utf8");
const fromLines = [...dockerfile.matchAll(/^FROM\s+node:(\d+)(\S*)/gm)];
if (fromLines.length === 0) {
  problems.push(`${DOCKERFILE} has no \`FROM node:<major>\` line — this gate has nothing to check`);
}
fromLines.forEach((m, i) => {
  expect(`${DOCKERFILE} FROM[${i}]`, m[1], `node:${m[1]}${m[2]}`);
});

// 2. Workflows — every `node-version:`, quoted or not. setup-node's version is
// what CI executes the tests on; it is the claim `engines` makes, tested.
let workflowHits = 0;
const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort();
for (const file of workflows) {
  const text = readFileSync(join(WORKFLOW_DIR, file), "utf8");
  for (const m of text.matchAll(/node-version:\s*["']?(\d+)/g)) {
    workflowHits += 1;
    expect(`${file} node-version`, m[1], m[1]);
  }
}
if (workflowHits === 0) {
  problems.push(`no \`node-version:\` found in ${WORKFLOW_DIR} — this gate has nothing to check`);
}

// 3. @types/node — types from a newer major describe APIs the supported Node
// does not have, and `tsc` is the only thing that would ever notice.
const typesRange = pkg.devDependencies?.["@types/node"];
if (typesRange === undefined) {
  problems.push(`${PKG} has no @types/node devDependency — the type check has no Node types to pin`);
} else {
  const typesMajor = /(\d+)/.exec(typesRange)?.[1] ?? null;
  if (typesMajor === null) {
    problems.push(`${PKG} @types/node "${typesRange}" has no major version to read`);
  } else {
    expect(`${PKG} @types/node`, typesMajor, typesRange);
  }
}

const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, value] of rows) {
  console.log(`  ${label.padEnd(width)}  ${value}`);
}
console.log();

if (problems.length > 0) {
  console.error("Node version drift:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error();
  console.error("Fix: move all four together, in one PR — Dockerfile (both stages),");
  console.error("every workflow's node-version, package.json engines and @types/node.");
  console.error("Dependabot is configured NOT to propose either major on its own.");
  process.exit(1);
}

console.log(`Node ${reference} everywhere.`);
