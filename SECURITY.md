# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems, and please do not
post them to the [HomeMatic forum](https://homematic-forum.de/).** Both are
public, and a CCU controls physical devices — locks, heating, sockets — so an
unfixed report there is an invitation.

Report privately through GitHub Security Advisories:

**https://github.com/claymore666/ccu-mcp/security/advisories/new**

Private vulnerability reporting is enabled on this repository, so the report
stays visible only to you and the maintainer until a fix is published.

If you cannot use that form, email <christian.kamien@gmail.com> with `ccu-mcp
security` in the subject.

### What to expect

ccu-mcp is maintained by one person, so please read these as honest targets
rather than an SLA:

| Stage | Target |
| --- | --- |
| Acknowledgement that the report arrived | within 14 days |
| Initial assessment — accepted, needs more information, or out of scope | within 30 days |
| Fix released for an accepted report | as fast as severity warrants; you'll get a date once the assessment is done |

Reports are credited in the advisory and in [CHANGELOG.md](CHANGELOG.md) unless
you ask otherwise.

## Supported versions

Fixes land in the current release line. There are no long-lived maintenance
branches — older versions exist as tags only.

| Version | Supported |
| --- | --- |
| 1.9.x | Yes |
| < 1.9 | No — upgrade to the latest release |

ccu-mcp requires Node.js >= 24, and inherits that runtime's own security
support window.

## Security requirements

What you can and cannot expect from ccu-mcp. The reasoning and the evidence
behind each of these is in [docs/assurance-case.md](docs/assurance-case.md).

**You can expect that:**

1. Credentials, bearer tokens and CCU session IDs are not written to logs, tool
   output, error messages, or the on-disk cache in recoverable form. The
   session cache is written `0600`.
2. On the HTTP transport, every request is authenticated before it is routed.
   Cross-origin browser access is denied unless you allowlist an origin, and
   DNS-rebinding protection is always on.
3. A CCU marked `READONLY` refuses every write, and one marked `PROTECTED`
   refuses writes without `confirm: true` — with `run_script` and
   `delete_system_variable` requiring it on every single call.
4. Values from the CCU and arguments from the model cannot alter program
   structure: HM Script is escaped, and caller-supplied keys cannot reach
   `Object.prototype`.
5. Configuration that gates safety fails closed. A malformed
   `CCU_<PROFILE>_PROTECTED` is a startup error, never a silently unprotected
   CCU.
6. Releases are signed, published with build provenance, and reproducible from
   the tagged source.

**You cannot expect that:**

1. **The CCU's TLS certificate is verified by default.** `CCU_TLS_VERIFY`
   defaults to `false`, because nearly every CCU ships a self-signed
   certificate. The connection is encrypted but not authenticated unless you
   pin it with `CCU_TLS_FINGERPRINT` or supply `CCU_CA_CERT`. A warning is
   logged at startup. **Pin the fingerprint.** Changing this default is on the
   [roadmap](ROADMAP.md) for a major version.
2. ccu-mcp adds any authorisation layer above the CCU's own. It acts as the
   configured CCU user; anything that user may do, a client of this server may
   do.
3. The confirmation gate resists a *determined* operator or a model that has
   been instructed to confirm. It is a guard against accident and confusion,
   not an authorisation system.
4. It is safe to expose on the public internet. It is designed for a trusted
   LAN.
5. **The HTTP transport speaks OAuth.** The MCP specification makes
   authorization optional ("Implementations using an HTTP-based transport
   **SHOULD** conform"), and describes an OAuth 2.1 flow with RFC 9728
   protected-resource metadata and an authorization server. ccu-mcp
   deliberately does not implement it: a LAN appliance bridging to one CCU
   credential has no authorization server to point at, and one would add a
   moving part without adding a decision — there is a single principal, and it
   is the CCU user in the config. What it does implement is the token half —
   `Authorization: Bearer` on every request, timing-safe comparison, rotation
   with an overlap window, optional expiry, and an RFC 6750 `WWW-Authenticate`
   challenge on 401. If you need per-user authorization in front of the
   server, put a reverse proxy that does OAuth in front of it. This is a
   considered deviation, not an oversight.
6. It has had an external security review. It has not.

## Threat model

ccu-mcp holds credentials for a CCU, and a CCU controls physical devices —
locks, heating, sockets. A compromise of this server is a compromise of the
smart home behind it. Design accordingly.

**In scope** — please report:

- Authentication bypass on the HTTP transport (`MCP_AUTH_TOKEN` handling,
  token rotation via `MCP_AUTH_TOKEN_PREVIOUS` / `MCP_AUTH_TOKEN_GRACE_HOURS`).
- Defeating TLS verification against the CCU (`CCU_TLS_VERIFY`,
  `CCU_TLS_FINGERPRINT` pinning, `CCU_CA_CERT`).
- DNS-rebinding or origin-confusion attacks that get past `MCP_ALLOWED_HOSTS`
  or `MCP_ALLOWED_ORIGINS`.
- Leaking credentials, session IDs, or tokens into logs, error messages, tool
  output, or the persisted session cache.
- Bypassing the write-confirmation guard (`CCU_<PROFILE>_PROTECTED` /
  `confirm: true`) so a write reaches a protected CCU without confirmation.
- Command or script injection through tool parameters — particularly anything
  reaching `run_script` / ReGa.
- Path traversal or unsafe file handling in the device-type cache or session
  cache.

**Out of scope:**

- Vulnerabilities in the CCU firmware itself (debmatic, OpenCCU, CCU3) —
  report those upstream.
- Deliberately exposing this server to the public internet, or running it over
  plain HTTP on a routable address. It is designed for a trusted LAN, and
  choosing to drop transport security is a deployment decision, not a defect.
- Anyone with the CCU password being able to control the CCU. That is what the
  credential is for.
- Missing hardening on the host running the server (file permissions outside
  what ccu-mcp creates, container escape from a misconfigured runtime).
- Dependency advisories with no exploitable path through this code. These are
  already tracked daily by `.github/workflows/audit.yml` and gated on release;
  a report is still welcome if you can show reachability.

## Notes for operators

- Keep `MCP_TRANSPORT=http` behind TLS (`MCP_TLS_CERT` / `MCP_TLS_KEY`), behind
  a TLS-terminating proxy, or bound to loopback with `MCP_HOST=127.0.0.1`.
  Serving plain HTTP on a non-loopback address logs a startup warning; note
  that `MCP_ALLOW_PLAINTEXT=true` only silences that warning — it does not add
  any protection, and the bearer token still travels in the clear.
- Pin the CCU certificate with `CCU_TLS_FINGERPRINT` where you can. It is the
  strongest available protection given most CCUs use a self-signed certificate.
- The persisted session cache is written `0600` because the session ID it holds
  grants full CCU access. Do not relax that, and do not place the cache on a
  shared filesystem.
- Give the CCU a dedicated user for ccu-mcp rather than reusing `Admin`, and
  give it USER level unless you actually need script execution — `run_script`
  and everything built on ReGa require ADMIN.
