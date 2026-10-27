FROM node:22-bookworm-slim AS ingestion-builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY apps ./apps
COPY packages ./packages
COPY src/lib/inbox/private-inbox-routing.server.ts ./src/lib/inbox/private-inbox-routing.server.ts
COPY scripts/smtp-integration/ingestion.vite.mjs ./scripts/smtp-integration/ingestion.vite.mjs
RUN ./node_modules/.bin/vite build --config scripts/smtp-integration/ingestion.vite.mjs
FROM devcaught:smtp-routing-integration-base
USER root
COPY --from=ingestion-builder /build/node_modules /app/node_modules
COPY --from=ingestion-builder /build/ingestion-build /app/ingestion-build
COPY scripts/smtp-integration/launch.mjs /smtp-test-launch.mjs
COPY scripts/smtp-integration/ingestion-bootstrap.mjs /app/ingestion-bootstrap.mjs
COPY scripts/smtp-integration/diagnostics.mjs /app/diagnostics.mjs
ENTRYPOINT ["node", "/smtp-test-launch.mjs"]
