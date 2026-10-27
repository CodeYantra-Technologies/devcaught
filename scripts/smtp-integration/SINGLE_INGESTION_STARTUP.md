Single-process full-derived startup verification (Task 2H.14 repair)
===========================================================

Packaging repair prepared only; no Docker execution was performed for this repair.
The earlier Task 2H.11 attempt failed before recording any startup phases.
User-confirmed export evidence establishes that its matching historical image
contains the ingestion bundle and node_modules but lacks ingestion-bootstrap.mjs
and diagnostics.mjs. The earlier runner mounted only the wrapper. Its static
bootstrap import therefore could not resolve. The current Dockerfile's COPY
instructions do not establish contents of that already-built historical image.

Bounded WSL command, after execution authorization:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-single-ingestion.mjs
```

Requires the existing image devcaught:smtp-routing-integration-retry-1. Missing
image or existing container name fails preflight; no image is built or pulled.
The runner resolves and records the image ID, then creates exactly one container:
devcaught-single-ingestion-startup-2h14. The earlier 2h11 container is preserved.
It never invokes Compose or the full
launcher. No web child, PostgreSQL proxy, secrets, fixtures, routes or SMTP
transactions are involved. Previous resources and evidence remain untouched.

The existing smoke-entry.mjs is mounted read-only at
/app/single-ingestion-entry.mjs. Two additional read-only file mounts provide
the existing harness ingestion-bootstrap.mjs at /app/ingestion-bootstrap.mjs
and diagnostics.mjs at /app/diagnostics.mjs. Their relative imports resolve
within /app. All three host files are regular files with mode 0644, readable
by container UID 1000. No directory mount obscures the historical image's
/app/ingestion-build or /app/node_modules: its original bundle and dependencies
are still exercised. The original image layers are unchanged.
The wrapper supplies the same password-free database placeholder as the passing
smoke, suppresses application console output, reports allowlisted startup phases,
closes listeners/storage after ready, and has a 30-second internal deadline.

The entrypoint override runs Node as UID/GID 1000 in /app. Network mode is none;
root filesystem is read-only; capabilities are dropped. SQLite uses a fresh
32 MiB tmpfs owned by UID/GID 1000, mode 0700. The image's host and listener port
settings are retained, including the all-interface binding expected in the full
harness. Only private routing, isolated SQLite path, persistent-storage requirement
and disabled retention limits are explicitly supplied. No host environment is
forwarded. The PostgreSQL placeholder is set by the wrapper before startup.

Docker attachment is limited to 45 seconds; all metadata/create operations have
10-second limits. Final stop targets only the newly created container, allows
5 seconds for shutdown and has a 15-second client limit. No retry is automatic.
The stopped container and original image remain. No named volume or custom
network is created. Tmpfs contents disappear when the container stops.

Evidence is written to a new mode-0700 /tmp/devcaught-single-ingestion-2h14-*
directory with mode-0600 files: image.json (fixed image name and resolved ID) and
startup.jsonl (allowlisted phases, names/codes, attach result, actual container
running/exit/OOM state and cleanup outcome). stderr is ignored, arbitrary stdout
is discarded, and no logs, environment dumps, SQLite contents or secrets are read.
If Docker or Node fails before the wrapper loads, phase records may be absent.

Limitations: this exercises the selected existing image's ingestion bundle and
dependencies, not its original launcher or web plugin. It does not establish that
the image tag still identifies the user-verified historical image; the resolved
ID is recorded for comparison. Bootstrap and diagnostics now come from host
harness files, while the application bundle and dependencies come from the image.
Missing phases fail the check.
A pass supports standalone startup viability but cannot prove duplicate startup
caused the integration failure. It does not test named-volume ownership, concurrent
SQLite access, PostgreSQL connectivity, SMTP delivery/routing, web/API guards or
full integration readiness. Those remain separate checks.
