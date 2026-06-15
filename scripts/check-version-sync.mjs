#!/usr/bin/env node
// Failsafe gate: assert the release version is consistent across the three
// places it lives, plus that the package identity matches. Exits non-zero
// (with a remediation hint) on any drift, so CI and `prepublishOnly` block a
// release whose npm package and MCP registry manifest disagree.
//
// Checks:
//   1. package.json  version            == server.json  version
//   2. package.json  version            == server.json  packages[].version
//   3. package.json  mcpName            == server.json  name
//
// Usage:
//   node scripts/check-version-sync.mjs      # exit 0 in sync, 1 on drift
//
// Test seam: PKG_FILE / SERVER_FILE env vars point the check at synthetic
// fixtures, so scripts gate logic is exercisable offline
// (see test/check-version-sync.test.ts).
import { readFileSync } from "node:fs";

const PKG = process.env.PKG_FILE ?? "package.json";
const SERVER = process.env.SERVER_FILE ?? "server.json";

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const server = JSON.parse(readFileSync(SERVER, "utf8"));

const problems = [];
const rows = [];

const pkgVersion = pkg.version;
rows.push([`${PKG} version`, pkgVersion]);

if (server.version !== pkgVersion) {
  problems.push(`${SERVER} version "${server.version}" != ${PKG} version "${pkgVersion}"`);
}
rows.push([`${SERVER} version`, server.version]);

const packages = Array.isArray(server.packages) ? server.packages : [];
packages.forEach((p, i) => {
  if (p.version !== pkgVersion) {
    problems.push(`${SERVER} packages[${i}].version "${p.version}" != ${PKG} version "${pkgVersion}"`);
  }
  rows.push([`${SERVER} packages[${i}].version`, p.version]);
});

if (pkg.mcpName !== server.name) {
  problems.push(`${PKG} mcpName "${pkg.mcpName}" != ${SERVER} name "${server.name}"`);
}
rows.push([`${PKG} mcpName`, pkg.mcpName]);
rows.push([`${SERVER} name`, server.name]);

const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, value] of rows) {
  console.log(`  ${label.padEnd(width)}  ${value}`);
}
console.log();

if (problems.length > 0) {
  console.error("Version/identity drift:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error();
  console.error("Fix: bump with `npm version <patch|minor|major>` (auto-syncs");
  console.error("server.json), or run `node scripts/sync-server-version.mjs`.");
  process.exit(1);
}

console.log("Versions in sync.");
