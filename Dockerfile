FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
# Full build (tsc + build-info stamp). No .git in the build context ⇒ the git
# fields are null, but dist/build-info.json exists with builtAt, so
# get_system_info's `build` block works in the image instead of silently
# reporting nothing. Pass real values by building from a git checkout in CI.
RUN npm run build

FROM node:24-alpine
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
