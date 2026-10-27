# Durable private API acceptance evidence

Only `--private-api` uses this storage. SMTP/SMS paths and claims are unchanged.
Default: `$HOME/.local/state/devcaught/private-api-acceptance`.
Override with an absolute `DEVCAUGHT_PRIVATE_API_EVIDENCE_DIR` outside the project,
`/tmp` and `/var/tmp`; use the same override for run, status and recovery.
Do not use an ephemeral filesystem. Symlinked storage and storage roots owned by
another user or accessible to group/others are rejected. New storage directories
are 0700; metadata, manifests, claims and sanitized records are 0600. Copied build
sources remain behind private directories. The existing verifier expects UID 1000;
run with the intended WSL user so it can read the private manifest.

Each new attempt gets a unique `run-*` directory. No history is deleted.
`manifest.json` is the existing validated synthetic fixture manifest (including
hashes, never raw tokens). `run.json` schema version 1 contains:

- profile, run UUID, absolute evidence directory and dedicated resource identifiers;
- synthetic emails, invitation IDs, cancellation ID/email and legacy SQLite ID;
- execution phase, cleanup status, acceptance result and completion flag;
- manifest filename and a shell-quoted, run-scoped recovery command.

The runner persists the manifest, run metadata and `latest.json` before any Docker
operation. It creates and fsyncs a persistent root-level `attempt.claim` before
building or provisioning. Only the explicit guarded release command described
below permits a retry after an eligible completed build failure; never remove
claims manually or bypass reconciliation. The `revocation_required`
cleanup state and run metadata are persisted before provisioning can begin.
Critical JSON updates use exclusive temporary files, file flush/fsync, atomic
rename and parent directory fsync. Unique run-directory creation and new storage
parents are also synced. Storage failures abort progress; incomplete metadata
cannot establish acceptance. Filesystems and hardware must honor fsync/rename.
No credentials, cookies, raw invitation tokens, message bodies or customer records
are added to metadata. Existing sanitized verifier/diagnostic filtering remains.

Read-only status (does not create the storage directory):

```
node scripts/private-api-acceptance/status.mjs
```

Status reads only local evidence. It never imports the runner or launches a
subprocess. Missing, malformed, mismatched or incomplete evidence yields UNKNOWN;
PASS requires completed metadata, all required verifier checks, completion records,
no recorded failures and matching verified cleanup state. An intact failed run
reports FAIL, or BLOCKED when cleanup requires recovery. Cleanup and recovery
metadata availability are reported independently. This is historical evidence,
not a live database or Docker health assertion. A missing latest pointer yields
UNKNOWN; retained run directories and the retained claim still preserve run IDs.

For recovery, first review the retained run metadata and target ownership. The
stored command invokes the existing explicit `--revoke-only` path, using the exact
validated manifest. It does not rerun acceptance or infer fixtures by prefix.
Durable directories must belong to the configured evidence root. Existing legacy
`/tmp/devcaught-private-api-2j2-*` recovery directories remain supported if present.
Never reconstruct the lost historical run UUID from the directory suffix.
Recovery does not upgrade acceptance to PASS; its diagnostics remain separate.

This change cannot recover the lost Task 2J.2 UUID or prove its database cleanup.
Production activation remains NO-GO until separately established acceptance and
cleanup requirements are met. No runtime acceptance is performed by these changes.


## Completed build-failure claim release

`release-claim.mjs` is a separate operator command. It never invokes acceptance,
recovery, SQL, builds, or Docker mutations. It accepts an explicit `--run` UUID,
an absolute `--evidence-dir`, and exactly one of `--dry-run` or
`--confirm-release <same-UUID>`. Use the same evidence-root override as the run.

Eligibility is intentionally narrow: a matching validated manifest, claim, run
metadata, resources and recovery instructions; `completed=true`, `phase=complete`,
`acceptance=FAIL`, cleanup `unknown` with state `not_provisioned`; recorded normal
preflight passes and a nonzero build child exit. Signals, timeouts, missing or
inconsistent records, later-stage diagnostics, readiness/verification/recovery
artifacts, application observations or image completion records all block release.
Expired invitations or a generic UNKNOWN result do not qualify.

The command requires Linux, an unrestricted visible `/proc` in the original WSL
process namespace, local Docker configuration, successful read-only Docker
inventories, and no active private-API operation or dedicated resource. Missing
permissions, unreadable relevant processes, hidden process visibility, remote
Docker contexts, timeouts and inventory errors block release. It checks the three
exact container names, named volume/network, acceptance image tag, and Compose
project labels. It never removes resources to satisfy these checks.

The updated private-API acceptance runner (including recovery) and release command
hold the same nonblocking kernel flock from before evidence mutation until process
exit. Its file is `$HOME/.local/state/devcaught/private-api-acceptance.lock`, shared
across configurable evidence roots; do not delete, rename or replace this file.
SMTP/SMS execution is unchanged. Use the updated runner in the same WSL user and
namespace. Do not run manual resource operations or old uncoordinated runner copies
concurrently; inventory cannot prevent unrelated actors from creating resources.
Kernel locks disappear on process exit, so there is no stale PID lock to remove.

Dry-run acquires coordination and may create the private coordination directory
and lock file; it never changes claims, archives or historical run evidence.
Actual release requires the explicit matching-UUID confirmation argument. It
creates a uniquely named exclusive 0600 claim archive and a durable `prepared`
release record in the root's private `claim-releases/` directory. Archive bytes
and release intent are fsynced before removal of the root claim. Processes,
resources and unchanged file identities/contents are rechecked immediately before
unlink. The root directory is fsynced, then the release record is atomically
updated to `released` and fsynced. Archives never overwrite earlier archives.
Run evidence, latest pointers and acceptance results remain unchanged.

A crash/I/O error may leave an archive and `prepared` record, with the live claim
present or absent. Stop and inspect that record; do not infer successful release
from a missing claim or blindly retry after an error. Storage must honor fsync and
atomic rename. Owned private canonical directories and no-follow regular-file
opens reject symlinks, traversal, unexpected hard links and oversized metadata.
This does not defend against malicious filesystem changes by the same OS user.

Offline validation:

```
node --test scripts/private-api-acceptance/claim-release.test.mjs
```

These bounded tests validate pure eligibility/argument refusal cases and static
coordination/durability ordering. They never execute the release action, Docker,
process inventories, acceptance, or recovery. Live locking and Docker integration
remain unverified until a separately approved operator dry-run.
