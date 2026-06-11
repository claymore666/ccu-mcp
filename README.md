# debmatic-mcp

Talk to your HomeMatic smart home from Claude, Cursor, or any MCP client.

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

## Tools

18 tools organized by what you'd actually want to do:

**Find things** — `list_devices`, `list_rooms`, `list_functions`, `list_interfaces`, `list_programs`, `list_system_variables`, `describe_device_type`

**Read state** — `get_value`, `get_values` (bulk), `get_paramset`

**Change things** — `set_value`, `put_paramset`, `set_system_variable`, `execute_program`

**Check health** — `get_service_messages`, `get_system_info`

**Other** — `help` (context-aware), `run_script` (raw HomeMatic Script for bulk operations, renaming devices/channels, querying room membership, or anything not covered by the other tools)

Most tools auto-resolve the interface and value types from the device address — you don't need to know whether a device is on BidCos-RF or HmIP-RF.

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
