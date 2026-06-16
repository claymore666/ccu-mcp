# debmatic-mcp

Talk to your HomeMatic smart home from Claude, Cursor, or any MCP client.

<a href="https://glama.ai/mcp/servers/claymore666/debmatic-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/claymore666/debmatic-mcp/badge" alt="debmatic-mcp MCP server" />
</a>

debmatic-mcp connects to the CCU's built-in JSON-RPC API and exposes your devices, rooms, programs, and system variables as MCP tools. No addons, no XML-API, no cloud — just a direct connection to the CCU on your local network.

Built for [debmatic](https://github.com/alexreinert/debmatic) (HomeMatic on Debian) but works with any CCU3 or RaspberryMatic installation that exposes the standard `/api/homematic.cgi` endpoint.

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

- A running HomeMatic CCU (debmatic, CCU3, or RaspberryMatic) reachable on your network
- The CCU's admin username and password (the same credentials you use to log into the WebUI)
- Node.js 22+ (for running from source or stdio mode) or Docker

## Quick start

```bash
export CCU_HOST=your-ccu-hostname-or-ip
export CCU_PASSWORD=your-ccu-admin-password
npx debmatic-mcp --stdio
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
    "debmatic": {
      "command": "npx",
      "args": ["debmatic-mcp", "--stdio"],
      "env": {
        "CCU_HOST": "your-ccu-hostname-or-ip",
        "CCU_PASSWORD": "your-ccu-admin-password"
      }
    }
  }
}
```

Replace `your-ccu-hostname-or-ip` with your CCU's hostname (like `homematic-ccu3`) or IP (like `192.168.1.50`), and `your-ccu-admin-password` with the password you use to log into the CCU WebUI.

Restart Claude Code. Run `/mcp` to check it connected. You should see `debmatic` in the list.

Alternatively, use the Claude Code CLI:

```bash
claude mcp add debmatic -- npx debmatic-mcp --stdio
```

### Option B: Docker (standalone HTTP server)

Use this if you want the server running independently — for example on a home server, accessible to multiple clients, or when your MCP client supports HTTP remotes.

**1. Start the container:**

```bash
docker run -d \
  --name debmatic-mcp \
  -e CCU_HOST=your-ccu-hostname-or-ip \
  -e CCU_PASSWORD=your-ccu-admin-password \
  -v debmatic-data:/data \
  -p 3000:3000 \
  debmatic-mcp
```

**2. Get the auth token.** The server generates a random bearer token on first startup and saves it inside the container's data volume. You need this token to authenticate your MCP client. Grab it with:

```bash
docker exec debmatic-mcp grep MCP_AUTH_TOKEN /data/.env
```

This prints something like `MCP_AUTH_TOKEN=e96suzi1iG0H-GPif6K2...`. The part after `=` is your token.

**3. Configure your MCP client.** If your client uses `.mcp.json`, add the HTTP server:

```json
{
  "mcpServers": {
    "debmatic": {
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
TOKEN=$(docker exec debmatic-mcp grep MCP_AUTH_TOKEN /data/.env | cut -d= -f2)
jq --arg t "$TOKEN" '.mcpServers.debmatic.headers.Authorization = "Bearer " + $t' .mcp.json > .mcp.json.tmp && mv .mcp.json.tmp .mcp.json
```

This only updates the `debmatic` entry — other servers in your `.mcp.json` are left alone.

**4. Check it's healthy:**

```bash
curl http://localhost:3000/health
```

#### Browser-based clients (CORS)

By default the HTTP server sends **no** CORS headers, so a random web page can't drive a local instance. To let browser-based MCP clients like [MCP Inspector](https://github.com/modelcontextprotocol/inspector) connect directly, set `MCP_ALLOWED_ORIGINS` to a comma-separated allowlist of trusted origins (e.g. `https://app.example,http://localhost:6274`). A request whose `Origin` is on the list gets that **exact** origin reflected in `Access-Control-Allow-Origin` — never the wildcard `*`, which would let any site drive a local instance that controls real CCU hardware. A request from any other origin gets no CORS headers (the browser blocks it) and is rejected server-side by DNS-rebinding protection. Authentication is always enforced regardless: every MCP request needs the bearer token.

The HTTP transport also has **DNS-rebinding protection** on by default: it rejects requests whose `Host` header isn't `localhost`/`127.0.0.1` on the configured port. If you reach the server under another hostname (reverse proxy, container DNS name), list those hosts in `MCP_ALLOWED_HOSTS` or legitimate requests get a `403`.

**TLS.** The bearer token travels in the request, so anything beyond loopback should be encrypted. You have two options: terminate TLS at a reverse proxy (Caddy/nginx) in front and bind the server to loopback (`MCP_HOST=127.0.0.1`), or let the server serve HTTPS itself by setting `MCP_TLS_CERT` and `MCP_TLS_KEY` to a PEM cert/key pair. Plain HTTP is still fully supported — it stays the zero-config default — but the server logs a warning at startup when it's serving the token over unencrypted HTTP on a non-loopback bind; set `MCP_ALLOW_PLAINTEXT=true` to acknowledge that and silence it.

CORS support was first implemented by [@marcinn2](https://github.com/marcinn2) in his fork [marcinn2/debmatic-mcp](https://github.com/marcinn2/debmatic-mcp) — thanks!

### HTTPS

If your CCU uses HTTPS (self-signed certificates are fine), add these environment variables:

```bash
CCU_HTTPS=true
CCU_PORT=443
```

The server accepts self-signed certificates automatically — certificate verification is **off by default** because CCUs ship with self-signed certs. If your CCU has a proper certificate, enable verification with `CCU_TLS_VERIFY=true`.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CCU_HOST` | required | Hostname or IP of your CCU |
| `CCU_PASSWORD` | required | CCU admin password |
| `CCU_USER` | `Admin` | CCU username |
| `CCU_PORT` | `80` | API port (`443` when using HTTPS) |
| `CCU_HTTPS` | `false` | Connect via HTTPS (self-signed certs supported) |
| `CCU_TLS_VERIFY` | `false` | Verify the CCU's TLS certificate (enable if you have a proper cert) |
| `CCU_TIMEOUT` | `10000` | CCU request timeout in milliseconds |
| `CCU_SCRIPT_TIMEOUT` | `30000` | HM Script execution timeout in milliseconds |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |
| `CACHE_DIR` | `/data` | Where to store device type cache and session |
| `CACHE_TTL` | `86400` | Cache lifetime in seconds (24h) |
| `MCP_TRANSPORT` | `http` | `http` or `stdio` (the `--stdio` CLI flag overrides this) |
| `MCP_PORT` | `3000` | HTTP server port (HTTP mode only) |
| `MCP_AUTH_TOKEN` | auto-generated | Bearer token for HTTP mode; generated and saved to `$CACHE_DIR/.env` on first start |
| `MCP_ALLOWED_ORIGINS` | unset | Comma-separated allowlist of browser origins. Unset = no cross-origin browser access (default-deny). An allowlisted origin is reflected exactly in `Access-Control-Allow-Origin` (never `*`); the list also drives DNS-rebinding origin checks |
| `MCP_ALLOWED_HOSTS` | `localhost`/`127.0.0.1` | Extra `Host` values accepted by DNS-rebinding protection (comma-separated `host:port`); add your hostname when behind a proxy or container DNS name |
| `MCP_HOST` | unset (all interfaces) | Bind address for the HTTP listener; set `127.0.0.1` to restrict to loopback (e.g. behind a TLS-terminating proxy), which also silences the plaintext warning |
| `MCP_TLS_CERT` / `MCP_TLS_KEY` | unset | PEM cert/key paths. Set **both** to serve MCP over HTTPS natively; leave unset for plain HTTP. Setting only one is a configuration error |
| `MCP_ALLOW_PLAINTEXT` | `false` | Set `true` to acknowledge serving the bearer token over plain HTTP and silence the non-loopback plaintext warning |
| `CCU_RATE_LIMIT_BURST` | `20` | Max burst of requests sent to the CCU |
| `CCU_RATE_LIMIT_RATE` | `10` | Sustained CCU requests per second |
| `RESOURCE_POLL_INTERVAL` | `60` | Seconds between polls for MCP resource change notifications |

## Tools

25 tools organized by what you'd actually want to do:

**Find things** — `list_devices`, `list_rooms`, `list_functions`, `list_interfaces`, `list_programs`, `list_system_variables`, `list_links`, `describe_device_type`

**Read state** — `get_value`, `get_values` (bulk), `get_paramset`

**Change things** — `set_value`, `put_paramset`, `set_system_variable`, `create_system_variable`, `delete_system_variable`, `assign_channel`, `unassign_channel`, `execute_program`

**Check health** — `get_service_messages`, `acknowledge_service_messages`, `get_rssi`, `get_system_info`

**Other** — `help` (context-aware), `run_script` (raw HomeMatic Script for bulk operations, renaming devices/channels, querying room membership, or anything not covered by the other tools)

Most tools auto-resolve the interface and value types from the device address — you don't need to know whether a device is on BidCos-RF or HmIP-RF.

## Resources and prompts

Besides tools, the server exposes MCP **resources** — browsable JSON snapshots your client can attach as context:

`homematic://devices`, `homematic://rooms`, `homematic://functions`, `homematic://programs`, `homematic://sysvars`, `homematic://interfaces`, `homematic://device-types`, `homematic://system`

The server polls the CCU in the background (every `RESOURCE_POLL_INTERVAL` seconds) and notifies connected clients when the device list changes.

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

## Related projects

- [debmatic](https://github.com/alexreinert/debmatic) — Run HomeMatic on Debian, Ubuntu, Raspberry Pi OS, Armbian
- [OCCU](https://github.com/eq-3/occu) — Open CCU SDK by eQ-3 (the upstream HomeMatic software)
- [RaspberryMatic](https://github.com/jens-maus/RaspberryMatic) — HomeMatic on Raspberry Pi
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol specification

## License

MIT
