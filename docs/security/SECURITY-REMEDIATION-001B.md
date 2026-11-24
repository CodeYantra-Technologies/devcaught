# Security remediation 001B — review findings

Date: 2026-11-24. Branch: `security/codeql-remediation`. No commit, push, merge, or deploy.

This addendum resolves the pre-commit review. It does not restore removed Grok integration and does not weaken fail-closed authentication.

## HTML parser complexity

`packages/parsers/src/htmlText.ts` no longer calls htmlparser2. That library stores open tags at the front of an array. Deep nesting is quadratic because every open is an `unshift`. A matching close uses `indexOf` plus `shift`, so a long run of unmatched closes is also quadratic.

The replacement is one forward scan:

- Input is sliced to `MAX_PARSE_CHARS` (10 Mi characters) before the scan. The caller's raw string is not modified.
- Open tags live in an end-of-array stack capped at `MAX_NESTING_DEPTH` (256). Past that depth an integer overflow counter increments. A close inspects at most 256 stack slots and never rescans the input.
- `work` counts character inspections and those bounded stack probes. It must stay at or below `boundedChars * MAX_PARSE_WORK_FACTOR` (80) and at or below `MAX_PARSE_WORK`.
- Script and style bodies are skipped until their real end tag. Malformed tags, comments, and truncated markup return text instead of throwing.
- `htmlparser2` is no longer a direct dependency of `@devcaught/parsers`. Preview sanitization still uses sanitize-html on its own path.

Adversarial tests cover nested tags, unmatched closes, the size cap, and script/style hiding. They assert the work and depth bounds. Elapsed time is not the pass condition.

## Rate-limit isolation

The Web Request path previously used one 600/minute counter for authentication, capture, private API, and control operations. Six hundred unknown sign-in attempts filled it. Later sign-out and session reads returned 429, including when the auth handler would have failed closed with 503.

Budgets no longer borrow from each other. The ceilings sum to `WEB_AGGREGATE_CEILING` (600), and constructing a larger aggregate throws:

| Budget | Ceiling | Who can spend it |
| --- | ---: | --- |
| authentication | 180 | sign-in, invitation registration, and unknown auth paths |
| capture | 180 | TanStack webhook capture |
| private API | 120 | private inbox routes after the release guard |
| control, no session cookie | 30 | sign-out and get-session without a usable session cookie |
| control, per session | 60 | one hashed `__Host-devcaught-auth.session_token` |
| control, all sessions | 90 | every presented session token combined |

Anonymous authentication cannot spend a session control budget. A missing, short, or foreign cookie cannot either. `X-Forwarded-For` and `Forwarded` are not identities. Express still sets `trust proxy` to false and still keys the separate Express limiter by the socket address, with IPv4-mapped IPv6 folded to IPv4 and other IPv6 grouped by /64. A key-parse failure shares `unknown-peer` instead of skipping the limiter.

The session row above was too wide: any well-formed cookie could spend it. That hole is closed in `SECURITY-REMEDIATION-001C.md`. A cookie string is not a session.

The private-inbox release guard still returns 503 before its limiter and before auth or storage imports. `PRIVATE_INBOX_POSTGRES_VERIFIED` stays false. The auth route returns 503 when auth is disabled or the auth module cannot load, and that return happens before `handleAuthRequest`'s limiter. A genuinely exhausted authentication budget still returns 429 with `Retry-After` and `Cache-Control: no-store`.

Express per-peer limits (120) and local-capture read/write limits (1800 / 600) are unchanged. Health checks still do not consume them.

`SECURITY-REMEDIATION-001C.md` closes the forged-cookie hole that this section originally left open. There is still no trustworthy Web Request peer address, so the limiter does not trust proxy headers. Untrusted control traffic shares one anonymous counter instead of one counter per invented cookie.

## Historical Grok assets

Grok integration stays removed. Nothing in this change restores Grok code, dependencies, or configuration.

Vite's default `publicDir` copies `public/` verbatim into the client build. `public/__grok/` is untracked historical asset data, so a normal build was shipping eight unused files. `scripts/exclude-historical-grok-assets.mjs` deletes only `__grok` directories under build outputs (`.output`, `dist`, `.vercel`, and the configured `outDir`). It refuses to delete `public/__grok` or `.grok`. Those historical files are not deleted and are not in the proposed commit allowlist.

## What this environment did not validate

Security remediation tests and a production build are not authenticated production proof.

Not validated here:

- A deployed process with a real PostgreSQL `DATABASE_URL`, applied auth migrations, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`.
- `VITE_AUTH_ENABLED` left on with a configured sign-in method against that database.
- The HTTP 503 body of a live auth dependency failure other than "the auth module cannot load because `DATABASE_URL` is unset".
- Private inbox authorization with `PRIVATE_INBOX_POSTGRES_VERIFIED` enabled. That flag remains false. Do not flip it in this change.
- Browser sign-in, session cookies issued by Better Auth, or sign-out against a real server.

`src/lib/auth/server.ts` throws while loading if `DATABASE_URL` is unset. The auth route catches that and returns 503. That is fail-closed unavailability, not a successful authentication test. Do not mock a 200 to make the check pass. A future infrastructure run needs the real database and secrets, and it is a separate gate from this code review.
