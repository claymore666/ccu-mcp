FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

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
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health | grep -q '"status"' || exit 1
CMD ["node", "dist/index.js"]
