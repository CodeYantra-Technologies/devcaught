Isolated real SMTP integration harness — execution awaits approval
=================================================================

For the fresh Task 2H.27 execution, use [CONTROLLED_INTEGRATION.md](CONTROLLED_INTEGRATION.md)
and run-controlled.mjs. It gates fixture creation on readiness of the real launcher,
uses a fresh namespace, and includes scoped interruption/revocation recovery. The
original commands below describe historical attempts and must not be replayed.

The separately prepared SMS profile is documented in [SMS_INTEGRATION.md](SMS_INTEGRATION.md).
It uses --sms with fresh resources and a signed-404 gate; it does not rerun SMTP tests.

After explicit execution approval, run once from the normal WSL terminal:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run.mjs
```

Do not execute this command as part of harness implementation. It requires Docker,
Compose, Node >=22.13, and the existing dedicated PostgreSQL development target.
It refuses existing test resource/image names and any existing test-project
containers, networks or volumes. It never starts/restarts/recreates either the
original application, candidate, or shared PostgreSQL container.

Resources: project devcaught-smtp-integration; image
devcaught:smtp-routing-integration plus its normal-build base tag; containers
devcaught-smtp-routing-test and devcaught-smtp-routing-verifier; SQLite volume
devcaught_smtp_routing_test_data; internal network devcaught_smtp_routing_test_net.
Only the test application joins external devcaught_pg_dev_net. No ports are
published. The verifier mounts only the fresh test volume read-only and receives
no credentials or PostgreSQL network access. Root/unassigned row counts must be
zero after each successful or rejected test transaction.

The normal Dockerfile builds the web application with DATABASE_URL unset. A
separate test-only image bundles the existing standalone ingestion entry point
using a dedicated Vite library configuration; package dependencies are copied from its builder. The launcher
runs only the web entry point as UID/GID 1000. Its existing Nitro startup plugin
owns SMTP and ingestion HTTP. Only this service enables private SMTP.
The normal false private API release guard is checked before building and tested
through HTTP for list/status/detail/raw/delete/test/clear. No candidate capability
or source substitution is used.

The two existing SQLite TS2352 casts are not modified. npm run build uses Vite,
not tsc; the standalone bundle also transpiles without type checking. Actual image build success
is not assumed and must be recorded during execution. The runner stops before
fixture provisioning if either image build fails.

Credential handling: the existing external app_password and better_auth_secret
are mounted read-only into the test application only. Its launcher consumes them
inside the container, constructs DATABASE_URL in memory and passes it only via
child environment. No values are copied into source, image layers, CLI arguments,
evidence or logs. The orchestrator never opens secret files. PostgreSQL fixture
administration uses docker exec psql through the existing local Unix socket,
with SET LOCAL ROLE devcaught_auth_owner; no password or owner credential is read.

Before provisioning, the runner verifies exact container name, Compose labels,
healthy PostgreSQL 16 state, dedicated volume, internal network, database name
devcaught_auth_dev, ledger 0001–0004, and absence of generated fixture identifiers.
Fresh UUID-based owners/inboxes and *.integration.invalid destinations are created
atomically. Users have no password accounts or sessions. A local-only manifest
records exclusively synthetic IDs. Duplicate ownership is tested inside a rolled
back transaction; genuinely ambiguous committed rows are impossible under the
verified primary key and are never injected by weakening shared constraints.

IMPORTANT: fixtures are committed so separate SMTP connections can resolve them.
They are permanent. Immutability triggers forbid deleting assignments or changing
ownership; revocation creates permanent tombstones. The runner revokes all its
active routes afterward but retains synthetic users, inboxes and routing records.
It never claims complete fixture deletion. If interrupted, use the retained
manifest for scoped revocation; never disable triggers or delete shared records.

Tests use real SMTP sockets: two owners, spoofed MIME headers, same-owner aliases,
unknown/revoked destinations and cross-owner envelopes. A proxy inside only the
new test container routes that application's PostgreSQL traffic. A filesystem
socket accessible through only the fresh test volume allows the verifier to cut
existing proxy connections and reject new ones. RCPT and DATA failures must
return 451 and preserve SQLite counts; recovery must deliver. The proxy never
interrupts PostgreSQL, changes shared networks, or affects another application.

The verifier reads synthetic SQLite rows through node:sqlite in read-only mode,
checking scoped ownership, marker prefixes, counts and no unassigned rows. It
does not mount or query an existing inbox volume. Evidence JSONL contains only
check names and counts. The manifest/evidence directory remains under /tmp with
restrictive host-directory permissions. Raw logs are not collected. The isolated
SQLite volume preserves synthetic messages for review; the verifier container is
removed and only the new test application is stopped in the runner's finalizer.
No volumes, images or networks are deleted. A failed cleanup is reported.

Known remaining risks: final PostgreSQL lookup and synchronous SQLite insertion
are not atomic with concurrent revocation. This harness does not claim to close
that interval. Two identical SMTP submissions currently store two messages; the
test records that behavior without redesigning deduplication. Real provider,
sender authentication and production delivery are outside this harness. SIGKILL
or host loss bypasses finalizers: preserve evidence, stop only the test application
and revoke only manifest routes before proceeding.

Sanitized failure diagnostics (Task 2H.5)
---------------------------------------

No integration rerun is included in this diagnostics repair. The original failed
run's discarded stderr cannot be recovered. A future approved run creates
diagnostics.jsonl immediately as stages execute. verification.jsonl receives a
flushed START before launching the verifier, synchronous verifier substage events,
allowlisted PASS checks/counts and a child-process result even on failure/timeout.
Manifest loading is inside the verifier's protected main function. Stages identify
web/SMTP readiness, SQLite opening/checks, each delivery case, SMTP command phase,
proxy fault control, retries and API guard verification.

Records contain only fixed stage/substage/category enums, bounded exit codes,
allowlisted signals, timeout classification and fixed application process labels.
Error messages, stack traces, exception actual/expected values, command arguments,
stdout noise and unknown JSON fields are never retained. Child stderr is connected
to ignore, not captured, parsed or printed. A failure without a structured verifier
record is still recorded as a child exit/signal/spawn error or timeout with
verifierSubstage=not_started; unparseable interpreter errors are intentionally not
reconstructed from raw stderr.

Exactly one controlled retry (Task 2H.6)
--------------------------------------

After execution approval only:

```sh
cd ~/projects/devcaught && node scripts/smtp-integration/run.mjs --retry-1-of /tmp/devcaught-smtp-integration-3QQba4
```

The original evidence directory/files are only checked for existence; they are
not overwritten. The old test container, SQLite volume, network and image remain
untouched. They cannot be safely reused by this verifier: retained SQLite contents
are unknown and the test requires a fresh empty database; the old launcher also
lacks process diagnostics. A fresh retry namespace avoids deleting evidence.

The retry reuses only the normal base image devcaught:smtp-routing-integration-base,
the public node image, approved external credential mounts and devcaught_pg_dev_net.
It rebuilds the derived test image with repaired diagnostics. New names are project
devcaught-smtp-integration-retry-1, image devcaught:smtp-routing-integration-retry-1,
containers devcaught-smtp-routing-retry-1 and devcaught-smtp-routing-retry-verifier-1,
volume devcaught_smtp_routing_retry_1_data and network devcaught_smtp_routing_retry_1_net.
No old image tag is overwritten. Conflicts stop execution.

After preflight, an exclusive /tmp/devcaught-smtp-integration-3QQba4-retry-1.claim
file reserves this single attempt before builds or fixture creation. Do not remove
it to obtain additional retries. A failure after reservation requires review.
New evidence uses a separate uniquely named /tmp directory.

Old destinations are permanently revoked and cannot be reactivated. The original
synthetic manifest is validated against its exact generated structure. The retry
reuses its two synthetic owners/inboxes and its already-revoked destination,
verifying registry ownership and revoked state before writes. It creates only
three fresh routes: owner A, owner B and an A alias. Those three are revoked
afterward and remain permanent. No new users, inboxes, auth accounts or sessions
are created; no previous route is updated or reactivated. The new SQLite volume
starts empty despite the reused inbox identifiers; no old messages are mounted.

Diagnostics distinguish startup, verifier SMTP command/storage/fault-control
substages, application exits and cleanup. A 451 mismatch during a database-fault
case is identified as that verifier substage; no raw PostgreSQL diagnostic is
collected. Only fixed enums, bounded numeric fields and allowlisted check names
are retained. No credentials, connection strings, message bodies or arbitrary
stderr fields enter diagnostic records. Integration remains unverified until this
single approved execution completes.

Historical harness-only ingestion startup phases (Task 2H.8)
------------------------------------------------

Before the Task 2H.15 single-owner correction, the test image's ingestion child
ran /app/ingestion-bootstrap.mjs. The following describes that earlier path. The
production standalone entry point is unchanged. Its direct-run guard compares
import.meta.url to argv[1]; importing the bundle from the bootstrap does not
trigger its automatic startup. The bootstrap calls ensureRuntime once to observe
runtime_initialization, then explicitly awaits startStandaloneServer. That function
reuses the cached runtime and starts the HTTP listener once; SMTP is not started
twice. Synthetic tests check this guard/caching contract without any real listener.

Structured startupPhase events are module_import, runtime_initialization,
listener_start and ready. The bootstrap reports only allowlisted exceptionName
and errorCode, never messages, stacks, import specifiers or environment contents.
Unknown names/codes become null. Events append synchronously to the existing
process-diagnostics.jsonl; the launcher gives UID 1000 ownership of that generated
diagnostic file only, so startup records survive a rapid child exit. Existing
runner collection and cleanup remain in place. The test Dockerfile includes the
bootstrap and diagnostic helper; the normal Dockerfile and application sources
are unchanged.

SMTP initialization is internal to ensureRuntime, so thrown failures there appear
under runtime_initialization. If it returns a non-running SMTP status instead of
throwing, the bootstrap reports listener_start / SMTP_LISTENER_UNAVAILABLE, without
parsing the raw status error string. HTTP listener failures occur under
listener_start. This cannot reconstruct an error code already discarded by the
receiver/listener; a plain Error without a code remains Error/null. Failures before
the bootstrap itself can load remain visible only through launcher exit diagnostics.
Static syntax/bundle and synthetic diagnostics checks do not establish a successful
real container startup or any SMTP delivery. No integration execution or new fixture
provisioning is authorized by this instrumentation change.

The test launcher durably writes only generated process records to
/app/data/process-diagnostics.jsonl, identifying web versus ingestion and the
first unexpected exit versus the sibling stopped afterward. A requested SIGTERM
or SIGINT is marked cleanup_requested rather than an unexpected application exit.
Before stopping the test application, the runner records only its status/exit-code
metadata; after stopping it copies only that generated diagnostic file from the
new test container and projects it through the same field allowlist. It never
collects Docker logs or private database contents. The retained application-source
file and diagnostics.jsonl separate application failure from later cleanup exit.
The container metadata snapshot is pre-cleanup; launch records explain individual
child exits. If the process diagnostic file is unavailable, that limitation is
reported rather than inferring an application failure from a cleanup exit code.

Cleanup stop and fixture revocation retain independent outcomes. Original cleanup,
permanent fixture tombstones and all resource-isolation boundaries are unchanged.
These diagnostics identify the last reported step and failure category, not raw
error details; pre-entry crashes cannot report an internal verifier substage.
