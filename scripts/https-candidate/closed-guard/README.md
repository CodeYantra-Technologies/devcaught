# Normal closed-guard candidate preparation

These files are preparation only. Context creation, registry review, build/export,
and disposable runtime execution each require the corresponding explicit approval.
Nothing here authorizes HTTPS candidate startup or production deployment.
Existing Dockerfiles, launcher, authorization logic and release guard are unchanged.

## 1. Approve the immutable base and inputs

Choose a maintained official `docker.io/library/node` Node 22 Debian image for the
native Linux architecture. In a separately authorized registry-only review, resolve
the tag to its platform-specific manifest digest, verify the manifest/config hashes,
and record its config `rootfs.diff_ids`, Node version and bundled npm version.
Review the official image's provenance and current security status. Do not approve a
tag alone, guess a digest, or substitute Alpine/musl without a separate review.
No digest has been selected or approved by this tooling.

Create a new, project-external approval JSON, mode 0600, in a user-owned 0700
directory under `~/.local/state/devcaught/closed-guard-builds`. Required exact fields:

| Field | Required value |
| --- | --- |
| schemaVersion | 1 |
| nodeDigest | Reviewed platform manifest `sha256:` digest |
| platform | `linux/amd64` or `linux/arm64`, matching the build host |
| nodeVersion | Reviewed exact Node 22 version, at least 22.13.0 |
| npmVersion | Reviewed exact bundled npm version |
| baseDiffIds | Ordered config `rootfs.diff_ids` array |
| reviewedBy | Reviewer identity |
| reviewedAt | UTC `YYYY-MM-DDTHH:MM:SSZ` |
| registrySource | `docker.io/library/node` |
| approved | true, only after review |

The record is an operator approval, not a cryptographic signature. Preserve the
registry verification evidence separately. Do not put credentials in either record.

After context preparation approval, from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/https-candidate/closed-guard/prepare_context.py \
  --node-approval "$APPROVAL" --output "$CONTEXT"
```

Both variables must be absolute paths. CONTEXT must be new and outside the repository
and temporary directories; its parent must already be private. Preparation never
invokes Docker or npm. New directories/files use 0700/0600, exclusive creation and
fsync. A failed partial context is retained; use a fresh path after investigation.
Run with a quiescent source tree and private parent directory.

`policy.py` is the context specification: exact root/workspace package manifests,
normal Vite/TS config, three explicitly selected build scripts, four source trees,
public assets with approved extensions, and root numbered SQLite migration assets.
Migration assets are bundled as normal build inputs; no migration is executed.
Nested migration directories are excluded. Source/test fixture directories, outputs,
authorization-test inputs, preview.ts, .env*, .devcaught, .npmrc, secret/key/database
filenames are excluded by name before stat/open/hash/copy. Only selected paths are
traversed. Selected symlinks, hardlinks, special files and unreviewed file types fail
closed; excluded paths are never followed. No substitute preview module is created.
If normal compilation needs an excluded file, stop for review; do not relax policy.
Filename policy cannot identify a secret deliberately embedded in an ordinary source
file: reviewed normal source must contain no such data. Never scan secret locations.

## 2. Separately approve the build and image export

Review the prepared manifest and literal false guard, context specification, recipe,
unchanged launcher hash and dependency lockfile. Retain the manifest and its SHA-256.
The recipe uses only the approved digest for both stages. Installation uses `npm ci
--ignore-scripts` with public-registry lockfile resolutions and integrity metadata.
Compilation uses direct normal Vite, a cleared environment and `RUN --network=none`;
it does not use `npm run build`, authorization transforms or migration commands.
Only the install step needs registry access. There are no build secrets, SSH mounts
or repository-wide COPY instructions.

After separate build approval, populate these variables from the reviewed manifest
(NODE_DIGEST_HEX excludes the `sha256:` prefix; others match approval exactly).
Use fresh, private paths for IMAGE_ID_FILE and the archive; a unique tag is optional.

```sh
docker build --platform "$PLATFORM" --no-cache --network=none \
  --build-arg NODE_DIGEST="$NODE_DIGEST_HEX" \
  --build-arg EXPECTED_NODE_VERSION="$NODE_VERSION" \
  --build-arg EXPECTED_NPM_VERSION="$NPM_VERSION" \
  --build-arg INPUT_MANIFEST_SHA256="$MANIFEST_SHA256" \
  --iidfile "$IMAGE_ID_FILE" --file "$CONTEXT/Dockerfile" "$CONTEXT"
```

Use BuildKit; the recipe explicitly enables networking only for installation. Check
that the selected official base has no unexpected hooks/configuration. Do not pass
extra build arguments, alternative targets, credentials or additional contexts.
Preserve the build command, sanitized exit/stage record, recipe/context hashes,
builder identity/version, approved base record and resulting immutable image ID.
Raw build logs are private and must be reviewed/redacted before sharing; they can
contain compiler source excerpts. Do not export dependency or compile stages.

After separately authorized single-image Docker-save export (private uncompressed
archive, <=2 GiB), verify offline:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/https-candidate/closed-guard/verify_image.py \
  --context "$CONTEXT" --archive "$ARCHIVE" --image-id "$IMAGE_ID" --report "$REPORT"
```

The checker does not run Docker, extract files, evaluate compiled modules or print
source. It checks config/image identity, ordered layer hashes/base layers, input
manifest/labels, selected runtime configuration, unchanged embedded launcher and a
nonempty server entry. Only classic uncompressed Docker-save layer format is
supported. Unsupported/ambiguous archives produce NOT_VERIFIED. Keep archive and
report private; an existing report cannot be overwritten.

LOCAL_CONSISTENCY_VERIFIED is not independent attestation that Vite produced those
bytes. An operator must review build execution evidence. Source false plus immutable
inputs is source/build evidence; compiled control flow remains NOT_VERIFIED.

## 3. Separately approve disposable runtime checks

Only after provenance and build execution review, use a fresh external evidence path:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/https-candidate/closed-guard/check_runtime.py \
  --image-id "$IMAGE_ID" --provenance-report "$REPORT" \
  --evidence-dir "$RUNTIME_EVIDENCE" --confirm-runtime-check "$IMAGE_ID"
```

This command WILL create/start a new uniquely named container, and requires explicit
runtime approval covering its bounded stop/removal policy. It accepts only a local
Unix-socket Docker endpoint and an existing immutable image; it never pulls/builds.
It uses network=none, no published ports, read-only rootfs, resource/time limits,
tmpfs SQLite/temp storage and newly generated synthetic runtime credentials. No
existing secrets, volumes or databases are mounted. PostgreSQL resolves to loopback
inside that isolated container; no PostgreSQL service is supplied. The unchanged
launcher starts as root for setup and launches the application as uid/gid 1000.
Readiness failure, including any PostgreSQL dependency, is BLOCKED; no DB fallback.
The normal application may initialize its fresh ephemeral SQLite storage at startup;
there is no migration command and no access to any existing database. If even this
fresh-storage initialization is not authorized, do not approve runtime execution.

The probe checks GET list/detail/raw/status, DELETE detail, POST clear/test using a
synthetic ID, anonymously, with a malformed cookie and with forged identity headers
(21 requests maximum). A ready server must return the expected bounded error shape
and private/no-store, Vary Cookie and nosniff headers on every route. Unexpected
responses stop probing, and bodies are never printed. No real users or sessions are
created. The test route might write only to disposable storage if authorization is
broken; such a response is FAIL and is not followed by more probes.

PASS means these unauthenticated negative requests were closed. It does not prove
the compiled guard, authenticated closure, HTTPS cookie behavior or production
readiness: an unavailable auth/database dependency can produce the same 503. Keep
compiledGuard=NOT_VERIFIED and authenticatedCoverage=NOT_TESTED in all reports.

Evidence is persisted before teardown. Only the exact newly created container with
matching immutable image/name/run label is stopped. On PASS it is removed and its
two generated credential files are removed; historical resources are never touched.
On failure it is stopped and retained for separate review. Ambiguous creation,
interruption or cleanup failure requires scoped review, never global cleanup.
SIGKILL/host loss cannot guarantee shutdown: consult the durable runtime-state.json.
Logs use driver none; this deliberately avoids collecting application messages or
credentials. Preserve sanitized counts/results and metadata after all outcomes.

## Static validation / stop conditions

Parse only these new Python files with `ast.parse`; use `node --check` on
closure_probe.mjs. Missing-argument CLI checks may run with
PYTHONDONTWRITEBYTECODE=1; they exit before reading inputs or contacting Docker.
Do not run the preparer, verifier against real artifacts, or runtime checker as a
static test. No custom compiled control-flow analysis is provided.

Stop on unapproved/mismatched digest, changed or missing inputs, excluded-file import,
native dependency failure with lifecycle scripts disabled, build-time network need,
missing native module in output, unsupported archive, provenance ambiguity, readiness
failure, any unexpected route response, or unverified teardown. Do not add install
scripts, auth transformations, DB access or weaker checks as automatic fallbacks.

Next gate: review and approve the actual immutable Node base record, then authorize
context preparation only. Build/export and runtime execution remain separate gates.
