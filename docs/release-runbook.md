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

1. `npm login` (or set `NPM_TOKEN` / `~/.npmrc` with an automation token).
   Confirm with `npm whoami`.
2. If the npm account has 2FA set to **auth-and-publish**, `npm publish`
   prompts for a one-time code — pass it with `--otp=<code>` in
   non-interactive shells. 2FA set to **auth-only** doesn't prompt on
   publish.

Symptom if missed: `npm publish` ends `ENEEDAUTH` (not logged in) or
`EOTP` (OTP required). Neither mutates anything — fix auth and re-run.

### MCP registry — publisher auth

The registry listing is published from `server.json` with the
`mcp-publisher` CLI. The server namespace is `io.github.claymore666/*`, which
is authorized via GitHub login (OIDC) — the GitHub account must own the
`claymore666` namespace.

1. `mcp-publisher login github` (interactive; opens a device-code flow).
2. Authorization persists locally; re-login only when the token expires.

The `io.github.<user>/*` namespace maps to the GitHub user, so no DNS TXT
record is needed (that path is only for custom-domain namespaces).

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

4. **Write the release notes.** This repo has no `RELEASE_NOTES.md` /
   `CHANGELOG.md`; the notes live in the **GitHub Release body** (step 8).
   Draft them now while the change set is fresh — summarise in user-visible
   terms and call out any compatibility notes (new required env var, changed
   tool contract, dropped behaviour). If you'd rather have an in-repo
   changelog, that's a separate decision — introduce it before, not during, a
   release.

5. **PR `release/vX.Y.Z` → `dev`.** Required check: `CI` (build + test +
   `npm audit --audit-level=high`). Merge when green.

6. **Open the release PR `dev` → `main`** titled `Release vX.Y.Z`, with a
   `Closes #N` line for **every issue** in the milestone — that list is what
   auto-closes them and lets the milestone close. `main` is protected, so
   this PR is the only way in; merge it when CI is green.

7. **Tag `vX.Y.Z` on `main`:**
   ```sh
   git checkout main && git pull --ff-only
   git tag -s vX.Y.Z -m "vX.Y.Z — <one-liner>"   # -s = signed; shows Verified
   git push origin vX.Y.Z
   ```
   `-s` signs the tag (shows **Verified** on GitHub) if a signing key is
   configured; plain `git tag vX.Y.Z` is acceptable if not. Confirm with
   `git tag -v vX.Y.Z` when signed.

8. **Publish — npm, then the MCP registry, then the GitHub Release.** All
   from the tagged `main` checkout, so the artifacts match the tag:
   ```sh
   npm publish                       # add --otp=<code> if 2FA prompts
   mcp-publisher publish             # reads server.json
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "<step 4 notes>"
   ```
   `prepublishOnly` re-runs `npm run lint && npm test` before the upload, so a
   broken build can't ship. Order matters only in that npm must succeed first
   — the registry entry points consumers at the npm package.

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
| `npm publish` ends `EOTP` | npm 2FA set to auth-and-publish | re-run with `--otp=<code>` |
| `npm publish` ends `ENEEDAUTH` | not logged in / token expired | `npm login`, confirm `npm whoami`, re-run |
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
