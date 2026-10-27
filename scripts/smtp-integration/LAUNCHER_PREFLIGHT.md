Fixture-free full launcher preflight (Task 2H.25; preparation only)
=================================================================

Bounded WSL command, after separate execution authorization:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-launcher-preflight.mjs
```

Resources: historical base devcaught:smtp-routing-integration-retry-1, passed by
its existing named tag to FROM. Before building, its local image ID must equal
sha256:720d70dce51ab1613b55610a0f448aa2f66a7b3ed33440b6fa2658c536caaf0b;
after building, that tag must still resolve to the same ID. Both checks are saved
in evidence. Fresh derived image: devcaught:launcher-preflight-2h25;
fresh container: devcaught-launcher-preflight-2h25. Existing target names cause refusal.
No Compose projects, volumes, published ports, custom networks or database fixtures.
No old image is retagged, rebuilt or removed. The new image/container are retained.

The build context contains only five allowlisted harness files copied into a new
mode-0700 /tmp/devcaught-launcher-preflight-2h25-*/build-context directory. The
Dockerfile uses FROM/COPY only, --pull=false and build network none; it needs the
historical image locally and has no npm install, build RUN, credentials or app
source. The new image includes the actual corrected launch.mjs, both helpers and
the preflight supervisor. Its web bundle and dependencies remain historical.
No Docker build has been performed during preparation.

The supervisor writes fixed public dummy hex values to two expected credential
filenames in a fresh /run/secrets tmpfs. It starts /smtp-test-launch.mjs itself;
it does not construct the application database configuration or start the web
entry directly. The real launcher reads/validates the dummy files, constructs its
child environment, creates the generated diagnostic file, chowns the data directory
and diagnostics, binds its loopback PostgreSQL proxy and Unix control socket,
sets socket ownership/mode, then spawns only the web child as UID/GID 1000.

The supervisor runs as root with only CHOWN, SETUID, SETGID, KILL and DAC_OVERRIDE
capabilities, retaining the earlier preflight restrictions. CAP_FOWNER is still
absent: a permission failure remains a hypothesis to diagnose, not a repaired
condition. Launcher application logic and capability settings are unchanged.
Root filesystem is read-only and no-new-privileges is enabled. /app/data is a
fresh root-owned 32 MiB tmpfs, mode 0755, so the launcher actually performs its
ownership setup rather than receiving preconfigured UID ownership. SQLite stays
ephemeral. /run/secrets is a separate fresh root-only 1 MiB tmpfs. No real secret,
host environment value, PostgreSQL owner/inbox/route or customer message is used.

Network none prevents external PostgreSQL access; no PostgreSQL server is supplied.
The real proxy remains unchanged except for an opt-in sanitized observation when
DEVCAUGHT_LAUNCHER_PREFLIGHT=1. Any client reaching it produces category
postgres_dependency; the supervisor fails even if listeners otherwise become ready.
It does not stub database queries or substitute a successful response. The upstream
connection path is unchanged and cannot reach the external database. If such a
dependency is observed, stop: review the dependency, then separately prepare a fresh
disposable PostgreSQL instance with synthetic configuration/schema only on an
isolated internal network, if necessary. Do not attach the shared development
database or silently weaken security controls. This task does not prepare that
alternative or create any database objects.

Readiness requires HTTP 200 for /api/health on 3000 and 8025, and a 220 SMTP greeting
prefix on 1025. Each internal probe has a 750 ms bound. No SMTP commands or messages
are sent; HTTP bodies and greeting text are not emitted. Metadata checks verify the
generated data directory/file and socket UID/GID, socket type and mode 0600. A
separate UID/GID-1000 probe sends UP over the Unix socket and checks only OK, with
a 1-second limit. It does not contact PostgreSQL or simulate outages.

The 30-second startup deadline covers setup and all readiness checks. On success,
failure or SIGINT/SIGTERM, the supervisor signals the actual launcher. The launcher
must record its web child's requested cleanup exit; clean code 0 or SIGTERM are
accepted. A forced launcher SIGKILL after 3 seconds fails the check; a 5-second
hard limit then exits the supervisor. The host attachment has a 45-second bound.
Image build has a 120-second limit; metadata/create have 10-second limits.

Host Docker operations are asynchronous so SIGINT/SIGTERM can trigger finally
cleanup. A unique ownership label protects against stopping an unrelated container,
including an uncertain create response. Cleanup inspects ownership (10 seconds),
then stops only this new container (5-second grace, 15-second client bound). No
automatic retries or resource deletion occur. Host SIGKILL/loss or Docker daemon
failure can still prevent cleanup; failures retain evidence and require scoped
manual recovery. Tmpfs disappears after stop. The fixture-free image and container
must not be substituted into a later integration run without explicit review.

Evidence: new mode-0700 /tmp/devcaught-launcher-preflight-2h25-* directory;
mode-0600 image.json and preflight.jsonl. Only fixed checks, allowlisted launcher
records, bounded exits/signals, timeout/OOM and cleanup results are retained.
Application stdout/stderr are ignored. Only the generated allowlisted diagnostic
file is parsed; no logs, SQLite data, response bodies or environment dumps are read.
The new image copies the Task 2H.24 repaired supervisor from the current harness.
On launcher exit it synchronously drains complete allowlisted diagnostic records
before finalizing, sharing a cursor with polling to avoid duplicate records.
Absent/unreadable files or an incomplete final tail produce sanitized diagnostics.
The runner retains launcher_event records, including applicationPhase, startupPhase
when supplied, category and allowlisted exception name/code. The launcher does not
currently supply exception name/code for its own startup catch; those may remain
null. Docker base_image_resolution, image_build and post_build_inspection retain
separate stages and sanitized process outcomes. No old evidence is overwritten.

Limitations: no runtime result is claimed. This exercises the real launcher with
synthetic credential contents, tmpfs and no external network, not real credential
mount permissions, named-volume semantics, shared PostgreSQL connectivity or SMTP
routing delivery. Full integration namespace/fixture ordering still needs its own
repair. A genuine database dependency is a blocker, not permission to add fixtures.
