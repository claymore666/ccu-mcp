# Changelog

All notable changes to ccu-mcp are documented here. Each release is a tag
`vX.Y.Z` on `main`.

## v1.9.0 — unreleased

A correctness release. A sustained review pass over the whole source tree found
two classes of problem worth a version of their own: places where a *failed*
CCU write was reported to the client as success, and places where a malformed
environment variable was silently reinterpreted as something else rather than
rejected. Both fail in the same direction — quietly, and in the direction that
looks like everything worked.

### Behavior changes (read before upgrading)

- **Malformed numeric settings now abort startup instead of being partially
  parsed.** The old code used `parseInt`, which stops at the first non-digit and
  keeps what it has: `CCU_TIMEOUT=30s` became a **30 millisecond** timeout, so
  every call failed and the value that caused it looked entirely reasonable in
  the env file. `30.5` truncated to 30, and `1e4` became 1. All of these are now
  rejected by name. Affects ports, timeouts, `CACHE_TTL`, the rate limits and
  `RESOURCE_POLL_INTERVAL`.
- **Boolean settings are trimmed, and anything that isn't a boolean aborts
  startup.** They were previously compared with `=== "true"` against the raw
  value, so `CCU_PROD_PROTECTED=true ` — one trailing space, invisible in an env
  file — evaluated to *false* and silently switched the write-confirmation gate
  off on the protected target. That trailing space now works as intended. The
  other half of the change: `yes`, `1` and `on` used to mean false and now abort
  instead, for the same reason — a value that reads as "on" must never quietly
  disable a protection. Affects `CCU_HTTPS`, `CCU_TLS_VERIFY`,
  `CCU_<NAME>_PROTECTED`, `CCU_<NAME>_READONLY` and `MCP_ALLOW_PLAINTEXT`.

If either of these stops your server starting, the message names the variable
and shows the value it rejected. The README's *Configuration errors* table lists
all of them.

### Fixed

- **`set_system_variable` and `delete_system_variable` no longer report success
  when the CCU says the write failed.** `SysVar.setBool` and `SysVar.setFloat`
  answer `-1` when the ReGa script engine fails, and `SysVar.deleteSysVarByName`
  answers a boolean — both were being discarded, so a variable that was never
  written or never deleted came back as a clean success. They now raise
  `CCU_ERROR` stating explicitly that the value was **not** written. (One
  deliberate limit: a float legitimately set to exactly `-1` is
  indistinguishable from the failure sentinel and is reported as success — the
  value the CCU would have stored either way.)
- **The HTTP error path no longer writes a JSON body into an already-streaming
  response.** An error raised after an SSE stream had started appended a JSON
  object to the event stream, corrupting it for the connected client. It now
  ends the response cleanly when headers are already sent.
- **System-variable creation validates its arguments** instead of accepting
  input the CCU will reject or silently distort: an `enum` with an empty
  `valueList`, a `float` with `min >= max`, and arguments that are meaningless
  for the chosen type (which were being silently ignored, so a typo'd type left
  you with a variable configured nothing like what you asked for).
- **`put_paramset` rejects an empty `set` object** rather than reporting a
  successful write of nothing.
- The `getValueByName` empty-string error now names both of its causes instead
  of only one; a TLS configuration hint pointed at the wrong variable name for
  profile-based setups; and the device-discovery log line counted devices before
  filtering, so it over-reported.

### Added

- **`--version` and `--help` work without a configured CCU.** Both previously
  needed a complete environment, which made them useless for the case you most
  want them in — checking what you have installed while fixing a config.
- **The README documents every configuration error that aborts startup**, with
  the cause and the reason the exit is deliberate rather than tolerant.
- **`server.json` documents 20 environment variables, up from 10.** The missing
  half included every TLS verification setting — `CCU_TLS_VERIFY`,
  `CCU_TLS_FINGERPRINT`, `CCU_CA_CERT` — so a registry-driven install had no way
  to discover that certificate verification was configurable at all. A test now
  fails when a new stdio-relevant variable is added without a manifest entry.

### Internal

- `DeviceTypeCache`'s paramset-fetch loop was duplicated between `warm()` and
  `doQueryAndCache()` and the copies had already drifted; it is now one shared
  method. A swallowed non-array response from `getParamsetDescription` now
  surfaces as an error, and two dead parameters are gone.
- CI: `pull_request` runs on `dev`, closing a gap where a fork PR into `dev` ran
  **no checks at all**; a concurrency group so superseded runs are cancelled; a
  redundant duplicate build removed; and a coverage floor (85% statements/lines,
  79% branches, 87% functions) so the ratchet can't slip backwards.
- The e2e suites no longer skip themselves silently. Every block was guarded on
  `dist/` existing, so running the tests without a build reported a green run
  that had executed none of them; in CI a missing `dist/` is now a hard failure.
  Fixed e2e port slots replace random allocation, which could collide.
- The fail2ban filter test asserted against a hand-mirrored copy of the log line
  rather than the one `src/index.ts` emits, so the two could drift apart without
  failing. It now runs the real server output through the real filter.
- **`put_paramset`'s value stringification was investigated and is correct** — no
  change. The concern was that `put_paramset` sends `String(value)` where
  `set_value` sends values raw, which looked like it could turn `false` into a
  truthy `"false"`. Settled by loading the CCU's compiled XML-RPC extension
  (`tclrpc.so`) in a lab VM and capturing what it actually emits: `"false"`
  encodes to `<boolean>0</boolean>`, and anything that isn't a boolean is
  *rejected* rather than coerced. Since confirmed against the extension's source,
  published in the meantime as `src/tclrpc/tclrpc.cpp` in `OpenCCU/OpenCCU-Base`:
  the `bool` branch converts with `Tcl_GetBoolean` and propagates its error,
  which is exactly the observed behaviour.

### Dependencies

- @types/node 26.1.1 → 26.1.2.

## v1.8.1 — 2026-07-28

Security patch release. Clears all six open dependency advisories — two of them
high severity — and fixes the CI gate that had made them unfixable. No source
changes; no behavior changes.

### Security

- **`fast-uri` (high)** — host confusion via literal backslash authority
  delimiter and via failed IDN canonicalization (GHSA-v2hh-gcrm-f6hx,
  GHSA-4c8g-83qw-93j6). Reached as `@modelcontextprotocol/sdk → ajv → fast-uri`;
  resolved to 3.1.4.
- **`postcss` (high)** — path traversal in source-map auto-loading
  (GHSA-r28c-9q8g-f849). A devDependency (`vitest → vite`), so it never shipped;
  fixed anyway.
- **`@hono/node-server` (moderate)** — path traversal in `serve-static` on
  Windows via encoded backslash (GHSA-frvp-7c67-39w9). This one is on the live
  HTTP code path: the SDK's streamable-HTTP transport imports `getRequestListener`
  from it. Resolved to 2.0.12.
- **`hono` (moderate)** — three advisories covering JSX per-request context
  isolation, `cx()` escaping bypass, and API-Gateway header de-duplication. None
  of those surfaces are used here; resolved to 4.12.32 regardless.
- **`body-parser` (moderate)** — denial of service when an invalid `limit`
  silently disables size enforcement (GHSA-v422-hmwv-36x6). Dormant — reachable
  only through SDK modules this server never imports.
- **The floor for `@modelcontextprotocol/sdk` is now `^1.30.0`** (was `^1.29.0`).
  This is the part of the fix that reaches you: `package-lock.json` is not
  published, so an installed copy resolves from the declared ranges. SDK 1.29.0
  pins `@hono/node-server: ^1.19.9`, a range with no non-vulnerable member — only
  1.30.0 widens it to `^1.19.9 || ^2.0.5`. Raising the floor is what makes the
  patched transport binding rather than incidental.

### Internal

- **CI now separates hermetic from non-hermetic checks.** `npm audit` ran inside
  `build-and-test`, a required status check on both branches, but its verdict
  depends on the GitHub Advisory DB rather than on the commit under test. When
  the two transitive advisories landed, every branch went red at 11s — before
  lint, build, or tests ran — and Dependabot, which bumps one direct dependency
  per PR, could not clear a transitive advisory no matter how many PRs it opened.
  `build-and-test` is now hermetic only. Scanning moved to a daily workflow that
  maintains a single tracking issue, plus a `release-audit` gate on PRs into
  `main` where a human is present to act on it.
- The release runbook no longer claims this repo has no changelog.

### Dependencies

- `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0, `@hono/node-server` 1.19.14 →
  2.0.12, `hono` 4.12.25 → 4.12.32, `fast-uri` 3.1.2 → 3.1.4, `postcss` 8.5.16 →
  8.5.24, `body-parser` 2.2.2 → 2.3.0, plus `type-is`, `nanoid`, and a nested
  `content-type` carried along by the re-resolution.
- `undici` 8.8.0 → 8.9.0 (#104) — a routine Dependabot bump, no advisory.

## v1.8.0 — 2026-07-05

Post-1.7.0 audit-fix release: a fresh multi-agent source review (six dimensions,
every finding adversarially verified) found no real bugs, and its handful of
confirmed low/medium items are fixed here. A final review of the fix commit
itself caught — and this release also fixes — a regression it had introduced.

### Security

- **The auto-generated bearer token is no longer echoed to stderr when it was
  persisted 0600** (CWE-532). stderr (journald / `docker logs` / log shippers)
  is retained longer and readable by more principals than the `0600` `.env`, so
  printing the token there defeated storing it restricted. It is now only echoed
  when persistence FAILED — then stderr is the operator's sole copy. Nothing
  changes for an operator-supplied `MCP_AUTH_TOKEN`.
- The redacting logger now recurses into arrays as well as objects, so a
  secret-named key nested inside an array element can no longer log in cleartext.

### Behavior changes (read before upgrading)

- **`list_devices` now returns `NOT_FOUND` for an unknown `room` or `function`
  filter** instead of an empty device list. A typo'd filter name previously
  looked like a genuinely empty room; it now fails loud with the valid names,
  matching the write tools and the documented contract. If you relied on the
  empty-list response for an unknown filter, handle the error instead.

### Fixed

- Session renewal no longer overlaps itself. It moved from `setInterval` to a
  self-rescheduling `setTimeout` (a slow renew/relogin under a raised
  `CCU_TIMEOUT` can't stack calls against a struggling box), guarded on timer
  handle identity so the relogin path can't leak a second, overlapping renewal
  loop.

### Internal

- Shared `tools/fields.ts` for the `targetField` / `confirmField` schemas (they
  had drifted between copies).
- CI: Dependabot PRs into `dev` now auto-merge once `build-and-test` passes;
  `dev` is branch-protected with that required check.
- New regression tests for every fix above (array redaction, `list_devices`
  `NOT_FOUND`, single-renewal-timer-after-relogin, token-not-echoed-when-saved).

### Dependencies

- undici 8.5.0 → 8.6.0, @types/node 25.9.3 → 26.1.0, vitest / @vitest/coverage-v8
  4.1.8 → 4.1.9, actions/checkout 6 → 7.

## v1.7.0 — 2026-07-04

Execution-safety audit release: seven adversarial review rounds plus two
fresh-context regression rounds over the whole codebase (~100 verified fixes),
validated live against a production debmatic CCU (398/398 tests) and an
OpenCCU QA VM. CCU behavior was verified against the OCCU TCL sources, not
assumptions.

### Behavior changes (read before upgrading)

**Config validation now fails startup loudly** where it used to silently
misbehave. Check your env before upgrading:

- `MCP_TRANSPORT` must be exactly `http` or `stdio` (case-insensitive); a typo
  used to silently select HTTP and hang stdio clients.
- `CCU_TLS_FINGERPRINT` / `CCU_CA_CERT` / `CCU_TLS_VERIFY` on a profile with
  `CCU_HTTPS` unset/false is now a startup error — those settings were
  silently ignored while credentials traveled over plaintext.
- `CCU_DEFAULT_PROFILE` without `CCU_PROFILES` is now a startup error (it was
  silently meaningless).
- Profile names that collide on the same env prefix (`prod-a` / `prod.a` both
  read `CCU_PROD_A_*`) are now rejected.

**HTTP multi-client isolation.** The active target (`use_ccu`) and the
protected-target `confirm:true` unlock are now **per MCP session**. One
client's target switch or confirmation no longer affects any other connected
client — every client session confirms its own writes against a protected
target.

**`/health` responses.** Unauthenticated requests get `200 {"status":"ok"}`
(liveness only). The full `healthy`/`degraded` status with checks requires the
bearer token — the old pre-auth response told unauthenticated scanners whether
the configured CCU admin credentials currently work. The Docker HEALTHCHECK is
unaffected. Update external monitors that keyed on the unauthenticated
`degraded`/503 signal to send the token.

**Stricter write validation** (errors instead of silent corruption):

- Bool system variables are transmitted as numeric 0/1 — the CCU's `setbool`
  string-compares `"false" >= 1` lexicographically and stored **true** for
  `false`. Non-boolean values for bool variables are rejected.
- Enum (LIST) variables accept a 0-based index or one of the enum's labels;
  out-of-range or unknown values are rejected (they used to be stored as
  garbage with a success response). Numeric input is always an index.
- Numeric (NUMBER) variables reject non-numeric values (the CCU stored 0 and
  reported success).
- Enum labels containing `;` (the CCU's value-list separator) are rejected in
  `create_system_variable`; `min`/`max` magnitudes that stringify to exponent
  notation are rejected (ReGa cannot parse them).

**ReGa script failures are errors now.** `get_values`,
`get_service_messages`, `acknowledge_service_messages`,
`set_system_variable` (string), and `create_system_variable` used to treat
the CCU's empty/unparseable script output as an empty **success** —
`get_service_messages` could report "no active alarms" during a script
failure. All now return a structured `CCU_ERROR`. Same for `execute_program`
when the CCU answers `false`, and for any CCU list response that is not an
array.

**Retry semantics.** One-shot ACTION datapoints (`PRESS_SHORT`, `STOP`, …)
are never auto-retried on timeout (a delivered-but-slow request could fire
the trigger twice) — including when the device-type cache cannot prove the
parameter is not an ACTION. MASTER paramset writes always retry. Retry
attempts now also consume rate-limiter tokens.

**MCP protocol.**

- Requests with an unknown/expired `Mcp-Session-Id` get the spec-mandated
  `404 Session not found` (was `400`, which clients treated as fatal and never
  re-initialized after idle eviction or a server restart).
- `resources/subscribe` and `resources/unsubscribe` are implemented (per MCP
  session, unknown URIs rejected); content changes are announced via
  `notifications/resources/updated` to subscribers. The semantically wrong
  `list_changed` broadcast for content changes is gone.
- Request bodies over 4 MB are refused with `413`.
- Sessions with an open SSE stream are not idle-evicted; half-open dead
  streams are detected via TCP keep-alive.

**Auth token lifecycle.** With `MCP_AUTH_TOKEN_TTL_DAYS` set, the
auto-generated token now rotates **at runtime** (it used to rotate only at
startup, so a server whose uptime passed the TTL locked out all clients until
a manual restart). Rotation and recovery honor the grace overlap; the token
`.env` file preserves operator-added lines on rewrite.

**Error categories.** A pinned-certificate mismatch surfaces as a dedicated,
non-retriable `TLS_ERROR` with the mismatch detail (it used to collapse into
a retried, generic `UNREACHABLE: fetch failed`). Network errors include the
underlying cause. A CCU login failure surfaces as `AUTH` with a hint covering
both possible causes (wrong credentials / too many sessions); a
privilege-denied call on a valid session reports the missing privilege level
instead of looping through re-login.

**Miscellaneous.**

- The HTTP MCP endpoint is served on `/` (and `/mcp`) only; unknown paths now
  return 404 instead of answering the full protocol. Point clients at the
  bare server URL as documented.
- A persisted CCU session is only restored when the configured credentials
  still match (session.json carries a salted scrypt credential verifier) —
  after a password
  change the server does a fresh login instead of silently renewing the old
  session forever. Existing session files trigger one fresh login after
  upgrade.
- `set_system_variable` verifies bool/float/enum writes found their target
  (one extra read per write): the CCU's setters report success even for a
  variable deleted moments earlier.
- `get_values` now returns datapoint values as native types (bool/number/
  null/string) like the single `get_value` and `get_paramset` do — previously
  the bulk read handed back the raw quoted strings the HM-script emits
  (`"true"`, `"19.000000"`), so the same datapoint read two ways gave
  different types.
- The CCU-backed resources (`homematic://devices`, `rooms`, …) surface a
  malformed/`null` CCU result as an error like the sibling `list_*` tools,
  instead of serving a subscriber the literal text `"null"`.

- Device-type cache format is v2 (enum `valueList` is now a proper label
  array); the old cache is discarded and re-warmed once after upgrade.
- `list_devices` with both `room` and `function` filters as AND (was OR).
- `put_paramset` resolves parameter types against the paramset being written
  (MASTER params were typed against the VALUES schema).
- All read tools accept the per-call `target` argument; the `help` tool now
  documents `target` and `confirm` accurately.
- stdio mode shuts down gracefully on stdin EOF (logs out the CCU session and
  saves caches; it used to leak the session when the client closed the pipe).
- The default DNS-rebinding host allowlist includes `[::1]:<port>`; the
  README documents that `MCP_ALLOWED_HOSTS` is required for remote clients.
- `parseValue` preserves numeric strings that would lose precision as
  strings; values keep exact round-trips.
- Node.js ≥ 24 (documented; `engines` already required it).

### Added

- `resources/subscribe` / `unsubscribe` with `notifications/resources/updated`
  (all CCU-backed list resources are change-polled, including
  `homematic://interfaces`).
- Runtime auth-token rotation with grace overlap and unwritable-data-dir
  recovery.
- `TLS_ERROR` error category.
- Per-call `target` argument on the remaining read tools
  (`list_rooms`, `list_functions`, `list_interfaces`, `list_programs`,
  `list_system_variables`, `list_links`, `get_rssi`,
  `get_service_messages`, `get_system_info`).

### Fixed

Roughly 100 verified defects across seven audit rounds — highlights beyond
the behavior changes above:

- Writing plain bool system variables was impossible (the CCU reports type
  `LOGIC`; the code matched `BOOL`).
- Privilege-denied calls leaked CCU sessions via doomed re-login+retry loops
  (contributing to "too many sessions").
- Idle-evicted HTTP clients could never reconnect without a server restart.
- A TTL'd auth token caused a permanent 401 lockout once uptime passed the
  TTL.
- Multiple shutdown races (in-flight login resurrecting a session after
  logout, rate-limited calls firing into a closing session, force-exit
  preempting `Session.logout`).
- Docker: the image now contains build info; HEALTHCHECK honors `MCP_PORT`
  and native TLS; the README Docker flow works as written
  (`docker build` step, `MCP_ALLOWED_HOSTS`).
- HM-script JSON emitters escape control characters (a newline in a channel
  name or string datapoint no longer breaks `get_values` /
  `get_service_messages` for the whole result).
- Device-type cache: TTL staleness honored (stale caches re-warm on
  `use_ccu`), concurrent disk writes serialized, enum `valueList` tokenized
  from the CCU's TCL list format.

## v1.6.0 and earlier

See the git tags and GitHub release notes.
