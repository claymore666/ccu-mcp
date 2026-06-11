# Code Review Report — Round 5 (Full, Unrestricted)

**Project**: debmatic-mcp — HomeMatic CCU bridge for Model Context Protocol
**Language**: TypeScript (Node.js, ES2022, strict mode)
**Date**: 2026-06-11
**Scope**: Everything — all 24 source files (2,981 LoC), all 21 test files (2,428 LoC), Dockerfile, docker-compose.yml, CI workflow, package.json, tsconfig, ignore files, README. Branch `1.1` @ `0f1af82`.
**Build**: ✅ `tsc` 6.0.2 clean · **Tests**: ✅ vitest 4.1.2, 149 passed, 14 skipped · **npm audit**: ✅ 0 vulnerabilities

---

## Executive Summary

The production source is in strong shape after four review rounds — this full pass found **no critical issues and nothing wrong in `src/` above Info level**. The significant findings are all in the project's *scaffolding*: the test suite is excluded from type checking and currently hides **31 latent type errors** (every `CcuConfig` fixture is missing the new `tlsVerify` field — proof the gap bites in practice); the CI workflow only triggers on `main`, so the entire `1.1` branch has never run in CI; and the HTTP request handler isn't exception-guarded, so any rejection escaping the SDK would kill the process. All three are cheap to fix. Verdict: **source is production-ready; fix the test type-checking and CI trigger before merging 1.1.**

---

## Tooling Results

| Tool | Version | Findings | Notes |
|------|---------|----------|-------|
| `tsc --noEmit` (src) | 6.0.2 | 0 errors | strict mode |
| `tsc --noEmit` (src + test) | 6.0.2 | **31 errors** | run with a temporary config; tests are normally excluded (→ W-1) |
| `vitest run` | 4.1.2 | 0 failures | 149 passed, 14 skipped (integration, needs live CCU) |
| `npm audit` | 10.x | 0 vulnerabilities | |
| MCP SDK source inspection | 1.28.0 | no issue | verified `sendResourceListChanged()` on stateless HTTP silently drops when no SSE stream — poller cannot crash the server |
| eslint | — | not configured | carried over |
| `@vitest/coverage-v8` | — | not installed | coverage unavailable |

---

## Findings

### 🔴 Critical

None.

### 🟡 Warning

#### W-1: Tests are excluded from type checking — 31 latent type errors today — `tsconfig.json:19`

`"exclude": [..., "test"]` means `npm run lint` (and CI) never type-checks the 2,428 lines of test code; vitest strips types without verifying them. This is not theoretical: adding `tlsVerify` to `CcuConfig` in v1.0.1 broke **every** config fixture in `test/unit/ccu-client.test.ts` (10 sites), `test/integration/ccu-client.test.ts`, and `test/unit/server-registration.test.ts` (2 sites) — 31 errors total, found by nobody, including two review rounds. Misspelled assertion targets, wrong mock shapes, and dead test parameters are invisible the same way.

**Fix:** add a `tsconfig.test.json` and a CI step:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": "." },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```
```json
"lint": "tsc --noEmit && tsc -p tsconfig.test.json"
```
Then fix the 31 errors (mechanical: add `tlsVerify: false` to the fixtures).

#### W-2: CI never runs on feature branches — `.github/workflows/ci.yml:4-7`

`on.push.branches: [main]` means the `1.1` branch — two commits, 256 insertions — has never executed in CI; it only gets checked if a PR to `main` is opened. Direct pushes to release branches are silently unverified.

**Fix:** `branches: ["**"]` for push (or at least add `1.1`), and consider adding `npm audit --audit-level=high` as a CI step so dependency regressions (like the 8 vulns that appeared between rounds 2 and 3) surface automatically.

#### W-3: HTTP request handler is not exception-guarded — `src/index.ts:66-88`

The `createServer(async (req, res) => { ... })` callback awaits `httpTransport.handleRequest(req, res)` with no try/catch. If that promise ever rejects (a malformed request hitting an unhandled path in the SDK's hono adapter, a future SDK regression), Node's default unhandled-rejection behavior **terminates the process** — one bad request kills the server for all clients. The SDK is probably robust, but the guard costs five lines:

```ts
const httpServer = createServer(async (req, res) => {
  try {
    // ...existing handler body...
  } catch (err) {
    logger.error("http_handler_error", { error: (err as Error).message });
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
});
```

---

### 🔵 Info

**Source (`src/`):**
- **I-1**: `tryRestoreSession` checks host/port but not **user** (`src/ccu/session.ts:118`) — changing `CCU_USER` between runs can resume the previous user's session until it expires. Add `data.user === this.config.user` to the guard.
- **I-2**: `REDACTED_KEYS` lacks `authToken` and `value` of token-bearing shapes (`src/logger.ts:10`) — nothing logs those keys *today*, but the redaction set is one refactor away from leaking. Also, `redact()` recurses without a cycle guard; a self-referential object in a log call would stack-overflow.
- **I-3**: Bearer comparison is case-sensitive on the scheme (`src/index.ts:76`) — RFC 7235 makes `bearer xyz` valid; clients sending lowercase get 401.
- **I-4**: `shutdown()` never calls `httpServer.close()` (`src/index.ts:109-119`) — in-flight HTTP requests are cut by `process.exit` rather than drained. The 10 s force-exit makes this mostly cosmetic.
- **I-5**: `parseValue` converts the literal strings `"true"`/`"false"` to booleans (`src/utils.ts:36-37`) — correct for BOOL datapoints, lossy for a STRING datapoint/sysvar that genuinely holds the text "true". Unfixable without type context; worth a code comment.
- **I-6**: `run_script` returns CCU output uncapped (`src/tools/meta.ts:200`) — a script that prints megabytes produces a megabyte MCP message. Consider truncating at ~1 MB with a notice.
- **I-7**: `list_devices` with a misspelled room/function returns `[]` with no hint (`src/tools/discovery.ts:77-79`) — an LLM can't distinguish "empty room" from "no such room". A `hint` listing valid room names would fit the project's error style.
- **I-8**: `CcuClient` error for non-JSON responses omits the HTTP status (`src/ccu/client.ts:61`) — carried from round 4; include `httpResponse.status` to make reverse-proxy 502s diagnosable.

**Packaging / deployment:**
- **I-9**: `package.json` has no `engines` field — README demands Node 22+, but `npx debmatic-mcp` on Node 18 fails at runtime instead of install time. Add `"engines": { "node": ">=22" }`.
- **I-10**: docker-compose binds `3000:3000` on all interfaces and carries the placeholder `CCU_PASSWORD=secret` inline — suggest `127.0.0.1:3000:3000` as the documented default and `env_file: .env` so real credentials never land in the compose file.
- **I-11**: Docker base image `node:22-alpine` is tag-pinned but not digest-pinned — rebuilds can silently change the base.
- **I-12**: `.gitignore` has a stale `!jest.config.js` exception (project uses vitest) and a global `*.js` ignore that would silently hide any future hand-written JS file.
- **I-13**: `test/fixtures/` is an empty committed directory — delete or populate.
- **I-14**: Carried over: no eslint config; no coverage reporter; issue **#16** (verify `escapeHmScript`'s `\#` escape on real CCU) still open.

---

## What Was Examined and Found Sound

- **Concurrency**: all three single-flight guards (login, device-list refresh, per-type query) set their promise synchronously and clean up in `finally`; the warm-pool index increments with no intervening await; the rate limiter's queue/timer lifecycle is correct including `destroy()` draining waiters at shutdown.
- **Notification path**: verified in SDK source that the poller's `sendResourceListChanged()` is a silent no-op on stateless HTTP with no SSE stream — no crash path.
- **HM Script generation**: both templates evaluated; emitted `Replace` escaping is correct, backslash-before-quote, on every user-controlled field.
- **Security posture**: secrets 0600, hashed timing-safe bearer comparison, HM Script injection escaping on input and output, key redaction in logs, non-root Docker user, no secrets in tracked files (`git ls-files` grep clean).
- **Docker**: multi-stage, `--omit=dev`, HEALTHCHECK with `--start-period`, exec-form CMD, comprehensive `.dockerignore`.
- **Prompts/resources/help**: consistent, accurate against the actual 18 tools; help text matches real schemas.

## Metrics Summary

| Category | Critical | Warning | Info |
|----------|----------|---------|------|
| Testing & CI | — | 2 (W-1, W-2) | 2 (I-13, I-14) |
| Error Handling & Robustness | — | 1 (W-3) | 3 (I-4, I-7, I-8) |
| Security | — | — | 3 (I-1, I-2, I-3) |
| Correctness | — | — | 2 (I-5, I-6) |
| Packaging & Deployment | — | — | 3 (I-9, I-10, I-11) |
| Project Hygiene | — | — | 1 (I-12) |
| **Total** | **0** | **3** | **14** |

## What's Done Well

- **The production source survived a fifth, unrestricted pass with zero findings above Info** — for ~3,000 lines touching network I/O, sessions, caching, concurrency, and code generation for a remote interpreter, that is genuinely uncommon.
- **Defense in depth is consistent**: every external input is escaped, every secret is redacted/0600'd, every CCU call is rate-limited and (where idempotent) retried, and every error reaches the LLM with an actionable hint.
- **The test suite tests failure modes**, not just happy paths — and at 2,428 lines it's nearly the size of the source.

## Top Recommendations

1. **W-1 — type-check the tests**: add `tsconfig.test.json`, extend the lint script, fix the 31 mechanical errors. ~30 min, prevents the whole class permanently.
2. **W-2 — CI on all branches + `npm audit` step**: 2-line workflow change. ~5 min.
3. **W-3 — guard the HTTP handler**: 5 lines. ~10 min.
4. Fold the small Infos (I-1, I-3, I-8, I-9) into the 1.1 release — each is a one-to-three-line change.
