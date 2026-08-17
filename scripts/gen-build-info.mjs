#!/usr/bin/env node
// Stamp the current git state into dist/build-info.json at build time so a
// running server can report exactly which checkout it was built from
// (get_system_info exposes it). Best-effort: outside a git checkout (e.g. an
// npm tarball or `git archive`), every git field is null — the build still
// succeeds. Runs after `tsc` (see package.json "build"), so dist/ exists.
//
// The container image is the case that made the null path worth fixing rather
// than merely tolerating: `.dockerignore` excludes `.git`, so a build inside
// the image has no repository to interrogate and every published image would
// report nothing about its own provenance. BUILD_COMMIT / BUILD_TAG let the
// caller supply what git would have answered. Git still wins whenever it is
// available — the environment is a fallback, never an override, so nothing can
// stamp a checkout with a commit it was not built from.
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

// An unset variable and one set to "" mean the same thing here: nothing was
// supplied. Docker passes an undeclared --build-arg through as an empty string,
// so treating "" as a value would stamp empty strings where null belongs.
const env = (name) => {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : null;
};

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
// Tracked modifications only (--untracked-files=no), matching `git describe --dirty`
// semantics: stray untracked files (drafts, build output) don't change which
// committed source the build came from, so they must not flip the dirty flag.
const status = git(["status", "--porcelain", "--untracked-files=no"]);

// All-or-nothing, not field-by-field: the environment is consulted only when
// git answered nothing at all. Falling back per field would let a stray
// BUILD_TAG in someone's shell label a real checkout with a tag it is not on,
// producing a record half-read from the repository and half-asserted by
// whoever set the variable.
const gitCommit = git(["rev-parse", "--short", "HEAD"]);
const noRepository = gitCommit === null;

// CI hands over the full 40-character sha because that is what the OCI
// `revision` label wants; `git rev-parse --short` answers 7. Truncate so the
// field has one shape whichever path produced it — a consumer comparing
// build-info against a release should not have to know how the image was built.
const envCommit = noRepository ? env("BUILD_COMMIT") : null;
const commit = gitCommit ?? (envCommit === null ? null : envCommit.slice(0, 7));
// exact-match returns the tag only when HEAD is *on* a tag, else null
const tag = noRepository ? env("BUILD_TAG") : git(["describe", "--tags", "--exact-match"]);

const buildInfo = {
  // branch is "HEAD" when detached (e.g. a CI checkout of a tag) — report null
  branch: branch === "HEAD" ? null : branch,
  commit,
  tag,
  // human-readable: <tag>-<n>-g<sha>[-dirty], or just <sha> with no tags
  describe: git(["describe", "--tags", "--dirty", "--always"]) ?? tag ?? commit,
  // null when not a git checkout; true if tracked files have uncommitted changes.
  // Stays null on the BUILD_COMMIT path on purpose: the caller asserting a
  // commit says nothing about whether the tree it built was clean, and
  // answering `false` there would be a claim this script cannot support.
  dirty: status === null ? null : status.length > 0,
  builtAt: new Date().toISOString(),
};

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n");
console.log("build-info:", JSON.stringify(buildInfo));
