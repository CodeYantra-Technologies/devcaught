# Mandatory reviewed platform-specific digest. No mutable tag/default is allowed.
ARG NODE_DIGEST
FROM docker.io/library/node@sha256:${NODE_DIGEST} AS dependencies
ARG EXPECTED_NODE_VERSION
ARG EXPECTED_NPM_VERSION
WORKDIR /app
COPY inputs/package.json inputs/package-lock.json ./
COPY inputs/apps/server/package.json ./apps/server/package.json
COPY inputs/packages/shared/package.json ./packages/shared/package.json
COPY inputs/packages/parsers/package.json ./packages/parsers/package.json
RUN test "$(node --version)" = "v${EXPECTED_NODE_VERSION}" && test "$(npm --version)" = "${EXPECTED_NPM_VERSION}"
# This is the ONLY network-enabled RUN. There is no application source here.
RUN --network=default NPM_CONFIG_USERCONFIG=/dev/null npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS compile
COPY inputs/ ./
# Explicit flags replace the app-env wrapper; neither it nor migration scripts run.
RUN --network=none env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp DEVCAUGHT_DOCKER_BUILD=1 VITE_AUTH_ENABLED=true node node_modules/vite/bin/vite.js build --config vite.config.ts

FROM docker.io/library/node@sha256:${NODE_DIGEST} AS runtime
ARG NODE_DIGEST
ARG INPUT_MANIFEST_SHA256
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DEVCAUGHT_HOST=0.0.0.0 DEVCAUGHT_SMTP_PORT=1025 DEVCAUGHT_HTTP_PORT=8025 DEVCAUGHT_DB_PATH=/app/data/devcaught.db DEVCAUGHT_REQUIRE_PERSISTENT_DB=1
LABEL devcaught.closed-build.input-sha256=${INPUT_MANIFEST_SHA256} org.opencontainers.image.base.name=docker.io/library/node@sha256:${NODE_DIGEST}
WORKDIR /app
COPY --from=compile --chown=1000:1000 /app/.output ./.output
COPY inputs/scripts/candidate/launch.mjs /candidate-launch.mjs
COPY provenance.json /candidate-inputs.json
RUN --network=none mkdir -p /app/data && chown 1000:1000 /app/data
# Existing launcher reads runtime-only mounts, then drops its child to UID/GID 1000.
USER 0:0
ENTRYPOINT ["node", "/candidate-launch.mjs"]
CMD []
