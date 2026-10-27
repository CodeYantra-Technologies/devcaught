Apply and verify routing registry on dedicated local PostgreSQL
==============================================================

Run once from the project root in your normal WSL terminal:

```sh
node scripts/postgres-dev/apply-routing.mjs
```

Requires Node.js and Docker access. This command does not load .env or secret
files, use DATABASE_URL, start containers or create helper containers. It executes
psql over the existing devcaught-pg-dev container's Unix socket as the local
postgres administrator, switching to devcaught_auth_owner for migration and
synthetic writes, and devcaught_auth_app for privilege/readiness verification.
Local socket authentication must already permit this; failure stops execution,
without changing authentication configuration or requesting credentials.

Target preflight requires exact container name, Compose project/service labels,
dedicated volume name, healthy state, PostgreSQL 16, database devcaught_auth_dev
and expected owners of the ledger/user/private-inbox dependency tables. It never
prints container environments or message/user contents. Only ledger names and
aggregate PASS/BLOCKED results are emitted.

Compatibility: migrate.mjs applies all pending top-level files and needs a
credential-bearing connection URL. This bounded socket adapter reuses its
migration-plan.mjs planner and the same apply-plus-ledger transaction mechanism.
It accepts only ledger 0001–0003 or 0001–0004 and refuses other pending files.
An advisory lock plus in-transaction ledger recheck prevents two copies of this
helper from racing. Do not run another migration tool concurrently. If 0004 is
already recorded it is not replayed. Otherwise its DDL and ledger insert commit
atomically. SELECT grants are included in the same transaction. No previous
migration file or ledger record is modified.

Synthetic uniqueness, FK, assignment immutability, parent ownership and revoked
tombstone checks run in a transaction that always rolls back (connection closure
also rolls back errors). Real concurrent claims use two independent sessions:
the first holds an uncommitted destination assignment, while a conflicting
INSERT...ON CONFLICT in the second is rejected by a short lock timeout. Both
sessions roll back; an idle-transaction timeout bounds the first session.
This verifies real unique-key arbitration without committing test records. It
does not claim to test a committed winning assignment across two transactions;
conflicting committed mappings are covered by the uniqueness checks within the
rolled-back fixture transaction. Fixtures carry unique synthetic IDs/emails and
do not update any pre-existing ownership.

Application grants are only SELECT on the two new tables. Catalog checks verify
no effective table/column write privileges, including inherited privileges. A
pre-existing excessive grant causes verification failure rather than revoking
unrelated privileges. The existing readiness check's exact SQL is extracted
without importing app bootstrap and executed as the app role in BEGIN READ ONLY.
Source format drift causes refusal, not a substituted check.

Migration commit is intentionally durable. A later verification failure does not
undo 0004 or grants; stop and investigate the named task instead of replaying DDL.
The helper emits no raw SQL diagnostics, credentials or fixture values. It does
not wire SMTP/Twilio, access SQLite, change the release guard, or operate on app
containers. Those containers are not contacted, so their HTTP 503 behavior is
preserved by leaving their configuration and release artifacts unchanged rather
than by rerunning endpoint tests.
