# Isolated authenticated private API acceptance — Task 2J.2

Preparation only. No Docker build, SQL, HTTP or acceptance execution was performed
while preparing these files. Production activation remains NO-GO.

## Test boundary

This is a separate, minimal TanStack Start/Nitro application built from an
explicit source allowlist using the guarded historical image's installed build
dependencies. It does not build the normal application, include its routes or
copy protected auth source. A build loader rejects auth modules outside the
explicit allowlist, including unexpected inherited modules. Nitro source/plugin
auto-scanning is disabled so the historical ingestion startup plugin is not used.
Its catch-all API route calls the real framework
`getRequest()`, production invitation policy, auth HTTP handler, fresh session
policy, `requirePrivateInbox()` resolver, private API factory and scoped SQLite.
Only the auth singleton imports of the production resolver/verification modules
are build-aliased to the bounded test singleton. No user ID is injected into the
resolver. The test singleton rejects requests for identities outside this run.

Activation is the literal `postgresVerified:true` in `app/entry.server.ts` of this
separate image. The normal release module is copied unchanged and asserted to be
false. No environment variable, cookie, header or URL activates production APIs.
The profile selection and run variable configure only the isolated harness.
No production code, migrations, release guards or auth preview are changed.

## Resources and bounded execution

Image: `devcaught:private-api-acceptance-2j2`. Application:
`devcaught-private-api-2j2`. Readiness and verifier containers:
`devcaught-private-api-readiness-2j2`, `devcaught-private-api-verifier-2j2`.
Volume: `devcaught_private_api_2j2_data`. Internal network:
`devcaught_private_api_2j2_net`. Project: `devcaught-private-api-2j2`.

The shared controlled runner refuses existing names/project resources and an
existing `/tmp/devcaught-private-api-2j2.claim`. It pins the historical tag to
`sha256:720d70dce51ab1613b55610a0f448aa2f66a7b3ed33440b6fa2658c536caaf0b`
before and after the build, uses `--pull=false`, build network none, and never
publishes ports. It validates the existing development PostgreSQL container,
volume, internal network, database, local socket and migration ledger. Only the
app joins the existing development PG network. The verifier has no PG secret.
Only the existing application-role password is runtime-mounted, never printed;
the harness never opens protected auth source or secret files on the host.

SQLite is a fresh UID-1000-owned persistent volume with a fixed required path.
There is no in-memory fallback. PostgreSQL uses the application role, at most
four connections, four-second connection/statement timeouts and five-second
query/idle-transaction limits. Administrative fixture commands are bounded by
statement/lock/client timeouts. Requests have five-second deadlines; the verifier
has a two-minute deadline and its Docker client has a four-minute bound.
Build/readiness operations and each cleanup/recovery operation are also bounded.
SIGINT/SIGTERM stop forward progress and enter cleanup; SIGKILL/host loss require
the already-written scoped recovery command.

## Gates and acceptance

Before invitation provisioning, require the actual framework health request,
application role, schema readiness, anonymous private read 401, session lookup
null, and fresh SQLite containing exactly one known unassigned synthetic legacy
sentinel and zero private rows. Both readiness and verifier must emit their
allowlisted completion record and exit zero. The launcher must remain running
without OOM before provisioning.

After provisioning two one-hour synthetic invitations, use the real auth HTTP
endpoints to accept each invitation, login, obtain genuine signed session
cookies and resolve two distinct session users. Registration must issue no
session. Cookie assertions require the `__Host-` name, Secure, HttpOnly,
SameSite=Lax, Path=/ and no Domain. Signed cookies remain only in verifier memory.

Expected cases:

| Case | Expected |
| --- | --- |
| Invited registration and login | 200; session identifies the invited user |
| Own create/list/detail/raw/status | 201/200; correct private row and count |
| Cross-owner detail/raw/delete | 404; other inbox unchanged |
| Legacy-unassigned detail/raw/delete | 404; absent from lists/search; retained |
| Anonymous, malformed cookie or forged identity headers | 401 |
| Missing/foreign mutation Origin or same-site fetch metadata | 403; no mutation |
| Own delete/clear | 200; other inbox and legacy sentinel preserved |
| Logout and replay of original signed cookie | logout 200; session null; APIs 401 |

The read-only SQLite inspector reads only id/inbox_id metadata in this fresh
synthetic volume. Evidence retains fixed allowlisted check names/statuses and
sanitized failure categories, never response bodies, cookies or fixture passwords.
No SMTP/SMS listener, routing fixture or delivery transaction is involved.

## Durable cancellation and recovery

Before invitation writes, the runner flushes a strict per-run UUID manifest and
`cleanup-state.json` containing the exact executable recovery command. This
profile fsyncs the evidence directory after the manifest and atomically replaces
and fsyncs cleanup state before fixture writes. Synthetic
passwords, invitation tokens and signing material are disposable deterministic
test data, not production credentials. The manifest stores only token hashes.

Provisioning uses transaction-scoped advisory lock 74008 and READ COMMITTED;
a separate statement after lock acquisition checks the permanent cancellation
invitation ID before inserting either invitation. Cancellation takes the same
lock, synchronously commits a permanently revoked marker and revokes both
invitation rows atomically. Missing invitations are inserted already revoked.
Recovery checks exact IDs, emails and token hashes before accepting the fence.
Markers and revoked/consumed invitations are never removed.

Registration claims its invitation with an atomic conditional update in the
same transaction as user, private inbox and credential account creation. That
row lock serializes with revocation: if registration wins, cancellation waits
for its commit; if cancellation wins, the revoked claim cannot succeed. A late
provisioning exec sees the committed marker and cannot create invitations.
An additional per-request cancellation check rejects the entire test surface.

After committing cancellation, a second bounded transaction deletes only the
two exact synthetic emails' private inboxes, sessions, accounts and users.
Existing private-inbox foreign keys deliberately prevent deletion if any
unexpected route references one; recovery then remains required, with cancellation
already durable. No SMTP/SMS routes, historical fixtures or tombstones are deleted.
User FK constraints/cascades prevent a delayed login creating an orphan session.
Only owned app/verifier/readiness containers are stopped. Images, containers,
networks, volume and evidence are retained, not removed.

`cleanup_verified` requires a fresh committed read proving the exact cancelled
marker, two revoked invitations and no run users/inboxes, plus the app confirmed
stopped. Otherwise state is `revocation_required`; use the recorded command with
`--private-api --revoke-only <exact-evidence-directory>` after separate authorization.
Recovery revalidates the PG target and container run label and is idempotent.
Never re-run fixture provisioning on retained resources; never delete the claim
or cancellation rows to retry. Shared rate-limit counters are retained, not reset.

## Later authorization and limitations

One separately authorized controlled attempt from WSL:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run-controlled.mjs --private-api
```

Do not run this during preparation. Missing local build dependencies, unavailable
development PG, schema/permission differences, name conflicts, application or
readiness failures stop before invitation provisioning. Cleanup failures are
NO-GO and require the recorded scoped recovery, not another test attempt.

This proves the selected production auth/resolver/API modules through real
framework request context, not the shipped singleton configuration, full UI,
normal route registration or deployment. Internal HTTP and a manually managed
cookie jar verify real cookie signing/attributes/revocation, not browser HTTPS
cookie acceptance or browser navigation. It does not close backup, operational
or other release-readiness gaps, and cannot authorize changing the shipped guard.

Preparation validation: `node --check` passed for the six changed JavaScript
modules; syntax/transpile diagnostics passed for the five new TS/TSX files.
Static YAML/isolation checks and existence checks for all 26 allowlisted build
sources passed. No framework build, full type-resolution check, SQL or acceptance
test was run. Runtime compatibility and actual acceptance remain unverified.
