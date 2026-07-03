# Changelog

All notable changes to ccu-mcp are documented here. Each release is a tag
`vX.Y.Z` on `main`.

## v1.7.0 — Unreleased

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
  still match (session.json carries a credential hash) — after a password
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
