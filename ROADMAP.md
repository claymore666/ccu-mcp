# Roadmap

What ccu-mcp intends to do, and deliberately not do, over roughly the next
year. Plans are not promises: this is a spare-time project with one maintainer,
and the point of writing it down is so you can judge whether it is heading
somewhere useful to you — not to commit to dates.

Last reviewed: 2026-08-02 (v1.9.1).

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
- **OpenSSF Scorecard** in CI ([#153](https://github.com/claymore666/ccu-mcp/issues/153)).
- **CodeQL advanced setup** so the query suite is pinned in the commit rather
  than tracking GitHub's default ([#156](https://github.com/claymore666/ccu-mcp/issues/156)).
- **Persist the fuzzing corpus between nightly runs**
  ([#155](https://github.com/claymore666/ccu-mcp/issues/155)). The corpus is
  load-bearing — an empty one found nothing in 60s where a seeded one found
  planted defects in under 20 — so throwing it away each night wastes most of
  the value of running the fuzzer at all.

### Project continuity

- **Reduce the bus factor from 1.** Either a second maintainer with publish
  rights, or credential recovery that another person can actually execute. See
  [GOVERNANCE.md](GOVERNANCE.md#continuity--a-known-gap). This is the single
  largest risk to anyone depending on the package.

### Maintenance

- Track the MCP specification and SDK as they move.
- Keep working against current debmatic / OpenCCU / CCU3 firmware.
- Keep dependencies current and advisories clear.

## Not planned

Saying no is most of what keeps this maintainable.

- **No cloud, no HomeMatic Cloud / Mediola / third-party bridges.** Direct
  JSON-RPC to a CCU on your network, nothing else.
- **No addon or XML-API dependency.** The built-in `/api/homematic.cgi`
  endpoint is the only interface used, and that stays true.
- **No web UI or dashboard.** The MCP client is the interface.
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
