# Contributing to ccu-mcp

Bug reports, feature requests and pull requests are all welcome.

## Getting help, reporting bugs, suggesting features

- **Bugs and feature requests** — open an issue:
  <https://github.com/claymore666/ccu-mcp/issues>. Include the ccu-mcp version
  (`ccu-mcp --version`), your CCU type and firmware (debmatic, OpenCCU, CCU3),
  Node.js version, and the tool call or log line that went wrong.
- **Security vulnerabilities** — do **not** open an issue. Follow
  [SECURITY.md](SECURITY.md).
- **Questions, setup help, and general HomeMatic discussion** — the
  [HomeMatic forum](https://homematic-forum.de/) is the right place, and is
  where most HomeMatic users already are. The maintainer reads it as
  `claymore666`. Please keep bug *reports* on GitHub, where they can be tracked
  against a release.

Please write issues in English or German.

## Test policy

**Any pull request that adds or changes functionality must add or update tests
covering it.** This is not negotiable for major new functionality: a new tool,
a new transport, a new configuration surface, or a change in how an existing
tool behaves all require tests in the same PR.

Bug fixes must include a test that fails before the fix and passes after it. A
fix without such a test is not considered complete, because nothing then stops
the bug returning.

Documentation-only and formatting-only changes are exempt.

CI enforces coverage thresholds (see `vitest.config.ts`), so a change that adds
untested code can fail the build even when every existing test passes.

## Development setup

Requires Node.js >= 24.

```sh
git clone https://github.com/claymore666/ccu-mcp.git
cd ccu-mcp
npm ci
npm run lint     # tsc --noEmit over src AND test
npm test         # builds dist/, then runs vitest
```

Run **both** before opening a PR. `npm run lint` type-checks the test files,
which `npm test` does not — skipping it is the usual cause of a red build that
was green locally.

Always use `npm test` rather than a bare `npx vitest`: the `pretest` hook
rebuilds `dist/`, and the end-to-end suite runs the built server. Without the
rebuild those tests silently exercise a stale build.

### Testing against a real CCU

The unit and e2e suites run against a mocked CCU and need no hardware. The
live-integration suites in `test/integration/` are gated on `CCU_HOST` and are
skipped unless you set it:

```sh
CCU_HOST=your-ccu CCU_PORT=443 CCU_HTTPS=true \
CCU_USER=Admin CCU_PASSWORD=... npm test
```

These round-trip against real hardware and clean up after themselves. Never
point them at a CCU you are not willing to have written to.

## Branching and pull requests

Two long-lived branches. Older releases exist as tags, not branches.

- **`dev`** is the default branch and the integration branch. **Branch off
  `dev` and target `dev` with your PR.**
- **`main`** holds released code and is protected. PRs into `main` are release
  PRs made by the maintainer.

Name work branches by what they do: `feature/…`, `fix/…`, `ci/…`, `docs/…`,
`tests/…`.

Keep a PR to one concern. A small, reviewable PR that does one thing gets
merged; a large one that does five things waits.

### Commit messages

Use a `type: summary` subject — `feat:`, `fix:`, `docs:`, `test:`, `ci:`,
`refactor:`, `chore:`. Explain *why* in the body when the reason isn't obvious
from the diff.

**Do not include AI-assistant attribution** in commit messages, commit author
or committer identity, or PR descriptions — no `Co-Authored-By` lines naming an
assistant, no "Generated with …" trailers. CI enforces this and the PR will
fail. Using an assistant to help write the code is fine; the commit history
just records you as the author.

## Code style

- TypeScript, `strict` mode. `npm run lint` must be clean — warnings are not
  acceptable in merged code.
- Match the style of the file you're editing.
- Comments should explain *why*, not restate *what*. The existing codebase
  leans on this heavily; a comment recording a decision or a trap is valuable,
  a comment narrating the next line is noise.

## Adding or changing a tool

Tool documentation is guarded by tests, so all of these must move together or
the build fails:

1. Register the tool in the relevant `src/tools/*.ts`.
2. Add its entry to `TOOL_HELP` and the guide in `src/tools/meta.ts` — this is
   what the in-server `help` tool serves.
3. Add it to the `## Tools` section of `README.md`, and update the tool count
   in that section.
4. Add tests.

`test/unit/docs-drift.test.ts` compares the registered tools against the help
text and the README in both directions, so a tool that is added in one place
and forgotten in another is caught at test time rather than by a user.

New environment variables are guarded the same way by
`test/unit/env-example-sync.test.ts`: add them to `.env.example` and to the
configuration table in `README.md`.

## Releases

Releases are made by the maintainer. Contributors never need to bump versions,
edit `CHANGELOG.md` for a release, or tag anything — please leave
`package.json`'s version alone in your PR.
