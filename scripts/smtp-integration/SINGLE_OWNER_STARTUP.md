Single listener owner (Task 2H.15; preparation only)
=================================================

The normal Docker build enables the Nitro docker-startup plugin. That plugin
unconditionally calls startStandaloneServer in the web process, binding SMTP
1025 and ingestion HTTP 8025 as well as the web server's 3000 listener. Its runtime
cache is local to that process. No existing plugin configuration disables ingestion.

The harness launcher now starts only .output/server/index.mjs, as UID/GID 1000
with the same working directory, environment, SQLite ownership and proxy setup.
Compose explicitly selects DEVCAUGHT_INTEGRATION_INGESTION_OWNER=web. The launcher
defaults to web and rejects other values. This selector describes and enforces
the harness process model; it does not change production plugin behavior.
The web process is the sole application process and owns all three listeners.
The integration verifier still reaches its web API and unchanged private API guards.
Existing shutdown supervision remains, with processName=web for child outcomes.

The harness Dockerfile already copies ingestion-bootstrap.mjs and diagnostics.mjs.
Both remain packaged for isolated standalone diagnostics but are not launched in
parallel with Nitro. Historical images lacking helpers are unchanged; new source
does not repair already-built images. The isolated runner's read-only helper mounts
remain available. No image/container creation or integration execution is included.

A fixture-free check can validate this model: use a fresh namespace, the selected
full-derived image, UID-owned SQLite tmpfs, network none and password-free database
placeholder; start only the web entry, then probe /api/health on 3000 and ingestion
HTTP readiness on 8025 plus the SMTP greeting on 1025 from inside the container.
Do not issue RCPT, DATA or send messages. Keep probes and process-exit evidence
allowlisted and bounded. Such a check must account for any additional web startup
database requirements; PostgreSQL-free web startup is not yet established.
Standalone bootstrap phase records cannot describe Nitro-owned startup.

That combined fixture-free runner is not prepared here. The existing standalone
startup command validates only standalone ingestion, and the full integration
runner provisions permanent fixtures, so neither is a safe combined next command.
Prepare the combined fixture-free check before authorizing further execution.

Single-owner startup is supported by source inspection, but no new runtime success
or SMTP routing delivery is claimed. Production plugin, routing, schemas, release
guards, SQLite ownership logic and existing Docker resources remain unchanged.
