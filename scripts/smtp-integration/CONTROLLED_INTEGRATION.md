Controlled SMTP integration (Task 2H.29 fencing repair; not executed)
=============================================================

One separately authorized execution:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-controlled.mjs
```

This is a new runner. The original run.mjs, retry-1 runner semantics, prior claim
files, resources and evidence are not reused or reset. A new exclusive
/tmp/devcaught-smtp-integration-2h27.claim reserves one attempt before builds or
any fixture mutation. Never delete it to obtain another attempt.

Exact resources:

- Project: devcaught-smtp-integration-2h27
- Image: devcaught:smtp-routing-integration-2h27
- Application: devcaught-smtp-routing-2h27
- Readiness verifier: devcaught-smtp-routing-readiness-2h27
- Delivery verifier: devcaught-smtp-routing-verifier-2h27
- SQLite volume: devcaught_smtp_routing_2h27_data
- Internal network: devcaught_smtp_routing_2h27_net
- Evidence: new /tmp/devcaught-smtp-integration-2h27-* directory

Every named image/container/volume/network and existing project resource is checked
for conflict before build/start. No cleanup removes resources, including verifier
containers; only this run's label-matched containers are stopped. No host ports are
published. Verifiers have no credentials or PostgreSQL network, are UID/GID 1000,
read-only, drop capabilities and mount only the new volume and synthetic manifest.
The application joins only the fresh internal test network and existing verified
internal development PostgreSQL network. The shared database is not restarted or
reconfigured. Existing routing records and tombstones are untouched.

The named historical image devcaught:smtp-routing-integration-retry-1 must resolve
before and after build to
sha256:720d70dce51ab1613b55610a0f448aa2f66a7b3ed33440b6fa2658c536caaf0b.
Dockerfile.controlled copies only current launcher and helpers over that base;
its web bundle and dependencies remain historical. The context contains only four
harness files. No npm install or application rebuild occurs. Build uses --pull=false
and --network none. Container startup uses --no-build and --pull never. The verifier
uses the locally inspected historical image by ID, with the verifier entrypoint
overridden; no public node tag is pulled or overwritten. The builder must be able
to resolve the local historical image; build-step network isolation alone does not
control builder metadata resolution. Build failure occurs before fixture creation.

Exactly one web child owns SMTP 1025 and ingestion HTTP 8025 through the existing
Nitro plugin, alongside web 3000. The application drops all capabilities and adds
only CHOWN, SETUID, SETGID, KILL, DAC_OVERRIDE and FOWNER, matching the verified
Task 2H.26 startup requirements. Ownership and chmod policy stay unchanged.
Production sources, release guards, schema and routing logic are not modified.
The existing credential files are only mounted into the application at authorized
runtime; the orchestrator never opens them or prints their values.

Order before fixture provisioning:

1. Check conflicts, historical image identity, Compose configuration, dedicated
   database identity/health/volume/internal network and migration ledger 0001-0004.
2. Generate a fresh UUIDv4 manifest and assert all new owners/inboxes/destinations
   are absent, including revoked records. No old destination is reused.
3. Reserve the one attempt; build the fresh derived image and start the real
   corrected launcher against the new SQLite volume.
4. Run verify.mjs --readiness-only in its own fresh named container. Require web
   and ingestion HTTP health, SMTP greeting/EHLO, empty synthetic SQLite and UP/OK
   control-socket access as UID/GID 1000. No RCPT, DATA or routing fixtures yet.
   Require a sanitized completion event and confirm the application remains running
   without OOM before allowing provisioning.
5. Durably mark revocation_required before issuing transactional fixture creation.

Provisioning first takes transaction advisory lock 74008, then checks in a separate
SQL command that its deterministic cancellation destination does not exist. Only
then does it create fresh synthetic owners/inboxes, three active routes and a
fresh already-revoked test destination. These rows are permanent. The uniqueness
test runs in a rolled-back transaction. Only then does the full verifier test
delivery isolation, aliases, rejections, proxy outages/recovery, duplicate delivery
behavior, scoped SQLite counts and unchanged private web API release guards.

Cleanup and recovery:

- SIGINT/SIGTERM set interruption state and stop forward work. Docker operations
  are asynchronous. Ordinary active client commands are killed and finally runs.
  A database command already in flight is allowed to finish its bounded wait rather
  than being killed immediately on a signal. Every psql operation sets 15-second
  statement and 3-second lock timeouts; the client has a 90-second hard bound.
- Build is bounded to 120 seconds, readiness verifier to 180 seconds and delivery
  verifier to 240 seconds. Other Docker commands default to 30 seconds.
- Finally stops delivery verifier, readiness verifier and application independently,
  requiring the exact run UUID label before any stop. Each stop has a 5-second grace
  and 15-second client bound. Stop or evidence-collection failure does not skip
  revocation.
- Revocation revalidates the dedicated PostgreSQL target, takes transaction advisory
  lock 74008, and atomically inserts a separate permanent cancellation tombstone
  and revokes this manifest's three scoped active destinations. Its destination is
  smtp-it-<validated-run-UUID>-cancelled@integration.invalid, distinct from every
  delivery/rejection fixture. It is derived from the existing validated manifest
  and recorded in cleanup-state.json. The fresh-identifier check includes it.
- The existing smtp_inbox_route table already supports inserting revoked routes;
  no table, column, migration, trigger or production code changes are needed.
  The fence is inserted revoked with revoked_at set, attached to synthetic inbox A,
  and is never activated, deleted or used for message delivery. Existing routing
  tombstone immutability is preserved rather than bypassed.
- If delayed provisioning has not created its owners/inboxes yet, cancellation
  first creates only the synthetic owner A and inbox A required by the fence's
  existing foreign key. ON CONFLICT DO NOTHING preserves existing rows, followed
  by explicit expected-email/ownership checks; any mismatch aborts the transaction.
  Therefore recovery can leave these permanent synthetic anchor rows even when
  delivery fixtures never committed. It never creates auth accounts or sessions.
- Both provisioning and cancellation explicitly use READ COMMITTED and
  synchronous_commit=on. The authorization check is a separate command after lock
  acquisition, ensuring a fresh snapshot after any wait. The lock remains held
  until commit or rollback. Cleanup verifies the committed revoked fence belongs
  to inbox A AND the active-route count is zero before recording revoked_verified.
  Retries are bounded to three attempts; retries are not the fencing mechanism.
  Owners/inboxes, messages in the isolated volume and all tombstones remain.
- The manifest, image identity and cleanup-state.json are flushed to retained
  evidence. cleanup-state.json contains an exact recovery command from before the
  first possible fixture write. A failed revocation keeps revocation_required and
  produces a failing exit. A normal completed cleanup records revoked_verified.
- Recovery is explicit, idempotent and never starts application
  containers. It validates the evidence path, strict generated UUID/manifest
  structure and exact dedicated database target before scoped cancellation writes:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-controlled.mjs --revoke-only /tmp/devcaught-smtp-integration-2h27-RETAINED
```

Use the actual command saved in cleanup-state.json. Do not replace identifiers or
remove the claim to rerun delivery. Recovery appends recovery.jsonl and updates
cleanup-state.json; it does not overwrite original diagnostics or manifests.

Why a delayed exec cannot recreate active routes after successful cancellation:

- Provisioning gets the lock first: it may commit, but cancellation then takes the
  lock, persists the fence and revokes every scoped active route in one transaction.
- Cancellation gets the lock first: it commits the fence. Provisioning, even if its
  Docker exec begins much later, then takes the lock, sees that committed fence in
  its next READ COMMITTED command, raises an exception and rolls back before any
  fixture insert. ON_ERROR_STOP prevents the SQL script from proceeding.
- A lost cancellation COMMIT reply is safe: recovery checks/reuses the same marker.
  The marker is never removed. A failed or rolled-back cancellation cannot report
  revoked_verified. A zero-active-route count without the marker is insufficient.

Host SIGKILL/loss, daemon/database failure or a severed docker-exec client can still
prevent cancellation from committing. In that case cleanup is unresolved; the
retained recovery command must be run when the verified database is available.
It no longer needs to wait for the old provisioning client to terminate: the
committed fence protects against late execution. No successful cleanup is claimed
until the fence commit and zero-active verification succeed. An unknown cancellation
outcome remains revocation_required. Do not proceed to another run while unresolved.
This protocol protects SQL generated by the repaired runner; it cannot fence an
older externally submitted SQL script that never checks the cancellation marker.
No earlier controlled delivery execution has been authorized in this task sequence.

Evidence is restricted to allowlisted diagnostics and synthetic counts/checks.
Raw stderr is ignored; arbitrary stdout is discarded. No raw application logs,
credential values, connection strings or customer data are inspected. New volume
contents are synthetic only. Target and name availability are runtime preconditions,
not facts established during preparation. Actual routing delivery remains unverified
until the authorized run completes. No execution or fixture creation is part of
Task 2H.29 preparation.
