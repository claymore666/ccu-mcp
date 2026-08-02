# Governance

ccu-mcp is a single-maintainer project. This document says who decides what,
how, and — honestly — where that arrangement is currently thin.

## Model

**Benevolent dictator.** Christian Kamien (GitHub [@claymore666][cm],
`claymore666` on the [HomeMatic forum][forum]) is the maintainer and makes all
final decisions: what gets merged, what gets released, and what the project
does not do.

This is not an aspiration to a larger structure. The project is small, the
scope is narrow, and a heavier process would cost more than it returns. If the
contributor base grows, this document changes with it.

Anyone may fork, as with any MIT-licensed project. That is the ultimate check
on this model and it needs no permission.

[cm]: https://github.com/claymore666
[forum]: https://homematic-forum.de/

## Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| **Maintainer** | @claymore666 | Reviews and merges PRs; triages issues; decides scope and roadmap; cuts releases (tag, npm, MCP registry, Smithery); holds all signing keys and registry credentials; receives and handles security reports; enforces the [Code of Conduct](CODE_OF_CONDUCT.md). |
| **Contributor** | anyone who opens a PR | Follows [CONTRIBUTING.md](CONTRIBUTING.md); adds tests for behaviour they add or change; responds to review. Contributors hold no merge rights. |
| **Reporter** | anyone | Files bugs and feature requests as issues; reports vulnerabilities privately per [SECURITY.md](SECURITY.md). |

There is currently exactly one person in the Maintainer role.

## How decisions are made

- **Ordinary changes** — a PR into `dev`, reviewed and merged by the
  maintainer. Required CI checks must pass; see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Scope** — whether a feature belongs in ccu-mcp at all is the maintainer's
  call, guided by [ROADMAP.md](ROADMAP.md). Ask in an issue before writing a
  large feature; a rejected 800-line PR wastes your time, not just review time.
- **Releases** — the maintainer alone. See
  [docs/release-runbook.md](docs/release-runbook.md).
- **Disputes** — raise them in the issue or PR thread. The maintainer responds
  with a decision and a reason. There is no appeal body; there is a fork
  button.

## Continuity — a known gap

The badge criterion here asks whether the project could keep going, within a
week, if any one person became unavailable. For ccu-mcp today the honest answer
is **no**.

One person holds every credential that matters: the GitHub account, the npm
publish rights, the MCP registry namespace, the Smithery listing, and the
commit- and tag-signing key. Nobody else can merge a PR, cut a release, or
publish a fix. The bus factor is 1.

What partially mitigates it:

- Everything needed to *build* the project is public and reproducible — the
  full history is on GitHub, every release is a signed tag, and the build is
  `npm ci && npm run build` with no private inputs.
- The MIT licence lets anyone fork and publish a continuation under a new name
  without asking.

What that does *not* cover: users who installed `ccu-mcp` from npm would not
receive a fix, because the name would stay unmaintained.

Closing this properly means a second person with publish rights, or documented
credential recovery someone else can actually execute. It is tracked on the
[roadmap](ROADMAP.md) rather than quietly overstated here — a continuity plan
that exists only on paper is worse than a known gap, because it stops anyone
from asking again.

## Changing this document

By PR, like anything else. In practice the maintainer decides; the value of it
being a PR is that the change is visible and dated.
