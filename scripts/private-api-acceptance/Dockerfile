ARG HISTORICAL_IMAGE
FROM ${HISTORICAL_IMAGE} AS builder
USER root
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY src ./src
COPY scripts ./scripts
# Dedicated framework app only. No normal app build, auth preview, migrations,
# package installation or production guard substitution.
RUN ./node_modules/.bin/vite build --config scripts/private-api-acceptance/vite.config.mjs
FROM ${HISTORICAL_IMAGE}
USER root
WORKDIR /app
COPY --from=builder /app/.output ./.output
COPY launch.mjs /smtp-test-launch.mjs
COPY diagnostics.mjs /app/diagnostics.mjs
ENTRYPOINT ["node", "/smtp-test-launch.mjs"]
