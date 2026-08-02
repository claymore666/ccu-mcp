# Architecture

High-level design of ccu-mcp: the major components, how a request flows through
them, and the decisions that shaped them. For *why* the security-relevant ones
are the way they are, see [assurance-case.md](assurance-case.md).

## What it is

One Node.js process that speaks **MCP** to a client (Claude, Cursor, …) on one
side and **CCU JSON-RPC** to a HomeMatic CCU on the other. It holds no database
and owns no state that matters: everything authoritative lives on the CCU. The
only things written to disk are two caches, both reconstructible by deleting
them.

```
┌──────────────┐   MCP over stdio    ┌───────────────────────────┐  JSON-RPC   ┌─────────┐
│  MCP client  │◄───────────────────►│                           │   (HTTPS)   │         │
│ (Claude, …)  │   or Streamable     │         ccu-mcp           │◄───────────►│   CCU   │
└──────────────┘   HTTP + bearer     │                           │ /api/       │         │
                                     └───────────────────────────┘ homematic.cgi└─────────┘
                                                   │
                                            ┌──────┴──────┐
                                            │  CACHE_DIR  │
                                            │ session 0600│
                                            │ device types│
                                            └─────────────┘
```

## Layers

Roughly outside-in. Each layer only knows about the one below it.

### 1. Entry point — `src/index.ts`

Parses flags, loads config, builds the shared singletons, and selects a
transport:

- **stdio** (`--stdio`) — one `StdioServerTransport`, one `McpServer`, one
  client. The common case: the MCP client spawns the process.
- **HTTP** (`--http`, the default) — a Node HTTP or HTTPS listener wrapping
  `StreamableHTTPServerTransport`. **One `McpServer` and one transport per MCP
  session**, tracked in a bounded map keyed by session ID.

The per-session server is the important structural choice. A stateless
transport survives a single request, and a *shared* one would let concurrent
clients see each other's active CCU target and each other's protected-target
unlocks. Session state that is per-client is therefore held per-server, not in
a module global.

Also lives here: CORS (default-deny, an allowlisted origin is reflected
exactly, never `*`), DNS-rebinding protection, bearer-token auth, the health
endpoint, idle-session reaping, and signal/stdin-EOF shutdown.

### 2. MCP surface — `src/server.ts`, `src/tools/**`, `src/resources/**`, `src/prompts/**`

`createMcpServer(deps)` registers everything the client can see:

- **28 tools**, grouped by intent across `tools/discovery.ts` (find things),
  `read.ts` (read state), `control.ts` (change state), `diagnostics.ts`,
  `targets.ts` (multi-CCU) and `meta.ts` (the in-server `help`).
- **Resources** — `ccu://…` URIs for the list endpoints, device types and
  system info, with `resources/subscribe` support.
- **Prompts** — a handful of canned workflows (`check-windows`, `room-status`,
  `set-heating`, `good-night`, `diagnostics`, `device-info`).

Every tool input is a **zod** schema. That is the allowlist: shapes, enums and
ranges are declared, and anything else is rejected before a handler runs.

`ServerDeps` exposes `session`, `resolver` and `deviceTypeCache` as **getters**
that resolve to the session's *active* target. A `use_ccu` switch is therefore
picked up by the next tool call without any tool needing to know that targets
exist.

### 3. Middleware — `src/middleware/**`

The path every tool call takes:

| Component | Responsibility |
| --- | --- |
| `tool-handler.ts` | `runTool()` — the uniform wrapper: structured log line per call, duration, and crash containment so a handler throwing never kills the transport. |
| `rate-limiter.ts` | Token bucket with a bounded queue. Protects the CCU, which is a small embedded box, from an enthusiastic LLM. |
| `retry.ts` | Retries only `TIMEOUT` and `UNREACHABLE`, and never for non-idempotent methods (`Program.execute`, `ReGa.runScript`). Each retry re-acquires a rate-limit token, so a timeout storm cannot double the real request rate. |
| `resolver.ts` | Turns human-facing arguments (device name, channel, parameter) into CCU addresses, using the device-type cache. |
| `error-mapper.ts` | Collapses everything that can go wrong into eight categories — `AUTH`, `CCU_ERROR`, `INTERNAL`, `INVALID_INPUT`, `NOT_FOUND`, `TIMEOUT`, `TLS_ERROR`, `UNREACHABLE` — each carrying a `hint` telling the model what to do next. |

The `hint` is deliberate: the consumer is a language model, and a structured
error it can act on is worth more than a stack trace it will paraphrase.

### 4. CCU layer — `src/ccu/**`

- **`session.ts`** — login, session-ID renewal on a timer, re-login on
  expiry, logout. Exactly one renewal timer survives a relogin. The session ID
  is persisted `0600` under `CACHE_DIR` so a restart does not force a new login
  (and, on a CCU, does not burn a session slot).
- **`client.ts`** — the HTTP layer, on undici. Owns TLS policy, most specific
  first: pinned SHA-256 leaf fingerprint → supplied CA/self-signed PEM →
  system trust store → unverified with a loud warning. Fingerprint pinning
  disables TLS session resumption, because a resumed handshake returns an empty
  peer certificate and the pin would silently pass.
- **`target-registry.ts`** — multiple named CCUs in one process. Each target
  owns its own session, resolver and device-type cache, with collision-free
  cache filenames. `TargetSelection` is the per-MCP-session pointer at the
  active target plus its unlocks; `assertWritable()` is the write gate.

### 5. Support — `src/config.ts`, `src/logger.ts`, `src/cache/**`, `src/auth/**`

- **`config.ts`** — the only place `process.env` is read. Rejects malformed
  values rather than coercing them: `CCU_PROD_PROTECTED=yes` throws instead of
  quietly meaning "unprotected". A boolean that fails *open* is a security bug,
  not a typo.
- **`logger.ts`** — one JSON object per line to stderr (stdout belongs to the
  stdio transport), with redaction of credentials, tokens and session IDs.
- **`cache/device-type-cache.ts`** — paramset descriptions per device type, so
  the resolver need not re-ask the CCU for structure that never changes.
- **`auth/token.ts`** — bearer tokens for the HTTP transport, compared as
  SHA-256 digests through `timingSafeEqual`, with rotation via a previous
  token and a grace window.

## Request flow

A `set_value` call, end to end:

```
client → transport → auth (HTTP only) → runTool()
       → zod validation of arguments
       → resolveTarget()  — which CCU?
       → assertWritable() — readonly? protected? confirm:true?
       → resolver         — name/channel/parameter → CCU address
       → rate limiter     — acquire a token
       → withRetry()      — not retried: this one is a write
       → session.call()   — JSON-RPC over undici, session ID attached
       → post-write verification read
       → error-mapper on any failure → category + hint
       → structured log line
```

## Write safety

Writes reach real hardware — locks, heating, sockets — so they are gated
independently of anything the model decides:

- `CCU_<PROFILE>_READONLY` refuses every write on that target outright.
- `CCU_<PROFILE>_PROTECTED` requires `confirm: true`, which then unlocks writes
  for the rest of that MCP session…
- …except `run_script` and `delete_system_variable`, which require `confirm`
  on **every** call and never unlock the session. Arbitrary ReGa execution and
  irreversible deletion are not things a single earlier confirmation should
  license.
- Unlocks live in `TargetSelection`, per MCP session, so one HTTP client cannot
  unlock a protected CCU for another.

## Build and test

- `tsc` to `dist/`, ESM, Node ≥ 24, plus a `build-info.json` stamp recording
  the commit the build came from (surfaced by `get_system_info`).
- Four test layers: type check (`npm run lint` — oxlint plus `tsc` over both
  `src` and `test`), unit, e2e against a mocked CCU, and live integration gated
  on `CCU_HOST`. Coverage is enforced globally *and* per directory by
  `scripts/coverage-ratchet.mjs`, because a global average hides a directory
  collapsing to zero.
- Nightly coverage-guided fuzzing over the parsing and escaping helpers.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to run all of it.
