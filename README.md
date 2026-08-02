# ccu-mcp

Talk to your HomeMatic smart home from Claude, Cursor, or any MCP client.

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13919/badge)](https://www.bestpractices.dev/projects/13919)

<a href="https://glama.ai/mcp/servers/claymore666/ccu-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/claymore666/ccu-mcp/badge" alt="ccu-mcp MCP server" />
</a>

ccu-mcp connects to the CCU's built-in JSON-RPC API and exposes your devices, rooms, programs, and system variables as MCP tools. No addons, no XML-API, no cloud — just a direct connection to the CCU on your local network.

Works with any HomeMatic CCU: [debmatic](https://github.com/alexreinert/debmatic) (HomeMatic on Debian), a CCU3, or [OpenCCU](https://github.com/OpenCCU/OpenCCU) (formerly RaspberryMatic) — anything that exposes the standard `/api/homematic.cgi` endpoint.

## What can it do?

Ask your AI assistant things like:

- "What's the temperature in the bathroom?"
- "Are any windows open?"
- "Set the living room heating to 21 degrees"
- "Show me all devices with low battery"
- "What's the gas meter reading?"
- "Which devices have low battery or haven't been seen in a long time?"
- "Find all channels whose names don't match their device name"
- "Rename all devices to follow a consistent naming convention with floor labels (UG/OG/EG)"
- "Which room is the window sensor in?"

The MCP server handles device discovery, type resolution, session management, and value conversion — the AI just calls the tools.

## Prerequisites

- A running HomeMatic CCU (debmatic, CCU3, or OpenCCU — formerly RaspberryMatic) reachable on your network
- The CCU's admin username and password (the same credentials you use to log into the WebUI)
- Node.js 24+ (for running from source or stdio mode) or Docker

## Quick start

```bash
export CCU_HOST=your-ccu-hostname-or-ip
export CCU_PASSWORD=your-ccu-admin-password
npx ccu-mcp --stdio
```

If it prints `server_ready` to stderr, it's working. Press Ctrl+C to stop. Now set it up in your MCP client — see below.

## Installation

There are two ways to run this: **stdio** (the server runs as a subprocess of your MCP client) or **HTTP** (the server runs standalone in Docker and clients connect over the network). Pick one.

### Option A: stdio (direct, simplest)

This is the easiest setup. Your MCP client (Claude Code, Cursor, etc.) starts the server as a child process — no Docker, no network config, no auth tokens.

For Claude Code, create a `.mcp.json` file in your project directory (or any directory where you'll use Claude Code):

```json
{
  "mcpServers": {
    "ccu-mcp": {
      "command": "npx",
      "args": ["ccu-mcp", "--stdio"],
      "env": {
        "CCU_HOST": "your-ccu-hostname-or-ip",
        "CCU_PASSWORD": "your-ccu-admin-password"
      }
    }
  }
}
```

Replace `your-ccu-hostname-or-ip` with your CCU's hostname (like `homematic-ccu3`) or IP (like `192.168.1.50`), and `your-ccu-admin-password` with the password you use to log into the CCU WebUI.

Restart Claude Code. Run `/mcp` to check it connected. You should see `ccu-mcp` in the list.

Alternatively, use the Claude Code CLI:

```bash
claude mcp add ccu-mcp -- npx ccu-mcp --stdio
```

### Option B: Docker (standalone HTTP server)

Use this if you want the server running independently — for example on a home server, accessible to multiple clients, or when your MCP client supports HTTP remotes.

**1. Start the container:**

```bash
git clone https://github.com/claymore666/ccu-mcp.git && cd ccu-mcp
docker build -t ccu-mcp .
docker run -d \
  --name ccu-mcp \
  -e CCU_HOST=your-ccu-hostname-or-ip \
  -e CCU_PASSWORD=your-ccu-admin-password \
  -e MCP_ALLOWED_HOSTS=your-server-ip:3000 \
  -v ccu-data:/data \
  -p 3000:3000 \
  ccu-mcp
```

> **`MCP_ALLOWED_HOSTS` is required for remote clients.** The server's
> DNS-rebinding protection rejects any request whose `Host` header isn't on
> the allowlist — by default only `localhost`/`127.0.0.1`/`[::1]` on the MCP
> port. Set it to every name/IP clients will use to reach the server
> (comma-separated, `host:port`). Without it, the local health check works
> but every remote MCP request gets **403 Invalid Host header**.

**2. Get the auth token.** The server generates a random bearer token on first startup and saves it inside the container's data volume. You need this token to authenticate your MCP client. Grab it with:

```bash
docker exec ccu-mcp grep MCP_AUTH_TOKEN /data/.env
```

This prints something like `MCP_AUTH_TOKEN=e96suzi1iG0H-GPif6K2...`. The part after `=` is your token.

**3. Configure your MCP client.** If your client uses `.mcp.json`, add the HTTP server:

```json
{
  "mcpServers": {
    "ccu-mcp": {
      "url": "http://your-server-ip:3000",
      "headers": {
        "Authorization": "Bearer PASTE-YOUR-TOKEN-HERE"
      }
    }
  }
}
```

To inject the token automatically (requires `jq`):

```bash
TOKEN=$(docker exec ccu-mcp grep MCP_AUTH_TOKEN /data/.env | cut -d= -f2)
jq --arg t "$TOKEN" '.mcpServers["ccu-mcp"].headers.Authorization = "Bearer " + $t' .mcp.json > .mcp.json.tmp && mv .mcp.json.tmp .mcp.json
```

This only updates the `ccu-mcp` entry — other servers in your `.mcp.json` are left alone.

**4. Check it's healthy:**

```bash
curl http://localhost:3000/health
```

#### Browser-based clients (CORS)

By default the HTTP server sends **no** CORS headers, so a random web page can't drive a local instance. To let browser-based MCP clients like [MCP Inspector](https://github.com/modelcontextprotocol/inspector) connect directly, set `MCP_ALLOWED_ORIGINS` to a comma-separated allowlist of trusted origins (e.g. `https://app.example,http://localhost:6274`). A request whose `Origin` is on the list gets that **exact** origin reflected in `Access-Control-Allow-Origin` — never the wildcard `*`, which would let any site drive a local instance that controls real CCU hardware. A request from any other origin gets no CORS headers (the browser blocks it) and is rejected server-side by DNS-rebinding protection. Authentication is always enforced regardless: every MCP request needs the bearer token.

The HTTP transport also has **DNS-rebinding protection** on by default: it rejects requests whose `Host` header isn't `localhost`/`127.0.0.1`/`[::1]` on the configured port. If you reach the server under another hostname or IP (reverse proxy, container DNS name, the server's LAN address), list those hosts in `MCP_ALLOWED_HOSTS` or legitimate requests get a `403`.

**TLS.** The bearer token travels in the request, so anything beyond loopback should be encrypted. You have two options: terminate TLS at a reverse proxy (Caddy/nginx) in front and bind the server to loopback (`MCP_HOST=127.0.0.1`), or let the server serve HTTPS itself by setting `MCP_TLS_CERT` and `MCP_TLS_KEY` to a PEM cert/key pair. Plain HTTP is still fully supported — it stays the zero-config default — but the server logs a warning at startup when it's serving the token over unencrypted HTTP on a non-loopback bind; set `MCP_ALLOW_PLAINTEXT=true` to acknowledge that and silence it.

**Token rotation & expiry.** By default the bearer token lives forever. Two optional, composable controls let you rotate it without dropping clients:

- *Auto-generated token* — set `MCP_AUTH_TOKEN_TTL_DAYS` (fractional days allowed) to give the generated token a lifetime. The server rotates it **automatically at runtime** shortly before it lapses (no restart needed; also on startup if it expired while the server was down), prints the new token on stderr, and keeps the just-replaced token validating for `MCP_AUTH_TOKEN_GRACE_HOURS` (default 24) so in-flight clients survive the swap. To force a rotation sooner, delete `$CACHE_DIR/.env` (or just its `MCP_AUTH_TOKEN` line) and restart.
- *Explicit token* — when you set `MCP_AUTH_TOKEN` yourself, you own its lifetime (TTL doesn't apply). To rotate, put the new token in `MCP_AUTH_TOKEN`, move the old one to `MCP_AUTH_TOKEN_PREVIOUS`, and restart; both are accepted during the overlap. Drop `MCP_AUTH_TOKEN_PREVIOUS` and restart once every client is on the new token. Comparison stays timing-safe across every currently-valid token.

**Brute-force protection (fail2ban).** The auto-generated token is 256 bits of randomness, so guessing it is infeasible. If you set `MCP_AUTH_TOKEN` yourself, **make it long and random** (e.g. `openssl rand -base64 32`) — a short or guessable token is the one case brute force matters. The server does **not** rate-limit or lock out failed logins in-process; that job belongs to a firewall-level tool like [fail2ban](https://www.fail2ban.org/), which bans the source IP before the request ever reaches the server. To make that easy, every rejected request logs a structured line to stderr:

```json
{"ts":"2026-06-18T17:28:00.370Z","level":"warn","msg":"auth_failed","client":"203.0.113.7","hadToken":true}
```

Ready-to-use fail2ban config ships in [`fail2ban/`](fail2ban/): copy `filter.d/ccu-mcp.conf` to `/etc/fail2ban/filter.d/` and the jail in `jail.d/ccu-mcp.local` to `/etc/fail2ban/jail.d/` (it defaults to 5 failures in 10 minutes → 1-hour ban). The server logs to stderr, so point fail2ban at wherever you collect it — the journal (`backend = systemd`) when run as a unit, or a file when you redirect stderr/`docker logs`; both are spelled out in the jail file. Requires `LOG_LEVEL=warn` or lower (`info`, the default, is fine; `error` suppresses the line). Behind a reverse proxy the logged IP is the proxy's, so run fail2ban against the proxy's access log instead.

CORS support was first implemented by [@marcinn2](https://github.com/marcinn2) in his fork [marcinn2/debmatic-mcp](https://github.com/marcinn2/debmatic-mcp) — thanks!

### HTTPS

If your CCU uses HTTPS (self-signed certificates are fine), add these environment variables:

```bash
CCU_HTTPS=true
CCU_PORT=443
```

The server accepts self-signed certificates automatically — certificate verification is **off by default** because CCUs ship with self-signed certs (the server logs a warning when running unverified). To actually verify the connection and close the MITM gap, you have three options:

- **Pin the fingerprint** (simplest for a self-signed appliance cert): set `CCU_TLS_FINGERPRINT` to the cert's SHA-256 (hex, with or without colons). The connection is rejected unless the CCU presents exactly that certificate. Read it with:
  ```bash
  echo | openssl s_client -connect "$CCU_HOST:443" 2>/dev/null | openssl x509 -noout -fingerprint -sha256
  ```
- **Trust a CA/self-signed PEM**: point `CCU_CA_CERT` at the certificate file for standard chain validation.
- **System trust store**: if your CCU has a publicly-trusted certificate, set `CCU_TLS_VERIFY=true`.

`CCU_TLS_FINGERPRINT` takes precedence over `CCU_CA_CERT`, which takes precedence over `CCU_TLS_VERIFY`.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CCU_HOST` | required | Hostname or IP of your CCU |
| `CCU_PASSWORD` | required | CCU admin password |
| `CCU_USER` | `Admin` | CCU username |
| `CCU_PORT` | `80` | API port (`443` when using HTTPS) |
| `CCU_HTTPS` | `false` | Connect via HTTPS (self-signed certs supported) |
| `CCU_TLS_VERIFY` | `false` | Verify the CCU's TLS certificate against the system trust store (for a publicly-trusted cert) |
| `CCU_TLS_FINGERPRINT` | unset | Pin the CCU's self-signed leaf cert by its SHA-256 fingerprint (hex, colons optional). Takes precedence over the other TLS options |
| `CCU_CA_CERT` | unset | Path to the CCU's CA/self-signed PEM for chain validation |
| `CCU_TIMEOUT` | `10000` | CCU request timeout in milliseconds |
| `CCU_SCRIPT_TIMEOUT` | `30000` | HM Script execution timeout in milliseconds |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |
| `CACHE_DIR` | `/data` | Where to store device type cache and session |
| `CACHE_TTL` | `86400` | Cache lifetime in seconds (24h) |
| `MCP_TRANSPORT` | `http` | `http` or `stdio` (the `--stdio` CLI flag overrides this) |
| `MCP_PORT` | `3000` | HTTP server port (HTTP mode only) |
| `MCP_AUTH_TOKEN` | auto-generated | Bearer token for HTTP mode; generated and saved to `$CACHE_DIR/.env` on first start |
| `MCP_AUTH_TOKEN_PREVIOUS` | unset | Previous bearer token, accepted alongside `MCP_AUTH_TOKEN` during a rotation overlap; remove it (and restart) to end the overlap. Explicit-token path only |
| `MCP_AUTH_TOKEN_TTL_DAYS` | unset (never expires) | Lifetime of the **auto-generated** token, in days (fractional allowed). The server auto-rotates it at runtime shortly before expiry (new token announced on stderr); ignored when `MCP_AUTH_TOKEN` is set |
| `MCP_AUTH_TOKEN_GRACE_HOURS` | `24` | Overlap (hours) after an auto-rotation during which the just-replaced token is still accepted |
| `MCP_ALLOWED_ORIGINS` | unset | Comma-separated allowlist of browser origins. Unset = no cross-origin browser access (default-deny). An allowlisted origin is reflected exactly in `Access-Control-Allow-Origin` (never `*`); the list also drives DNS-rebinding origin checks |
| `MCP_ALLOWED_HOSTS` | `localhost`/`127.0.0.1`/`[::1]` on the MCP port | Extra `Host` values accepted by DNS-rebinding protection (comma-separated `host:port`); add every name/IP clients use to reach the server (proxy, container DNS name, plain server IP) |
| `MCP_HOST` | unset (all interfaces) | Bind address for the HTTP listener; set `127.0.0.1` to restrict to loopback (e.g. behind a TLS-terminating proxy), which also silences the plaintext warning |
| `MCP_TLS_CERT` / `MCP_TLS_KEY` | unset | PEM cert/key paths. Set **both** to serve MCP over HTTPS natively; leave unset for plain HTTP. Setting only one is a configuration error |
| `MCP_ALLOW_PLAINTEXT` | `false` | Set `true` to acknowledge serving the bearer token over plain HTTP and silence the non-loopback plaintext warning |
| `CCU_RATE_LIMIT_BURST` | `20` | Max burst of requests sent to the CCU |
| `CCU_RATE_LIMIT_RATE` | `10` | Sustained CCU requests per second |
| `RESOURCE_POLL_INTERVAL` | `60` | Seconds between polls for MCP resource change notifications |

To drive **several CCUs** from one server, these flat `CCU_*` vars are replaced
by named profiles — see [Multiple CCU targets](#multiple-ccu-targets-profiles)
below.

### Command-line flags

```sh
ccu-mcp --stdio        # serve over stdin/stdout (overrides MCP_TRANSPORT)
ccu-mcp --http         # serve over HTTP (default)
ccu-mcp --version      # print the installed version and exit
ccu-mcp --help         # print usage and exit
```

`--version` and `--help` need no configuration — use them to check what an
installed copy actually is, e.g. after updating:

```console
$ npx ccu-mcp@latest --version
1.8.1
```

Note that a bare `npx ccu-mcp` reuses the copy cached in `~/.npm/_npx` without
re-resolving against the registry; pin `@latest` (or clear that cache) when you
want the newest release.

### How to supply these (inline, `.env`, or export)

The required `CCU_HOST` / `CCU_PASSWORD` (and everything else) are **environment
variables**. Provide them in whichever of these you prefer — you need just one:

- **Inline in `.mcp.json`** — the `env` block shown in [Option A](#option-a-stdio-direct-simplest)
  above. Simplest; self-contained.
- **Shell `export`** — as in [Quick start](#quick-start) above.
- **A `.env` file** — keeps secrets out of `.mcp.json`. The server does not read
  `.env` on its own, so load it with Node's built-in flag (Node ≥ 20.6):

  ```json
  {
    "mcpServers": {
      "ccu-mcp": {
        "command": "node",
        "args": ["--env-file=/path/to/.env", "/path/to/ccu-mcp/dist/index.js", "--stdio"]
      }
    }
  }
  ```

  Copy [`.env.example`](.env.example) to `.env` and fill it in (it documents every
  variable). Docker users can pass the same file with `docker run --env-file .env`
  or compose's `env_file:`. Keep `.env` gitignored.

### Multiple CCU targets (profiles)

By default the `CCU_*` vars above configure a single CCU. To reach several CCUs
(e.g. **prod + dev**) from one server, define named profiles instead. Set these
the same way as any other config (inline, `.env`, or export — see above):

```sh
CCU_PROFILES=prod,dev
CCU_DEFAULT_PROFILE=prod           # active at startup (defaults to the first listed)

CCU_PROD_HOST=ccu.example
CCU_PROD_USER=ai
CCU_PROD_PASSWORD=...
CCU_PROD_HTTPS=true
CCU_PROD_PROTECTED=true            # writes need confirm:true

CCU_DEV_HOST=127.0.0.1
CCU_DEV_PORT=18080
CCU_DEV_USER=Admin
CCU_DEV_PASSWORD=                  # may be empty (e.g. an OpenCCU dev box)
```

Each profile takes the same settings as the flat vars, prefixed
`CCU_<NAME>_` (name upper-cased, non-alphanumerics → `_`): `HOST` (required),
`PASSWORD` (may be empty), `USER`, `PORT`, `HTTPS`, `TIMEOUT`, `SCRIPT_TIMEOUT`,
`TLS_FINGERPRINT`, `CA_CERT`, `TLS_VERIFY` — plus two policy flags:

- `CCU_<NAME>_PROTECTED=true` — write tools refuse unless called with
  `confirm: true`, which unlocks writes to that target for the rest of the session.
  Exception: `run_script` and `delete_system_variable` require `confirm: true` on
  **every** call — they never ride on the session unlock (scripts bypass all
  typed-tool guards; deletion is unrecoverable), and confirming them does not
  unlock the session for other writes.
- `CCU_<NAME>_READONLY=true` — write tools are refused outright.

With `CCU_PROFILES` unset, the flat `CCU_*` vars are used as a single `default`
profile (unchanged behavior). At runtime, `list_ccu_targets` shows the targets,
`get_connection_info` reports the active one, and `use_ccu` switches it. Read
tools also accept an optional `target` to read from another CCU for a single call
without switching.

### Configuration errors

Some mistakes stop the server at startup instead of being ignored. Each of these
would otherwise fail *silently* and much later, so the exit is deliberate:

| Message | Cause and why it's fatal |
|---|---|
| `CCU_HOST environment variable is required` | No CCU configured (and no `CCU_PROFILES`). |
| `CCU_PASSWORD environment variable is required` | Unset **or empty**. Note the asymmetry: a *profile* password may be empty (`CCU_<NAME>_PASSWORD=`, e.g. an OpenCCU dev box), the flat one may not. |
| `CCU_DEFAULT_PROFILE is set but CCU_PROFILES is not` | A leftover from a profile setup. Ignoring it would point writes at the flat `CCU_HOST` box while the env file suggests a named target. |
| `CCU_PROFILES is set but lists no profile names` | Empty or comma-only value. |
| `CCU_PROFILES lists "<name>" more than once` | Duplicate profile name. |
| `... both map to the same env prefix CCU_<P>_* — rename one` | Distinct names can collide once sanitised: `prod-a` and `prod.a` both read `CCU_PROD_A_*`, so they would silently be the *same* target. |
| `CCU_DEFAULT_PROFILE="x" is not one of CCU_PROFILES (...)` | Typo in the startup profile. |
| `profile "<name>" is missing CCU_<P>_HOST` | Every profile needs a host; the password may be empty. |
| `TLS_FINGERPRINT/CA_CERT/TLS_VERIFY is set but HTTPS is disabled` | The verification code path only exists over HTTPS. Ignoring these would leave you believing the connection is verified while credentials travel in cleartext. Set `CCU_HTTPS=true` (or `CCU_<NAME>_HTTPS=true`) or remove them. |
| `MCP_TLS_CERT and MCP_TLS_KEY must both be set (or both unset)` | Half a TLS config can't serve HTTPS. |
| `MCP_TRANSPORT must be "http" or "stdio"` | Case matters. A typo like `STDIO` must not silently select HTTP and leave a stdio-spawning client waiting forever. |
| `<VAR> must be a positive integer` | Ports, timeouts, `CACHE_TTL`, rate limits, `RESOURCE_POLL_INTERVAL`. The *whole* value has to be digits — `CCU_TIMEOUT=30s` is rejected rather than read as 30 ms, and `30.5` or `1e4` are rejected rather than truncated. |
| `<VAR> must be a positive number` | The two duration settings, `MCP_AUTH_TOKEN_TTL_DAYS` and `MCP_AUTH_TOKEN_GRACE_HOURS`, where a fractional value is meaningful. |
| `<VAR> must be "true" or "false"` | Any boolean setting (`CCU_HTTPS`, `CCU_TLS_VERIFY`, `CCU_<NAME>_PROTECTED`, `CCU_<NAME>_READONLY`, `MCP_ALLOW_PLAINTEXT`). Surrounding whitespace and capitalisation are fine; `yes`, `1` and `on` are not, because treating them as *false* would quietly switch a protection off. |
| `CCU_CA_CERT could not be read` | Path is wrong or unreadable by the server user. |

`ccu-mcp --version` and `--help` work without any configuration, so they stay
usable while you sort one of these out.

## Tools

28 tools organized by what you'd actually want to do:

**Find things** — `list_devices`, `list_rooms`, `list_functions`, `list_interfaces`, `list_programs`, `list_system_variables`, `list_links`, `describe_device_type`

**Read state** — `get_value`, `get_values` (bulk), `get_paramset`

**Change things** — `set_value`, `put_paramset`, `set_system_variable`, `create_system_variable`, `delete_system_variable`, `assign_channel`, `unassign_channel`, `execute_program`

**Check health** — `get_service_messages`, `acknowledge_service_messages`, `get_rssi`, `get_system_info`

**Switch targets** — `list_ccu_targets`, `get_connection_info`, `use_ccu` (multi-CCU profiles; see above)

**Other** — `help` (context-aware), `run_script` (raw HomeMatic Script for bulk operations, renaming devices/channels, querying room membership, or anything not covered by the other tools)

Most tools auto-resolve the interface and value types from the device address — you don't need to know whether a device is on BidCos-RF or HmIP-RF.

## Resources and prompts

Besides tools, the server exposes MCP **resources** — browsable JSON snapshots your client can attach as context:

`homematic://devices`, `homematic://rooms`, `homematic://functions`, `homematic://programs`, `homematic://sysvars`, `homematic://interfaces`, `homematic://device-types`, `homematic://system`

The server polls the CCU in the background (every `RESOURCE_POLL_INTERVAL` seconds) and sends `notifications/resources/updated` for resources whose content changed — to clients that subscribed to them via `resources/subscribe`.

It also ships MCP **prompts** — ready-made workflows you can invoke from clients that support them (e.g. as slash commands in Claude Code):

- `check-windows` — are any windows or doors open?
- `room-status` — full status report for one room
- `set-heating` — set a room's target temperature
- `good-night` — prepare the house for night
- `diagnostics` — check for device issues
- `device-info` — detailed info about a device's capabilities and parameters

## How it works

The server talks to the CCU's JSON-RPC API (the same one the WebUI uses). On startup it:

1. Logs in and caches the session (reused across restarts)
2. Loads the device type cache from disk (or warms it in the background)
3. Starts the MCP server on stdio or HTTP

Device type schemas are cached locally so the AI can look up valid parameters, types, and value ranges without hitting the CCU every time.

Values come back as native types — `21.5` not `"21.500000"`, `true` not `"true"`.

## Tested devices

This has been tested against a production debmatic installation with:

- HmIP-eTRV-2 / eTRV-2 I9F (radiator thermostats)
- HmIP-STHD (wall thermostats with humidity)
- HmIP-WTH-2 (wall thermostats)
- HmIP-SWDO-I (door/window contacts)
- HmIP-STHO (outdoor temperature/humidity)
- HmIP-ESI (energy/gas meter)
- HmIP-FALMOT-C12 (floor heating controller)
- HmIP-HEATING (virtual heating groups)
- HmIP-WRCC2 (wall remote)
- HM-PB-6-WM55 (BidCos 6-button remote)
- RPI-RF-MOD (radio module)

Other device types should work too — the server queries the CCU for parameter descriptions rather than maintaining a static device database.

## Changelog

Release notes — including **behavior changes to check before upgrading**
(stricter config validation, `/health` response shape, per-session write
confirmation, retry semantics) — live in [CHANGELOG.md](CHANGELOG.md).

## Getting help and contributing

- **Something broken, or an idea for a feature?** Open an issue:
  [github.com/claymore666/ccu-mcp/issues](https://github.com/claymore666/ccu-mcp/issues)
- **Questions, setup help, general HomeMatic talk?** The
  [HomeMatic forum](https://homematic-forum.de/) — the maintainer reads it as
  `claymore666`.
- **Found a security problem?** Please don't post it publicly. See
  [SECURITY.md](SECURITY.md) for private reporting.
- **Want to send a patch?** [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup,
  the branch to target, the coding standard, and the test policy.

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

### Project documentation

| Document | What's in it |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | Where the project is going — and what it will deliberately never do |
| [GOVERNANCE.md](GOVERNANCE.md) | Who decides what, and the known continuity gap |
| [SECURITY.md](SECURITY.md) | Reporting, security requirements, threat model |
| [docs/architecture.md](docs/architecture.md) | High-level design and request flow |
| [docs/assurance-case.md](docs/assurance-case.md) | Why the security requirements hold, with evidence |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |

## Related projects

- [OpenCCU](https://github.com/OpenCCU/OpenCCU) — community-maintained, cloud-free CCU firmware for Raspberry Pi, x86/ARM, and CCU3/ELV-Charly hardware (formerly **RaspberryMatic**; built on the OCCU framework)
- [debmatic](https://github.com/alexreinert/debmatic) — Run HomeMatic on Debian, Ubuntu, Raspberry Pi OS, Armbian
- [OCCU](https://github.com/eq-3/occu) — eQ-3's original Open CCU SDK (the upstream HomeMatic software); now being superseded by the community-maintained [OpenCCU](https://github.com/OpenCCU/OpenCCU)
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol specification
- [ccu-ai-mcp](https://github.com/mdzio/ccu-ai-mcp) by **Mathias (mdzio)** — a
  kindred MCP server for HomeMatic, taking a deliberately different, elegant
  approach (a lean Go core with user-defined HM-Script tools). See his write-up
  on the [HomeMatic forum](https://homematic-forum.de/forum/viewtopic.php?t=88226).

## License

MIT
