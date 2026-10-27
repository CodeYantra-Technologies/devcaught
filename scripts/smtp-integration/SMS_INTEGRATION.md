Controlled private Twilio SMS integration (Task 2I.4; implementation only)
=======================================================================

No Docker, SQL, HTTP requests or integration execution is included in preparation.
After a separate execution authorization, the single controlled command is:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-controlled.mjs --sms
```

The runner reuses the existing controlled lifecycle rather than copying it. Without
--sms, original SMTP arguments, names, web-owned startup, fixtures and recovery remain
the default. The SMS profile never runs verify.mjs or opens an SMTP connection.

Fresh resources (existing names or project resources cause refusal):

- Project: devcaught-sms-integration-2i4
- Image: devcaught:sms-routing-integration-2i4
- Application: devcaught-sms-routing-2i4
- Readiness verifier: devcaught-sms-routing-readiness-2i4
- Delivery verifier: devcaught-sms-routing-verifier-2i4
- SQLite volume: devcaught_sms_routing_2i4_data
- Internal network: devcaught_sms_routing_2i4_net
- Evidence prefix: /tmp/devcaught-sms-integration-2i4-*
- Exclusive one-attempt claim: /tmp/devcaught-sms-integration-2i4.claim

Do not remove the claim to get another attempt. No old tags, stopped containers,
volumes, networks, SMTP evidence or routing tombstones are overwritten or removed.
New verifier containers are retained too. Stops require the matching run UUID label.
The shared lifecycle retains its existing devcaught.smtp-run label/environment
plumbing; SMS names and generated UUIDs are separate from every historical run.

Packaging and process ownership:

Dockerfile.sms uses the same inspected historical dependency image, whose tag must
resolve before and after build to
sha256:720d70dce51ab1613b55610a0f448aa2f66a7b3ed33440b6fa2658c536caaf0b.
The allowlisted build context copies current apps/server source, shared/parser
sources and package metadata, the standalone Vite config, registry helper and harness
helpers. It never copies protected auth source, environment files, data directories,
or the full workspace. Build uses --pull=false and --network none.

The historical image already contains node_modules including Vite. No npm install,
normal web build or migration script runs. Vite builds the current standalone entry
with its dedicated library config; only its newly generated bundle is copied into
the fresh runtime image, alongside the updated launcher/bootstrap/diagnostics.
Dependencies are reused, not refreshed. Missing or incompatible historical build
tools fail the image build before fixture creation; do not weaken isolation to
silently fetch replacements. Base-image metadata resolution still depends on the
builder's access to the local image store; build-step isolation alone does not
disable registry metadata resolution.

Only the exact launcher owner values web and sms are allowed. The default web path
is unchanged. SMS requires private SMS enabled and private SMTP disabled; it starts
only ingestion-bootstrap.mjs as UID/GID 1000. The historical web bundle is never
launched. The existing runtime still binds its SMTP listener, but the SMS verifier
does not connect, issue EHLO or send any SMTP message. Only ingestion HTTP 8025 is
used; port 3000 is not required. Bootstrap startup phases remain allowlisted.

Isolation and credentials:

The fresh named SQLite volume is owned by UID/GID 1000 and is the only message store
mounted. No host ports are published. The application joins the fresh internal SMS
network plus the existing verified internal development PostgreSQL network. The
verifier joins only the SMS network, runs as UID/GID 1000 with no capabilities and
read-only filesystem/volume mounts. The app retains cap-drop ALL plus only CHOWN,
SETUID, SETGID, KILL, DAC_OVERRIDE and FOWNER, and no-new-privileges.

Only the existing app_password file is mounted into the app at authorized runtime.
The launcher reads it inside that container and constructs the application-role
configuration in memory. SMS does not read better_auth_secret. The runner and
verifier never open credential files. Synthetic AccountSid and signing token are
public test configuration; no real Twilio credentials or account are used. The
configured HTTPS public URL is signed as text; every fetch goes only to
http://sms-test:8025. No Twilio service, DNS lookup for the public URL, external
HTTPS request or phone-provider provisioning is involved.

Pre-fixture gates:

1. Existing lifecycle checks all resource conflicts and the exact healthy dedicated
   PostgreSQL container, project/service labels, database, volume, internal network
   and migration ledger. Only scoped counts are retained.
2. A fresh UUID derives synthetic owners/inboxes, a valid AC account ID and distinct
   E.164-shaped fixture numbers. Uniqueness is the complete provider/account/number
   tuple; preflight requires zero routes for that fresh account, even revoked ones.
3. Save the manifest and scoped recovery command, reserve the one attempt, build the
   new image, recheck base identity and start the actual SMS launcher/profile.
4. The readiness-only verifier requires HTTP health and opens only the fresh SQLite
   database read-only. It proves zero rows, accesses the proxy control socket as
   UID/GID 1000, then sends a valid signed request to the absent synthetic route.
   It must get exactly 404 and still have zero rows. A bad signature must get 403
   with zero rows. A stale root-writing bundle returning 200, or failed database
   access returning 503, fails the gate before any routing fixture write.
5. The runner requires the exact allowlisted readiness PASS plus verifier completion
   and successful process exit; the app must still be running without OOM. It then
   flushes revocation_required before issuing provisioning SQL.

Delivery assertions:

The HTTP verifier signs form and JSON bodies independently with Node crypto; JSON
includes its bodySHA256 query. Tests require correct inbox A/B delivery, ignored
client inbox/owner claims, verified normalized events, exact scoped message IDs,
zero cross-inbox/unassigned rows, stable duplicate IDs without another insert,
403 for account/signature failures, 404 for unknown/revoked destinations, and 400
for duplicate identity fields/status callbacks. Cutting only the local proxy must
produce 503 without writes; restoring it must allow a new scoped delivery.
No private message API or release guard is enabled to inspect results.

Fixture cancellation and recovery:

sms-profile.mjs contains the only SMS fixture SQL. Two active routes and one
already-revoked rejection fixture use the fresh twilio/account tuple. A fourth,
distinct permanently revoked tuple is reserved exclusively for cancellation; it
is never sent a message or activated. No migration/schema/privilege changes occur.

Provisioning and cancellation use transaction advisory lock 74008 with explicit
READ COMMITTED and synchronous_commit=on. Provisioning checks the full cancellation
tuple in a separate statement after taking the lock and before any insert. Cleanup
atomically creates/validates the synthetic A anchor if needed, persists that revoked
fence and revokes active routes for this account and the run's two inboxes. It then
requires the committed fence AND zero active routes for the entire account before
recording revoked_verified. Unexpected ownership/fence collisions abort instead of
modifying historical assignments. Repeated recovery is idempotent.

If provisioning wins the lock, cleanup revokes its committed rows. If cancellation
wins, even a Docker exec that starts much later sees the permanent fence and aborts
before inserting. A lost COMMIT reply does not remove the marker. Failed cancellation
stays revocation_required; zero rows alone never establish successful cleanup.
Permanent synthetic users/inboxes and all route/fence tombstones remain, including
an A anchor created by cleanup when original provisioning never committed.

Before fixture writes cleanup-state.json contains the exact scoped command:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-controlled.mjs --sms --revoke-only /tmp/devcaught-sms-integration-2i4-RETAINED
```

Use the actual retained path. Recovery validates its canonical evidence path, exact
generated manifest and dedicated database target. It does not build/start containers
or send requests. It appends recovery evidence and fences/revokes only this run.
Never use the historical SMTP recovery command for SMS evidence.

Bounds and evidence:

Existing asynchronous signal handling/finally cleanup and SQL statement/lock/client
timeouts are reused. The build has a 120-second bound. Readiness and delivery clients
have 180/240-second bounds; each HTTP request has a 5-second bound and each verifier
has a 90-second hard deadline. Each control request has a 2-second bound. Cleanup
stops only label-matched new containers (5-second grace/15-second client timeout)
and attempts fenced revocation up to three times after target revalidation.
SIGINT/SIGTERM stop forward work and enter cleanup. Host SIGKILL/loss or daemon/DB
failure can prevent cancellation; retain evidence and run recovery when available.
No successful cleanup is claimed without the committed marker and zero active count.

Mode-0700 evidence directories contain the synthetic manifest, image identity,
readiness/verification diagnostics, cleanup state and projected launcher records.
Only fixed check names, bounded counts/HTTP statuses, allowlisted phases/categories,
signals and exit/timeout metadata are retained. Raw stderr is ignored; arbitrary
stdout and response/error bodies are not emitted. SQLite reads are limited to the
fresh synthetic volume; payload fields are checked locally and never printed.

STOP on resource/claim conflicts, image/build-tool mismatch, failed signed-404 gate,
invalid target or app-role access, unexpected SQLite rows, unresolved fencing or
cleanup failure. Do not reset the claim, reuse tombstones, add credential exposure
or disable signature/release checks. Concurrent PostgreSQL revocation and SQLite
insertion remain non-atomic. Synthetic signing tests the app contract, not Twilio
interoperability or real delivery. This profile must not rerun SMTP integration.
