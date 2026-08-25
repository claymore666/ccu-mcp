# Node 24, not the newest tag. This project runs ONE Node major everywhere —
# `engines`, `@types/node`, every workflow's `node-version` and both stages
# here — and 24 is the one under Active LTS support (26 becomes LTS in October
# 2026). It is also the only major the test suite ever executes on, so a base
# image ahead of it would ship users a configuration nothing here has run.
# scripts/check-node-version.mjs fails the build if these four drift apart.
#
# Pinned by digest as well as tag, the same contract the SHA-pinned actions get:
# `node:24-alpine` is a moving target, so without this a rebuild of an old
# commit is not the image that commit produced. The digest is the OCI *index*,
# not a per-arch manifest, so the multi-arch build in publish.yml still resolves
# linux/amd64 and linux/arm64 from it. Dependabot bumps digest and tag together
# (majors are held back — see .github/dependabot.yml), so the pin will not rot.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
# Full build (tsc + build-info stamp). `.dockerignore` excludes .git, so the
# build has no repository to read: without these two the git fields are null and
# only builtAt survives. The publish workflow passes them, so a released image
# reports the commit and tag it was built from; a local `docker build` leaves
# them empty and gets the old null behaviour, which is honest for a build whose
# source nobody can pin down.
ARG BUILD_COMMIT=""
ARG BUILD_TAG=""
ENV BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_TAG=${BUILD_TAG}
RUN npm run build

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
# `image.source` is not decoration: GHCR links a package to a repository by this
# label, and that link is what carries the README, the licence and the "published
# by" provenance on the package page. Without it the image floats unattached.
ARG BUILD_COMMIT=""
ARG BUILD_TAG=""
LABEL org.opencontainers.image.title="ccu-mcp" \
      org.opencontainers.image.description="MCP server for controlling HomeMatic smart home devices via the CCU JSON-RPC API" \
      org.opencontainers.image.source="https://github.com/claymore666/ccu-mcp" \
      org.opencontainers.image.documentation="https://github.com/claymore666/ccu-mcp#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_TAG}"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
RUN addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app \
    && mkdir -p /data && chown app:app /data
VOLUME /data
ENV CACHE_DIR=/data
USER app
EXPOSE 3000
# Honors MCP_PORT and native TLS (self-signed): try HTTP first, fall back to
# HTTPS with certificate checking off (it's a loopback liveness probe).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c 'wget -qO- "http://localhost:${MCP_PORT:-3000}/health" 2>/dev/null | grep -q "\"status\"" || wget -qO- --no-check-certificate "https://localhost:${MCP_PORT:-3000}/health" 2>/dev/null | grep -q "\"status\"" || exit 1'
CMD ["node", "dist/index.js"]
