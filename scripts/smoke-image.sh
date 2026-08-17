#!/usr/bin/env bash
# Smoke-test a ccu-mcp container image: does it run, does it know what it was
# built from, and does the server inside it actually answer?
#
# Used by BOTH container jobs in .github/workflows/publish.yml — the
# per-architecture build (before anything is pushed) and the published
# manifest list afterwards — so the pre-push and post-push checks cannot drift
# apart, and so the same assertions can be run by hand against a local build:
#
#   docker build -t ccu-mcp:local . && bash scripts/smoke-image.sh ccu-mcp:local
#
# EXPECT_COMMIT  seven-character commit the image must report in build-info
#                (the release passes it; a local build has nothing to compare
#                against, so it is optional)
# SMOKE_PORT     host port for the external health probe (default 3000)
set -euo pipefail

image="${1:-}"
if [ -z "$image" ]; then
  echo "usage: $0 <image-ref>" >&2
  exit 2
fi
port="${SMOKE_PORT:-3000}"
container="ccu-mcp-smoke-$$"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 1. The program starts and identifies itself.
#
# `docker run <image> --help` does NOT reach the server: node:24-alpine ships
# an ENTRYPOINT that turns a leading `-` argument into a `node` flag, so that
# prints Node's help and exits 0 — a smoke test that passes without ever
# starting this program. Name the command.
docker run --rm "$image" node dist/index.js --help > "${TMPDIR:-/tmp}/ccu-help.$$"
grep -q "ccu-mcp" "${TMPDIR:-/tmp}/ccu-help.$$"
rm -f "${TMPDIR:-/tmp}/ccu-help.$$"

# 2. The image knows its own provenance. `.dockerignore` excludes .git, so
# BUILD_COMMIT/BUILD_TAG build args are the only way the commit reaches
# get_system_info; a build-arg rename or a .dockerignore change silently
# returns every published image to reporting nulls about itself, and nothing
# else in a release would notice.
info=$(docker run --rm --entrypoint node "$image" \
  -p 'JSON.stringify(require("/app/dist/build-info.json"))')
echo "build-info: $info"
if [ -n "${EXPECT_COMMIT:-}" ]; then
  if ! printf '%s' "$info" | grep -q "\"commit\":\"${EXPECT_COMMIT}\""; then
    echo "::error::Image build-info does not report commit ${EXPECT_COMMIT}; BUILD_COMMIT did not reach gen-build-info.mjs."
    exit 1
  fi
fi

# 3. The claim a release actually makes: pull this and you get a server that
# comes up. Everything above is satisfied by an image whose listener never
# binds — a bad config default, a missing dist/ file on a path `--help` does
# not touch, a native dependency that only fails at listen() time.
#
# Dummy CCU coordinates because the server refuses to boot without them. It
# does not dial the box until a tool is called, and unauthenticated /health is
# liveness only (it deliberately reports nothing about the session), so this
# needs neither a CCU nor real credentials.
#
# The --health-* flags override the Dockerfile's production intervals (30s
# between probes, 15s start period) without replacing the probe itself: what is
# being exercised is still the HEALTHCHECK shipped in the image, which is what
# a user's orchestrator reads to decide whether this container is up.
docker run -d --name "$container" \
  -p "127.0.0.1:${port}:3000" \
  -e CCU_HOST=127.0.0.1 \
  -e CCU_PASSWORD=smoke \
  --health-interval=2s \
  --health-start-period=1s \
  --health-retries=3 \
  "$image" > /dev/null

status=starting
for _ in $(seq 1 45); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != "true" ]; then
    status=exited
    break
  fi
  status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  if [ "$status" = "healthy" ] || [ "$status" = "unhealthy" ]; then
    break
  fi
  sleep 1
done

if [ "$status" != "healthy" ]; then
  echo "::error::Image never reported healthy (last status: ${status})."
  docker logs "$container" || true
  exit 1
fi
echo "HEALTHCHECK: healthy"

# The healthcheck above probes loopback INSIDE the container, and would pass
# just as happily if the listener bound to 127.0.0.1 only — in which case
# `docker run -p` publishes a port that answers nothing and every user's first
# request fails. Ask from outside, the way a user does.
body=$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/health")
echo "GET /health: $body"
if ! printf '%s' "$body" | grep -q '"status":"ok"'; then
  echo "::error::/health did not report ok on the published port."
  docker logs "$container" || true
  exit 1
fi

echo "Smoke test passed: ${image}"
