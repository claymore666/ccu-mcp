#!/usr/bin/env node
// Automatism: copy package.json's version into server.json's two version
// fields (root `version` and `packages[0].version`), so the MCP registry
// manifest always matches the npm package.
//
// Runs automatically from the `version` npm lifecycle hook (see
// package.json "scripts.version"), so `npm version <patch|minor|major>`
// bumps all three spots in one command. Also runnable by hand:
//   node scripts/sync-server-version.mjs
//
// Idempotent: a no-op (and prints so) when already in sync. Preserves the
// file's 2-space indentation and trailing newline.
import { readFileSync, writeFileSync } from "node:fs";

const PKG = process.env.PKG_FILE ?? "package.json";
const SERVER = process.env.SERVER_FILE ?? "server.json";

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const raw = readFileSync(SERVER, "utf8");
const server = JSON.parse(raw);

const version = pkg.version;
if (!version) {
  console.error(`sync-server-version: no "version" in ${PKG}`);
  process.exit(1);
}

let changed = false;
if (server.version !== version) {
  server.version = version;
  changed = true;
}
if (Array.isArray(server.packages)) {
  for (const p of server.packages) {
    if (p.version !== version) {
      p.version = version;
      changed = true;
    }
  }
}

if (!changed) {
  console.log(`sync-server-version: ${SERVER} already at ${version} — no change`);
  process.exit(0);
}

writeFileSync(SERVER, JSON.stringify(server, null, 2) + "\n");
console.log(`sync-server-version: set ${SERVER} version → ${version}`);
