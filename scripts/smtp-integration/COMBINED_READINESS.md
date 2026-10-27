Fixture-free combined readiness (Task 2H.16; not executed)
========================================================

Prepared WSL command, for a separately authorized execution:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-combined-readiness.mjs
```

Uses existing image devcaught:smtp-routing-integration-retry-1, resolved to an
immutable ID and recorded in image.json. Creates only the new container
devcaught-combined-readiness-2h16. Conflicting names or missing image stop the
runner. No build, pull, Compose invocation, published ports, named volumes or
custom networks are used. All previous resources and evidence are preserved.

The historical image is known to lack the bootstrap and diagnostic helper. Its
old launcher does not contain Task 2H.15's single-owner change. This check does
not rely on that launcher: a read-only mounted combined-readiness-entry.mjs
supervises only .output/server/index.mjs. The production Nitro startup plugin
remains unchanged and owns ingestion. The wrapper is a harness supervisor, not
a second ingestion runtime. Read-only mounts supply ingestion-bootstrap.mjs and
diagnostics.mjs; bootstrap is not executed. Metadata checks establish the presence
and expected type of these mounted files, the historical web entry, ingestion
bundle and dependency directory. They do not validate every dependency package.
No Docker inspection was performed during preparation.

Runs as UID/GID 1000, working directory /app, root filesystem read-only,
capabilities dropped, no-new-privileges, network none. SQLite uses a fresh 32 MiB
UID-owned tmpfs, mode 0700. No host environment, credentials, secret mounts or
proxy are supplied. A password-free loopback PostgreSQL placeholder and a fixed
synthetic auth signing value are set only in the child's environment. Networking
prevents external PostgreSQL access; nothing listens at the placeholder port.
No database fixtures, auth accounts, routes or SMTP messages are created.

Each probe is bounded to 750 ms. Web and ingestion HTTP must return status 200
for /api/health on 3000 and 8025; bodies are discarded without inspection. SMTP
must produce a 220 greeting prefix on 1025; no command is sent. All three checks
must pass in one polling round before the 30-second internal deadline. The web
child must remain alive until readiness, then receives SIGTERM; SIGKILL after
3 seconds is a failure, with a 5-second hard shutdown bound. SIGINT/SIGTERM in
the wrapper trigger cleanup. Application stdout/stderr are ignored.

Host attachment has a 45-second timeout. Docker metadata/create commands have
10-second limits. The finally block stops only the newly created container,
with 5-second Docker stop grace and 15-second client timeout, on success, failure
or attachment timeout. Cleanup failure is reported with the exact container name
for manual recovery. Host SIGKILL, host loss or an unavailable Docker daemon can
prevent cleanup; no process can guarantee cleanup in those cases. No resources
are removed. The new stopped container remains, while tmpfs data disappears.

Evidence: new mode-0700 /tmp/devcaught-combined-readiness-2h16-* directory,
mode-0600 image.json and readiness.jsonl. Records contain fixed checks/outcomes,
allowlisted exception names/codes, process exit/signal, timeout, OOM and cleanup
state. No raw logs, response text, environment values or database contents enter
evidence. Pre-wrapper failures may produce only process outcomes.

Limitations: PostgreSQL-free web initialization is not established until this
check runs. If the web entry requires a live database, the result should remain
a sanitized failure rather than adding fixtures or disabling guards. A pass
establishes combined listener readiness only, not routing delivery, PostgreSQL
access, private API guard behavior, volume permissions, or the historical failure
cause. The updated integration launcher is bypassed here; its credential/proxy
setup and full integration orchestration remain untested. Image ID is retained
for comparison with earlier evidence. No execution is included in preparation.
