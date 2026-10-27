FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV DEVCAUGHT_DOCKER_BUILD=1
ENV VITE_AUTH_ENABLED=true

RUN env -u DATABASE_URL npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DEVCAUGHT_HOST=0.0.0.0 \
    DEVCAUGHT_SMTP_PORT=1025 \
    DEVCAUGHT_HTTP_PORT=8025 \
    DEVCAUGHT_DB_PATH=/app/data/devcaught.db \
    DEVCAUGHT_REQUIRE_PERSISTENT_DB=1

WORKDIR /app

COPY --from=builder --chown=node:node /app/.output ./.output

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000 8025 1025

CMD ["node", ".output/server/index.mjs"]
