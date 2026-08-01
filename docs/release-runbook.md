# Release runbook

How to publish a `vX.Y.Z` of `ccu-mcp`. The release is **manual** —
there is no release workflow (CI only builds and tests). The publish
targets are **npm** (`npx ccu-mcp`, the primary install path) and the
**official MCP registry** (`registry.modelcontextprotocol.io`). The Docker
image is build-your-own (`docker-compose` builds from source); nothing is
pushed to a container registry, so there is no image-publish step.

The goal: a release is a tag plus two `publish` commands, with version
numbers that agree everywhere before any of it happens.

## Branching context

This repo runs the `main ⇄ dev` model (see the project brief). `dev` is the
default/integration branch; `main` is protected and holds released code;
each release is a tag `vX.Y.Z` on `main`. Branch off `dev`, never `main`.
This runbook expands the release half of that model.

## One-time: the v1.5.0 rename (`debmatic-mcp` → `ccu-mcp`)

The project was renamed from `debmatic-mcp` to `ccu-mcp` for v1.5.0 (the name
is CCU-platform-generic; the tool was never debmatic-specific). The in-repo
code/docs change shipped in the rename PR. The out-of-repo moves below are
**one-time owner actions**, done around the v1.5.0 release — *not* every
release:

1. **GitHub repo rename** — Settings → rename `claymore666/debmatic-mcp` →
   `claymore666/ccu-mcp`. GitHub keeps redirects from the old URL and git
   remote indefinitely. Update the local clone: `git remote set-url origin
   https://github.com/claymore666/ccu-mcp.git`. Do this **before** the
   `mcp-publisher publish` so the `io.github.claymore666/ccu-mcp` namespace
   resolves.
2. **npm** — there is no rename. Publish the new `ccu-mcp` package via the
   normal per-release flow below, then tombstone the old name:
   `npm deprecate debmatic-mcp "renamed to ccu-mcp — install ccu-mcp instead"`.
   The old package stays published forever; the deprecation warning points
   users across.
3. **MCP registry** — `mcp-publisher publish` creates the new
   `io.github.claymore666/ccu-mcp` entry. The old
   `io.github.claymore666/debmatic-mcp` entry remains; leave it.
4. **Smithery** — re-list as `ccu-mcp` (was `christian-kamien/debmatic-mcp`,
   MCPB bundle).
5. **glama.ai badge** — auto-derives from the repo path, so it follows the
   GitHub rename; the README badge URL was already updated to `…/ccu-mcp`.

After v1.5.0 ships, this section is historical — the steady-state procedure
below is all that applies to subsequent releases.

## One-time prerequisites

Per-account setup, **not** per-release. Done once when the publishing chain
is first wired up.

### npm — publish auth

`ccu-mcp` is published to npm under the unscoped name `ccu-mcp`
(`package.json` `name`). Publishing needs an authenticated npm session with
publish rights on that package.

**The normal path is CI, not your laptop.** `.github/workflows/publish.yml`
publishes through npm **trusted publishing** (OIDC): npm mints a short-lived
credential from the OIDC claim GitHub issues for that workflow file, in this
repo, in the `release` environment. There is no `NPM_TOKEN` secret and there
must never be one.

That also means **provenance is generated automatically** — no `--provenance`
flag — which is what makes the published artifact verifiable.

The package is set to **"Require two-factor authentication and disallow
tokens"** on npmjs.com. Granular and automation tokens cannot publish it at
all, regardless of their bypass-2FA setting. Do not add one back; it would not
work, and it would reintroduce exactly the credential this removed.

Three things are pinned together and must not drift apart — npmjs.com's trusted
publisher config names all three, and a mismatch fails the publish closed:

| | |
| --- | --- |
| Workflow filename | `publish.yml` |
| Environment | `release` |
| Repository | `claymore666/ccu-mcp` |

The `release` environment requires review from `claymore666` before the publish
job runs. That approval click is the deliberate replacement for the YubiKey
touch a local publish demanded. Its branch policy allows only `v*` tags and
`main`, so a run from `dev` is refused before any job starts.

**Manual fallback.** Interactive publishing still works and is unaffected by
the token restriction — only tokens are disallowed, not humans:

1. `npm login` (interactive; the web flow). Confirm with `npm whoami`.
2. `npm publish` prompts for a one-time code — pass `--otp=<code>` in
   non-interactive shells.

A manual publish produces **no provenance**, so prefer CI. Symptom if auth is
missed: `ENEEDAUTH` (not logged in) or `EOTP` (OTP required). Neither mutates
anything — fix auth and re-run.

### MCP registry — publisher auth

The registry listing is published from `server.json` with the
`mcp-publisher` CLI. The server namespace is `io.github.claymore666/*`, which
is authorized via GitHub login (OIDC) — the GitHub account must own the
`claymore666` namespace.

**Releases need no login at all.** `publish.yml` runs
`mcp-publisher login github-oidc`, which exchanges the workflow's OIDC token —
the same one npm uses — for registry authorisation. Nothing to store, nothing
to expire.

Only publishing **by hand** needs the interactive flow:

1. `mcp-publisher login github` (opens a device-code flow).
2. Authorization persists locally; re-login only when the token expires.

The `io.github.<user>/*` namespace maps to the GitHub user, so no DNS TXT
record is needed (that path is only for custom-domain namespaces). It is also
why OIDC works: the repository owner in the claim *is* the namespace owner.

### Pre-flight validation (do this every release, costs nothing)

Both publish targets have a dry-run that touches nothing remote. Run them on
the release branch before tagging:

```sh
npm run check:versions       # package.json <-> server.json versions agree
npm publish --dry-run        # lists the tarball contents; no upload
mcp-publisher validate       # validates server.json against the live schema
```

`npm publish --dry-run` is the cheap check that `files` in `package.json`
ships what you expect (`dist`, `README.md`, `LICENSE`) and nothing secret.
`mcp-publisher validate` must print `✅ server.json is valid`.

## Per-release procedure

Pre-flight: every issue/PR going into the release should be on the `vX.Y.Z`
milestone — it's the source of the `Closes #N` list in the release PR.

1. **Branch off `dev`:** `git checkout -b release/vX.Y.Z origin/dev`

2. **Bump the version — one command, three files.** The version lives in
   `package.json`, `server.json` root `version`, and `server.json`
   `packages[0].version`; the MCP registry rejects a publish where they
   disagree and the npm version is immutable once published. A single command
   keeps all three in sync:
   ```sh
   npm version <patch|minor|major> --no-git-tag-version
   ```
   `npm version` runs the `version` lifecycle hook (`scripts/sync-server-version.mjs`),
   which copies the new version into both `server.json` spots and stages it —
   so you never hand-edit `server.json`. `--no-git-tag-version` is deliberate:
   it edits `package.json` + `package-lock.json` (+ syncs `server.json`) but
   creates **no** commit/tag here; the tag is made later on `main` (step 7).

   Confirm they agree (the same check CI runs):
   ```sh
   npm run check:versions     # exits non-zero on any drift
   ```
   This gate also runs in CI on every push and in `prepublishOnly`, so a
   drifted manifest can't merge or publish even if the bump is done by hand.
   The README install snippets use unversioned `npx ccu-mcp` /
   `claude mcp add` — there are **no pinned version strings to bump there**.
   Keep it that way; don't add versioned `npx ccu-mcp@X.Y.Z` snippets to
   the README, or this list grows.

3. **Documentation review — against the milestone, not from memory.** List
   every PR on the `vX.Y.Z` milestone and reconcile each user-visible change
   against the docs:
   ```sh
   gh pr list --state merged --limit 200 \
     --json number,title,milestone \
     --jq '.[] | select(.milestone.title=="vX.Y.Z") | "#\(.number) \(.title)"'
   ```
   For **each** merged PR: a new or changed tool lands in the README tool
   list and in the `help` tool's `CONCEPTUAL_GUIDE` / `TOOL_HELP`
   (`src/tools/meta.ts`) — these are user-facing surfaces that drift
   silently. New env vars land in the README config table, `docker-compose.yml`
   comments, and `server.json` `environmentVariables`. A milestone PR that
   changed behaviour but carries no doc/help delta is the signal to look
   harder, not to wave through. Then still read the README top-to-bottom for
   anything the per-PR pass missed.

4. **Write the release notes — into `CHANGELOG.md`, then reuse them.** Add a
   `## vX.Y.Z — YYYY-MM-DD` section at the top of `CHANGELOG.md` following the
   existing convention: a short prose paragraph summarising the release, then
   `###` subsections (`Security`, `Behavior changes (read before upgrading)`,
   `Fixed`, `Added`, `Internal`, `Dependencies` — only the ones that apply).
   Draft it while the change set is fresh; summarise in user-visible terms and
   call out compatibility notes (new required env var, changed tool contract,
   dropped behaviour). The same text becomes the **GitHub Release body** in
   step 8, so write it once here.

   `CHANGELOG.md` is **not** covered by `npm run check:versions` — nothing
   fails if you forget it. It's on you.

5. **PR `release/vX.Y.Z` → `dev`.** Required check: `build-and-test` (version
   sync + type check + build + test). Merge when green.

   Note it does **not** include a dependency audit: `build-and-test` is
   hermetic by contract, and `npm audit`'s verdict depends on the GitHub
   Advisory DB rather than on the commit. Scanning happens in
   `.github/workflows/audit.yml` (daily, files a tracking issue) and at the
   release gate in step 6.

6. **Open the release PR `dev` → `main`** titled `Release vX.Y.Z`, with a
   `Closes #N` line for **every issue** in the milestone — that list is what
   auto-closes them and lets the milestone close. `main` is protected, so
   this PR is the only way in; merge it when the checks are green.

   **The workflow runs on this PR may sit at `action_required`** — GitHub
   holds the `pull_request` runs on the merge ref pending approval, and the
   PR stays `BLOCKED` with the required checks simply never reporting. It
   looks like a broken gate; it is just an unapproved run. Approve both:
   ```sh
   gh run list --limit 6 --json databaseId,workflowName,conclusion \
     --jq '.[] | select(.conclusion=="action_required") | .databaseId'
   # then, per id:
   gh api -X POST repos/claymore666/ccu-mcp/actions/runs/<id>/approve
   ```
   They re-queue immediately and report normally.

   Required checks here: `build-and-test`, `release-title`, and
   **`release-audit`** — the last asserts no high/critical advisories in
   production dependencies (`npm audit --omit=dev`). It is the one gate that
   can go red with no diff, because a new advisory landed since the branch was
   cut; that is deliberate and correct at this point — don't tag and publish a
   known-vulnerable tree. To clear it, fix on `dev` with
   `npm audit fix --package-lock-only`, re-run `npm ci && npm run lint &&
   npm test`, land it, then update the release PR. If the advisory is
   genuinely unreachable from shipped code, an admin can override
   (`enforce_admins` is off) — record the reasoning in the PR.

7. **Tag `vX.Y.Z` on `main`:**
   ```sh
   git checkout main && git pull --ff-only
   git tag -s vX.Y.Z -m "vX.Y.Z — <one-liner>"   # -s = signed; shows Verified
   git push origin vX.Y.Z
   ```
   `-s` signs the tag (shows **Verified** on GitHub) if a signing key is
   configured; plain `git tag vX.Y.Z` is acceptable if not. Confirm with
   `git tag -v vX.Y.Z` when signed.

8. **Publish.** npm goes first — the MCP registry entry points consumers at the
   npm package — but the order is now inverted from the old manual flow,
   because npm publishing is triggered *by* the GitHub Release:

   ```sh
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "<step 4 notes>"
   ```

   That fires `publish.yml`. It runs `verify` (version sync, tag-vs-
   package.json agreement, lint, tests, `npm pack --dry-run`) with no human
   present, then **waits for your approval** on the `release` environment
   before publishing. Approve it in the run's UI.

   That one approval covers **both** registries. After npm, the same job
   authenticates to the MCP registry with the same OIDC token
   (`mcp-publisher login github-oidc`) and publishes `server.json`. There is no
   registry credential to store either: the registry authorises the
   `io.github.claymore666/*` namespace from the repository owner in the claim.

   Deliberately one job and one approval, not two. A gate clicked twice per
   release is a gate that stops being read.

   The workflow refuses to publish when the tag and `package.json` disagree,
   fails the run if the npm upload comes back without provenance attestations,
   and fails if the MCP registry does not report the new version as
   `isLatest`. `prepublishOnly` re-runs `lint && test` on top of all that.
   `server.json` is validated in the `verify` job, before anyone is asked to
   approve anything.

   **Nothing here needs `mcp-publisher login github` any more.** The
   interactive device-code flow is only for publishing by hand.

   Finally the same job builds the MCPB bundle (`npm run build:mcpb`) and
   publishes the Smithery listing. All three registries, one approval.

   **Smithery is the one place a stored credential remains.** npm and the MCP
   registry authenticate by OIDC; Smithery has no OIDC path, and its restricted
   service tokens cap at a 24-hour TTL — too short to survive between releases.
   So `SMITHERY_API_KEY` is stored as an **environment** secret on `release`,
   not a repo secret: only a job naming that environment can read it, and
   reaching that environment needs a human approval. Rotate it there
   (Settings → Environments → release → Secrets), never as a repo secret.

   Smithery runs last on purpose — a failure there cannot abort an npm or MCP
   publish that has already succeeded. If it does fail, everything else is
   already live and the fix is a local rerun:
   ```sh
   npm run build && npm run build:mcpb
   SMITHERY_API_KEY=… npx @smithery/cli mcp publish ccu-mcp-X.Y.Z.mcpb -n christian-kamien/ccu-mcp
   ```

   The bundle manifest is **generated** by `scripts/build-mcpb.sh` from
   `smithery/manifest.template.json`, with the version injected from
   `package.json`. The template carries no version deliberately — a committed
   one would be a fourth place the release version lives, and three already
   need a sync script and a CI gate to stay honest.

   The `description` shown on Smithery is **not** settable from the bundle;
   it is a web-dashboard field. Re-publishing appears to blank it, so check
   the listing after a release.

   **Rehearsing it, and the limit of a rehearsal.** `workflow_dispatch` on
   `publish.yml` defaults to `dry_run: true`. That checks the workflow wiring,
   the environment gate and the tarball contents, and uploads nothing.

   It does **not** exercise the OIDC credential exchange, and cannot:
   `npm publish --dry-run` never issues the PUT, so no credential is ever
   requested. A dry run against an already-published version stops earlier
   still, at `You cannot publish over the previously published versions`,
   which the registry answers without authentication. **The first real publish
   is the only test of the OIDC path.**

   That is acceptable because it fails closed. If the exchange fails,
   `npm publish` errors on authentication, the job goes red and nothing
   reaches the registry; if something published without provenance, the
   "Verify provenance landed" step re-reads the registry and fails the run.

   Rehearse after any change to the workflow, the environment, or the npmjs
   trusted-publisher config — just don't read a green dry run as proof the
   credentials work.

   **If CI publishing is broken mid-release**, fall back to `npm publish` from
   the tagged checkout with `--otp=<code>`. It works, but produces no
   provenance — note it in the release and re-check `signed_releases`.

9. **Fast-forward `dev` to `main`** so the version bump and any release-branch
   edits land on `dev` too:
   ```sh
   git checkout dev && git merge --ff-only main && git push origin dev
   ```
   Skipping this leaves the next feature branch starting from the previous
   version's `package.json`/`server.json`, and the next release PR has to
   re-bump them.

10. **Prune merged branches.** If *Automatically delete head branches* is on,
    PR heads go on merge. The `release/vX.Y.Z` branch was never a PR head into
    `main` directly, so remove it and sweep for stragglers:
    ```sh
    git push origin --delete release/vX.Y.Z
    git fetch --prune origin
    git branch -r --merged origin/dev | grep -vE 'origin/(dev|main|HEAD)$'
    ```
    Delete what the sweep lists; leave open-PR and Dependabot branches alone.

## Verifying

After publishing:

- `npm view ccu-mcp version` returns `vX.Y.Z` (allow a minute for the
  registry to update). `npx -y ccu-mcp@X.Y.Z --help` from a clean
  machine pulls and runs it.
- The MCP registry shows the new version:
  `curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.claymore666/ccu-mcp' | jq '.servers[].version'`.
- `gh release view vX.Y.Z` shows the notes body.
- The milestone is closed:
  `gh issue list --milestone vX.Y.Z --state open` — should be empty.

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `npm publish` ends `EOTP` | manual fallback path; npm 2FA prompts | re-run with `--otp=<code>` |
| `npm publish` ends `ENEEDAUTH` | manual fallback path; not logged in / session expired | `npm login`, confirm `npm whoami`, re-run |
| `publish.yml` never starts | environment branch policy allows only `v*` tags and `main` | check the run was triggered from a tag, not `dev` |
| `publish.yml` waits forever | `release` environment needs your approval | approve the deployment in the run's UI |
| npm rejects the OIDC exchange | workflow filename, environment name or repo does not match the trusted-publisher config on npmjs.com | all three are pinned — reconcile them, don't add a token |
| Published, but "Verify provenance landed" fails | published without attestations (e.g. a manual fallback publish) | the version is immutable; note it, and fix the path before the next release |
| `npm publish` ends `403 cannot publish over previously published version` | version already on npm (npm is immutable) | bump to the next patch; never re-use a version |
| `mcp-publisher publish` rejects the version | `server.json` version ≠ npm package version, or `mcpName` missing in `package.json` | align all three version spots (step 2); ensure `package.json` `mcpName` matches `server.json` `name` |
| `mcp-publisher` 401 / auth error | publisher login expired | `mcp-publisher login github` again |
| GitHub Release exists but npm/registry don't | published the release before the `publish` commands | run `npm publish` + `mcp-publisher publish` from the tagged checkout |

## Backports between `dev` and `main`

When a release-blocking hotfix must land on `main` without going through
`dev`:

1. Branch off `main`, fix, PR to `main`, merge. Don't push to `main`
   directly — branch protection and the audit trail.
2. Cherry-pick the same commit onto a branch off `dev`, PR to `dev`, so `dev`
   doesn't regress on the next release PR.

## Not applicable (deliberately omitted)

These are in the docker-net-dhcp runbook but don't apply here, noted so their
absence reads as a decision, not an oversight:

- **Container registry publish (GHCR / Docker Hub), image signing (cosign),
  SBOM, provenance** — no image is published; the Dockerfile is built locally
  by `docker-compose`. If a published image is ever added, the GHCR-linking
  and signing prerequisites from that runbook become relevant.
- **Versioned docs site (mkdocs / GitHub Pages)** — docs are the README plus
  this `docs/` folder; there's no published site to reconcile.
- **rc dry-run via the release workflow / coverage ratchet** — there's no
  release workflow to dry-run and no coverage gate. The pre-flight
  `npm publish --dry-run` + `mcp-publisher validate` (above) are the
  equivalent cheap checks.
