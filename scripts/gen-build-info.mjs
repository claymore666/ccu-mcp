#!/usr/bin/env node
// Stamp the current git state into dist/build-info.json at build time so a
// running server can report exactly which checkout it was built from
// (get_system_info exposes it). Best-effort: outside a git checkout (e.g. an
// npm tarball or `git archive`), every git field is null — the build still
// succeeds. Runs after `tsc` (see package.json "build"), so dist/ exists.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const git = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null; // not a git checkout, or git unavailable
  }
};

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
// Tracked modifications only (--untracked-files=no), matching `git describe --dirty`
// semantics: stray untracked files (drafts, build output) don't change which
// committed source the build came from, so they must not flip the dirty flag.
const status = git(["status", "--porcelain", "--untracked-files=no"]);

const buildInfo = {
  // branch is "HEAD" when detached (e.g. a CI checkout of a tag) — report null
  branch: branch === "HEAD" ? null : branch,
  commit: git(["rev-parse", "--short", "HEAD"]),
  // exact-match returns the tag only when HEAD is *on* a tag, else null
  tag: git(["describe", "--tags", "--exact-match"]),
  // human-readable: <tag>-<n>-g<sha>[-dirty], or just <sha> with no tags
  describe: git(["describe", "--tags", "--dirty", "--always"]),
  // null when not a git checkout; true if tracked files have uncommitted changes
  dirty: status === null ? null : status.length > 0,
  builtAt: new Date().toISOString(),
};

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n");
console.log("build-info:", JSON.stringify(buildInfo));
