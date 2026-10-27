Isolated candidate
==================

Run once from the project root in your normal WSL terminal:

```sh
bash scripts/candidate/setup.sh
```

Requires Docker Compose, Python 3, Node >=22.13 and installed project dependencies.
The command refuses existing candidate resources or image tags. On failure it
leaves only the newly created resources for diagnosis; do not rerun blindly.
No existing application container is stopped, changed or mounted. SQLite starts
empty in devcaught_candidate_inbox. PostgreSQL schema and ledger are unchanged.

Compose uses /dev/null instead of a .env file. Secrets remain in the existing
external directory and are mounted read-only. The root launcher loads them,
initializes ownership of the new SQLite directory, and launches the application
as UID/GID 1000. Secret values are passed only through the child environment.
No credentials are supplied to either image build.

Application URL: http://localhost:3300. Ingestion HTTP: 127.0.0.1:8325;
SMTP: 127.0.0.1:1325. Browser checks must use localhost and a separate browser
profile: cookies are shared across ports on the same hostname. Existing Secure,
HttpOnly session cookies retain the __Host prefix; no cookie security is weakened.
The automated HTTP checks keep their cookies in memory and never log them;
they check cookie attributes but do not replace a browser cookie acceptance check.

Verification uses only the app credential, checks the intended PostgreSQL role
and database plus readiness in a read-only transaction, then creates two uniquely
named invitation-only development accounts through the candidate HTTP API.
It checks repeated authenticated sessions, distinct ownership, untrusted-origin
rejection, logout and replay of revoked sessions. Fixture invitations, ownership
and users are removed afterward; auth rate counters may remain. No existing
account or inbox content is read. Error details and HTTP response bodies are not
printed. If fixture cleanup fails, preserve the resources for investigation.

All private message requests must remain 503, including anonymous and
cross-user-shaped requests. This proves the release guard stays closed; it does
not verify active endpoint ownership authorization. That remains blocked until
a separately approved activation test. No cutover or guard change is included.
