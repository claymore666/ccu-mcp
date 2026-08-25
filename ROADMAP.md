# Roadmap

What ccu-mcp intends to do, and deliberately not do, over roughly the next
year. Plans are not promises: this is a spare-time project with one maintainer,
and the point of writing it down is so you can judge whether it is heading
somewhere useful to you — not to commit to dates.

Last reviewed: 2026-08-19 (v1.10.0).

## Direction

ccu-mcp is a **read-mostly bridge between an MCP client and a HomeMatic CCU on
your LAN**. It is finished in the sense that matters: the tool surface covers
devices, rooms, functions, programs, system variables, links and service
messages, and it works against debmatic, CCU3 and OpenCCU. Effort now goes into
making it safer and more predictable rather than larger.

## Planned

### Security posture

- **Verify the CCU's TLS certificate by default.** Today `CCU_TLS_VERIFY`
  defaults to `false`, so an HTTPS connection to a CCU is encrypted but
  unauthenticated unless you pin a fingerprint or supply a CA. A startup
  warning says so, which is not the same as being safe by default. Changing the
  default breaks every stock self-signed CCU, so it needs a major version, a
  migration note, and a clear error that names the fix. Until then this is a
  documented gap, not a hidden one — see
  [docs/assurance-case.md](docs/assurance-case.md).
- **Give OpenSSF Scorecard a real Branch-Protection reading.** Scorecard now
  runs weekly ([#153](https://github.com/claymore666/ccu-mcp/issues/153)) on
  the workflow's own `GITHUB_TOKEN`, which cannot read classic branch
  protection — so that one check scores on thin evidence while the rest of the
  report is accurate. Two ways to close it: a fine-grained PAT with
  `Administration: Read-only` as secret `SCORECARD_TOKEN`, which is a
  long-lived credential plus a yearly rotation when it expires; or move
  `main`'s protection to rulesets, which non-admin tokens can read and which
  would need its six required checks and the deliberate `enforce_admins: false`
  bypass rebuilt as bypass actors.

Delivered in v1.10.0, kept here because the reasoning is still the record:
CodeQL moved off GitHub's default setup into a workflow file, so the query
suite is pinned in the commit and reviewable in a PR
([#156](https://github.com/claymore666/ccu-mcp/issues/156)); and the fuzzing
corpus now carries between nightly runs
([#155](https://github.com/claymore666/ccu-mcp/issues/155)) — an empty corpus
found nothing in 60s where a seeded one found planted defects in under 20, so
discarding it each night wasted most of the value of running the fuzzer.

### Configuration experience

- **Guided setup instead of hand-edited `.env`.** Configuring profiles today
  means writing `CCU_PROD_TLS_FINGERPRINT`-style variables by hand and finding
  out at runtime whether the credentials work or the user has enough
  privileges. The plan, in order:
  1. `ccu-mcp init` / `ccu-mcp doctor` — an interactive CLI wizard that probes
     the host, pins the TLS fingerprint, tests the login, reports the detected
     privilege level (USER vs ADMIN), writes a valid `.env`, and emits
     ready-to-paste client config snippets. Works over SSH, adds no attack
     surface.
  2. **LLM-guided setup on the same core.** Register the server with an empty
     config (it already starts without one) and let a `setup` tool walk the
     conversation through the same probe/pin/validate steps. One deliberate
     exception: the password never travels through the model or the chat
     transcript — the setup tool hands off to `ccu-mcp secret <profile>`, a
     one-line local prompt that writes just the secret. MCP elicitation could
     replace the chat round-trips where clients support it, but the spec
     forbids eliciting secrets, so the CLI hand-off stays either way.
  3. Maybe later, `ccu-mcp config --ui` — a browser form bound to 127.0.0.1
     with a one-time token, process exits when closed. Only if the above turns
     out not to be enough.

  Non-goal: a persistent web admin panel. A standing HTTP surface that holds
  every CCU password is exactly what this project's security posture says not
  to build. Also a non-goal: controlling devices from it — the CCU WebUI and
  the MCP client already do that.

### Project continuity

- **Reduce the bus factor from 1.** Either a second maintainer with publish
  rights, or credential recovery that another person can actually execute. See
  [GOVERNANCE.md](GOVERNANCE.md#continuity--a-known-gap). This is the single
  largest risk to anyone depending on the package.

### Maintenance

- Track the MCP specification and SDK as they move. The server implements
  revision `2025-11-25` (negotiating down to `2024-11-05`), which is what the
  TypeScript SDK currently tops out at; revision `2026-07-28` — per-request
  protocol version, `server/discover` — lands here when the SDK supports it.
- Keep working against current debmatic / OpenCCU / CCU3 firmware.
- Keep dependencies current and advisories clear.

## Not planned

Saying no is most of what keeps this maintainable.

- **No cloud, no HomeMatic Cloud / Mediola / third-party bridges.** Direct
  JSON-RPC to a CCU on your network, nothing else.
- **No addon or XML-API dependency.** The built-in `/api/homematic.cgi`
  endpoint is the only interface used, and that stays true.
- **No web UI or dashboard.** The MCP client is the interface. (The
  run-and-exit localhost config form under Configuration experience is not
  this: no standing server, no device control.)
- **No multi-user model or per-user permissions.** The server holds one
  credential per configured CCU and acts as that user. Authorisation belongs to
  the CCU.
- **No exposure to the public internet as a supported deployment.** The design
  target is a trusted LAN; see the out-of-scope list in
  [SECURITY.md](SECURITY.md#threat-model).
- **No automation engine.** ccu-mcp reads and writes values and runs programs
  that already exist on the CCU. Scheduling and rules stay on the CCU, where
  they keep working when this server is not running.
- **No support for non-HomeMatic protocols** (Zigbee, Z-Wave, KNX). Other MCP
  servers exist for those, and one process bridging all of them would be worse
  at each.

## How to influence this

Open an issue. Concrete use cases move things far more than feature names, and
"here is what I was trying to do and where it fell down" is the most useful
report there is. For general HomeMatic discussion the
[HomeMatic forum](https://homematic-forum.de/) is a better venue than the
tracker.
