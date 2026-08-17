# Assurance case

An argument, with evidence, that ccu-mcp meets the security requirements stated
in [SECURITY.md](../SECURITY.md#security-requirements) — and an honest account
of where it does not.

The structure follows the OpenSSF Best Practices silver criterion
`assurance_case`: threat model, trust boundaries, secure design principles, and
common implementation weaknesses countered.

**Top-level claim.** An attacker on the LAN who cannot already authenticate to
the CCU cannot use ccu-mcp to read or change CCU state; and an MCP client that
*can* reach ccu-mcp cannot escalate beyond what the configured CCU credential
already permits, nor write to a protected target without an explicit
confirmation.

This claim is bounded by two assumptions, both stated up front because the
argument is worthless without them:

1. **The LAN is trusted-ish, and the deployment is not internet-facing.** See
   the out-of-scope list in [SECURITY.md](../SECURITY.md#threat-model).
2. **Whoever holds the CCU credential controls the CCU.** ccu-mcp does not add
   an authorisation layer on top of the CCU's own, and does not claim to.

## Assets

| Asset | Why it matters |
| --- | --- |
| CCU username + password | Full control of the smart home. Long-lived. |
| CCU session ID | Equivalent to the credential until it expires. |
| `MCP_AUTH_TOKEN` | Grants a client the use of all of the above. |
| Physical device state | Locks, heating, sockets. The actual thing being protected. |
| Cached device topology | Low sensitivity alone; a map of the home in aggregate. |

## Trust boundaries

Four, crossed in this order:

```
     [ untrusted ]                [ semi-trusted ]           [ trusted ]

  network ──①──► MCP transport ──②──► tool layer ──③──► CCU client ──④──► CCU
                (auth, CORS,        (zod schemas,      (TLS policy,
                 rebinding)          write gates)       session)
```

**① Network → transport.** The widest boundary and the only one an
unauthenticated party can touch.
- *stdio*: there is no network boundary. The client spawned the process and
  already has the privileges of the user running it.
- *HTTP*: bearer token required on every request (`src/auth/token.ts`); CORS is
  **default-deny** and an allowlisted origin is reflected exactly, never `*`;
  DNS-rebinding protection is on unconditionally and checks the `Host` header
  against an allowlist. The health endpoint answers liveness only before auth,
  so it cannot be used to probe CCU state.

**② Transport → tool layer.** Everything arriving here is attacker-influenced,
because the MCP client is a language model and its arguments may be derived
from device names, room names, or anything else an attacker could have written
into the CCU.
- Every tool input is a **zod** schema — a declared allowlist of shape, type,
  enum and range. Unparseable input is rejected before a handler runs.
- Write gates (`assertWritable`) apply here, before any CCU call.

**③ Tool layer → CCU client.** Resolved addresses and values.
- HM Script fragments are escaped (`escapeHmScript`) rather than concatenated
  raw.
- Rate limiting and retry policy apply, protecting the CCU from the client.

**④ CCU client → CCU.** The credential and session ID cross here.
- TLS policy is chosen most-specific-first: pinned SHA-256 leaf fingerprint →
  supplied CA PEM → system trust store → unverified with a warning.

## Security requirements → argument → evidence

### R1. Credentials never leave the process except to the CCU

*Argument.* Credentials are read once from the environment, held in memory, and
sent only to the configured CCU host over the configured transport. Every other
outbound path — logs, tool output, error messages, the persisted cache — is
either redacted or stores a derived value.

*Evidence.*
- `src/logger.ts` redacts credential, token and session-ID fields; the redaction
  is asserted on the emitted log line, not on the redaction function's return
  value — a distinction that mattered, because an earlier fix to the function
  alone left the merge site still leaking (v1.9.1).
- The session cache stores the session ID, not the password, and is written
  `0600`.
- The credential *fingerprint* used to detect a credential change is derived
  with **scrypt** and a random salt (`src/ccu/session.ts`), not a fast hash —
  so the cache file does not enable an offline guess at the password.
- `src/config.ts` deliberately does not interpolate the `CCU_CA_CERT` path into
  its error message.

*Residual.* An operator who sets `LOG_LEVEL=debug` and shares logs is outside
what the code can control.

### R2. An unauthenticated network party cannot reach CCU functionality

*Argument.* On the HTTP transport every request is authenticated before
routing; browser-origin and Host-header checks close the cross-origin and
rebinding paths that would otherwise let a web page in the user's browser drive
the server.

*Evidence.* `src/auth/token.ts` (SHA-256 digests compared with
`timingSafeEqual`, fixed width so a length mismatch cannot throw or leak);
`enableDnsRebindingProtection: true` unconditionally in `src/index.ts`;
`MCP_ALLOWED_ORIGINS` unset means no cross-origin browser access at all;
`WWW-Authenticate` sent on 401. Regression tests cover each.

*Residual.* Plain HTTP on a routable address exposes the bearer token in
transit. The server logs a startup warning; `MCP_ALLOW_PLAINTEXT=true` silences
the warning and adds no protection. This is a deployment choice, deliberately
left possible for loopback and container-network use.

### R3. Writes to a protected CCU require explicit confirmation

*Argument.* Write authority is decided before the CCU is contacted, from
configuration the model cannot influence, and confirmation state is scoped to a
single MCP session.

*Evidence.* `assertWritable()` in `src/ccu/target-registry.ts`: `readonly`
refuses unconditionally; `protected` requires `confirm: true`; `run_script` and
`delete_system_variable` pass `alwaysConfirm` and so require it on **every**
call and never unlock the session. Unlocks live in `TargetSelection`, one per
`McpServer`, so in HTTP mode one client cannot de-gate another.

*Residual.* A model that is *told* to pass `confirm: true` will pass it. The
gate defends against accident and against a confused model, not against a user
who instructs the model to proceed. That is the intended semantics: it is a
confirmation, not an authorisation system.

### R4. CCU-supplied and model-supplied data cannot alter program structure

*Argument.* The two places where data becomes code or keys are HM Script
generation and object indexing; both are handled explicitly.

*Evidence.*
- `escapeHmScript()` escapes backslashes first, then quotes and newlines —
  order matters, and the property test asserts round-trip equality against an
  independent unescape oracle plus odd-backslash quote parity
  (`test/unit/utils-properties.test.ts`).
- Prototype-key handling: caller-supplied keys are written with
  `Object.fromEntries` (which uses `CreateDataProperty`) rather than `obj[k] =
  v` or `Object.assign` (which use `[[Set]]` and route `__proto__` through
  `Object.prototype`'s setter), and reads are guarded with `Object.hasOwn`.
  Fixed across `logger`, `utils`, `device-type-cache` and `resolver` in v1.9.1;
  regression tests in `test/unit/prototype-key-handling.test.ts`.
- Cache filenames are derived by slug **plus a SHA-256 hash** of the canonical
  target name (`fileSuffix`), so a name containing `../` cannot traverse and
  two names cannot collide.

### R5. The server degrades safely rather than failing open

*Argument.* Every configuration value that gates behaviour fails closed, and
failures are contained.

*Evidence.* `parseBoolEnv` throws on anything that is not exactly `true`/`false`
— `CCU_PROD_PROTECTED=yes` is a startup error, not a silently unprotected
production CCU (issue #120, the concrete failure this replaced). `runTool()`
contains handler crashes so the transport survives. Retries apply only to
`TIMEOUT`/`UNREACHABLE` and never to non-idempotent methods, so a retry cannot
double-execute a program.

## Secure design principles (Saltzer & Schroeder)

| Principle | How it is applied |
| --- | --- |
| **Fail-safe defaults** | CORS default-deny; DNS-rebinding protection always on; `readonly`/`protected` fail closed on a malformed value; HTTP transport requires a token. **Exception: CCU TLS verification — see below.** |
| **Economy of mechanism** | One process, no database, no plugin system, no user model. The tool surface is fixed at build time. |
| **Complete mediation** | Every tool call goes through `runTool()` → zod → `assertWritable()` → rate limiter. There is no path to `session.call()` that skips them. |
| **Least privilege** | Documented recommendation to give ccu-mcp its own CCU user at USER level; ADMIN is needed only for ReGa. The container runs as a non-root user. |
| **Separation of privilege** | Writing to a protected target needs both configuration (the target is writable) and a per-call/per-session confirmation. |
| **Open design** | MIT, full history public, no security by obscurity. This document is part of that. |
| **Psychological acceptability** | Errors carry an actionable `hint`; the safety gates explain what to pass and why, rather than refusing opaquely. |

### The known violation of fail-safe defaults

`CCU_TLS_VERIFY` defaults to **false**. An HTTPS connection to a CCU is
therefore encrypted but **not authenticated** unless the operator pins a
fingerprint or supplies a CA. A startup warning is logged, naming the three
ways to fix it.

The reason is that essentially every CCU ships a self-signed certificate, and a
verify-by-default that refuses to connect to a stock box would push users to
disable TLS entirely — a worse outcome. That is an explanation, not a
justification: it is a real gap, it is why the corresponding badge criterion is
answered **Unmet** rather than argued around, and correcting it is on the
[roadmap](../ROADMAP.md) for a major version where the migration can be
handled properly.

Until then, **pin the fingerprint with `CCU_TLS_FINGERPRINT`.** It is the
strongest option available against a self-signed peer, and it is what the
maintainer's own deployment uses.

## Common implementation weaknesses countered

Against the classes that actually apply to this program:

| Weakness | Status |
| --- | --- |
| **Injection** (CWE-77/78/94) | No shell execution, no `eval`; `no-eval` is enforced by the lint gate. HM Script is escaped, and the escaping is property-tested and fuzzed. |
| **Prototype pollution** (CWE-1321) | Countered as described in R4; four sites fixed and regression-tested in v1.9.1. |
| **Broken authentication** (CWE-287/307) | Constant-time token comparison; rotation with a grace window; rate limiting bounds guessing. |
| **Sensitive data exposure** (CWE-200/532) | Log redaction asserted end-to-end; `0600` session cache; scrypt-derived credential fingerprint. |
| **Improper certificate validation** (CWE-295) | Pinning and CA paths implemented and tested, including the session-resumption trap that made an earlier pin silently pass. Default-off is the documented gap above. |
| **ReDoS** (CWE-1333) | Bearer-token parsing was rewritten to a linear pattern after a polynomial one was found; the regexes are property-tested and fuzzed. |
| **Path traversal** (CWE-22) | Cache filenames are slug + hash of a canonical name; no caller-supplied path segment reaches the filesystem. |
| **Uncontrolled resource consumption** (CWE-400) | Bounded session map, bounded rate-limiter queue, idle-session reaping, retry budget that re-acquires tokens. |
| **Vulnerable dependencies** (CWE-1104) | Three production dependencies. Dependabot, a daily `npm audit` of production deps, and a release gate that blocks a release PR on any high/critical advisory. |
| **Memory safety** (CWE-119 family) | Not applicable: TypeScript on Node, no native code, no FFI. |

## How this argument is kept honest

The weak point of any assurance case is that it is written once and then
diverges from the code. Countermeasures:

- Every claim above names the file or test that backs it, so a reviewer can
  check rather than trust.
- The gates are **mutation-tested** — deliberately broken to confirm they go
  red — because a guard that has never failed is indistinguishable from
  decoration. This applies to the coverage ratchet, the AI-attribution check,
  the actionlint gate and the new lint gate.
- Coverage is enforced per directory as well as globally, so deleting a
  directory's tests cannot hide inside a healthy average.
- Nightly fuzzing runs against a seeded corpus; the seeds are load-bearing, and
  the runner treats a missing corpus as a hard failure rather than a clean run.
  Inputs discovered by a run accumulate in a cache alongside those seeds, never
  inside them, so what each night starts from is still a reviewed set.
- CodeQL analyses both the source and the workflows on every PR and weekly, with
  its configuration in `.github/workflows/codeql.yml` rather than in repository
  settings — so what is scanned, and with which query suite, is reviewable in a
  diff instead of visible only to whoever holds admin.

Where the argument is weakest: it is written and reviewed by one person, and no
external security review has been performed. Independent review is welcome —
see [SECURITY.md](../SECURITY.md).
