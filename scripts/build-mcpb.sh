#!/usr/bin/env bash
# Build the MCPB bundle published to Smithery.
#
# Used by `npm run build:mcpb` and by .github/workflows/publish.yml, so a
# release and a local rebuild produce the same artifact.
#
# The manifest is GENERATED from smithery/manifest.template.json with the
# version injected from package.json. The template deliberately has no
# `version` field: a committed one would be a fourth place the release version
# lives, and the first three already need a sync script and a CI gate to stay
# honest. Nothing that cannot drift needs checking.
#
# Requires: a built dist/ (run `npm run build` first).
# Output:   ccu-mcp-<version>.mcpb in the repo root.
#
# Deliberately NOT in the bundle: devDependencies (npm ci --omit=dev), the
# source tree, tests, and .github. `files` in package.json ships dist/ only for
# the same reason — none of it is needed to run the server.
set -euo pipefail

MCPB_VERSION="${MCPB_VERSION:-2.1.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d dist ]; then
    echo "FAIL: dist/ is missing — run 'npm run build' first." >&2
    exit 2
fi
if [ ! -f smithery/manifest.template.json ]; then
    echo "FAIL: smithery/manifest.template.json is missing." >&2
    exit 2
fi

version="$(node -p "require('./package.json').version")"
out="$ROOT/ccu-mcp-${version}.mcpb"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "Building MCPB bundle for ccu-mcp ${version}"

# Mirror the layout the manifest's entry_point expects: server/dist/index.js.
mkdir -p "$stage/server"
cp -r dist "$stage/server/dist"
cp package.json package-lock.json "$stage/server/"
cp README.md LICENSE "$stage/"

# Production dependencies only. `npm ci` needs the lockfile, which is why it is
# copied above even though it is not published to npm.
( cd "$stage/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null )

node -e '
  const fs = require("fs");
  const tpl = JSON.parse(fs.readFileSync("smithery/manifest.template.json", "utf8"));
  const version = require("./package.json").version;
  if (tpl.version) {
    console.error("FAIL: the template must not carry a version — that is the drift this avoids.");
    process.exit(2);
  }
  // Rebuild in a fixed key order so the generated manifest is byte-stable
  // across runs: version goes straight after name, where a reader expects it.
  const out = {};
  for (const [k, v] of Object.entries(tpl)) {
    out[k] = v;
    if (k === "name") out.version = version;
  }
  fs.writeFileSync(process.argv[1] + "/manifest.json", JSON.stringify(out, null, 2) + "\n");
  console.log("manifest.json generated at version " + version);
' "$stage"

npx -y "@anthropic-ai/mcpb@${MCPB_VERSION}" validate "$stage/manifest.json"

# Smoke test the thing that will actually run. A bundle that packs cleanly but
# cannot start is the failure a validated manifest does not catch.
echo "Smoke test: MCP initialize handshake against the staged server"
handshake='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"build-mcpb","version":"1"}}}'
reply="$(printf '%s\n' "$handshake" \
    | CCU_HOST=127.0.0.1 CCU_USER=smoke CCU_PASSWORD=smoke \
      timeout 30 node "$stage/server/dist/index.js" --stdio 2>/dev/null | head -1 || true)"
if ! printf '%s' "$reply" | grep -q '"serverInfo"'; then
    echo "FAIL: staged server did not complete an MCP initialize handshake." >&2
    echo "  reply: ${reply:-<empty>}" >&2
    exit 1
fi
if ! printf '%s' "$reply" | grep -q "\"version\":\"${version}\""; then
    echo "FAIL: staged server reported a different version than ${version}." >&2
    echo "  reply: ${reply}" >&2
    exit 1
fi
echo "  handshake OK, server reports ${version}"

rm -f "$out"
npx -y "@anthropic-ai/mcpb@${MCPB_VERSION}" pack "$stage" "$out"
echo "Bundle: $out"
