Candidate-only authorization verification
========================================

From the normal WSL terminal, run once:

```sh
bash scripts/candidate/run-auth.sh
```

This command recreates only devcaught-local-candidate. It does not operate on
devcaught-local or PostgreSQL containers, apply migrations, inspect existing
SQLite data, or mount an existing SQLite volume. It requires the existing
candidate metadata to match the previous task and refuses an existing
devcaught_candidate_auth_inbox volume or devcaught:candidate-auth-verification
image. On a partial failure, investigate rather than rerunning or deleting data.
Requires Compose supporting !override and !reset.

The separate Dockerfile.auth builds from source and applies an exact-match
transform inside its builder filesystem. It fails if the entire normal release
module or any expected guard statement has drifted. Normal source files and the
normal Dockerfile remain unchanged. Normal builds contain only the constant
false gate; no runtime variable unlocks them. Production session verification,
ownership lookup, per-request readiness, origin checks and scoped SQLite
handlers are preserved verbatim. NODE_ENV remains production for the built
server; the separate application environment must be local-development.

The candidate capability additionally requires explicit enabled opt-in,
BETTER_AUTH_URL and request URL origin exactly http://localhost:3300, port 3300,
and the dedicated synthetic SQLite path. Request cookies or headers cannot
grant the build capability or enable the server opt-in. Authentication still
requires a fresh valid session and ownership from PostgreSQL. Missing conditions
return 503, readiness errors return 503, and invalid sessions return 401.
Activation also requires a server-configured expiry no more than 15 minutes
ahead; the runner grants ten minutes. Requests automatically return 503 after
expiry, including if the terminal or host dies before rollback can run.

The verifier shares the candidate network namespace, requesting localhost:3300
directly rather than spoofing Host or forwarded headers. The database credential
is loaded inside the verifier using the existing restricted secret mount, never
printed or copied into source or image layers. The runner itself checks only
secret-file existence. No secrets are supplied to the build.

Three HTTP phases run: the original normal image with opt-in enabled (503), the
candidate image with opt-in disabled (503), then active candidate authorization.
The active phase provisions two unique @example.invalid accounts through the
invitation API and posts unmistakably marked SYNTHETIC-DEVCAUGHT-AUTH-TEST mail.
It tests list/search/detail/raw/delete/count/clear scoping, cross-user message
IDs, anonymous/malformed/expired/revoked sessions, invalid IDs and origin rejection.
Only this run's session expiry is edited; schema and migration records are not.
No database passwords, session cookies, fixture payloads or existing data are
logged. Auth rate counters may remain.

Cleanup clears each fixture inbox through its authenticated API and deletes only
the new account, ownership and invitation rows. Failures produce a nonzero result;
if cleanup fails, preserve the isolated test volume and fixture rows for diagnosis.
An EXIT trap recreates only the candidate with opt-in disabled and checks 503
again. If that fails it stops only devcaught-local-candidate. Original images,
all existing SQLite volumes and devcaught-local are preserved. After completion
the candidate uses the new synthetic volume with its capability disabled; no
application cutover is performed. SIGKILL or host failure cannot run shell traps;
in that case close the candidate mode before continuing work.

Static checks do not constitute endpoint verification. PASS requires execution
of the bounded command. Browser cookie acceptance is outside this HTTP test;
use a separate browser profile if inspecting localhost manually.
