# Security remediation 001C — session control budgets

Date: 2026-11-24. Branch: `security/codeql-remediation`. No commit, push, merge, or deploy.

A syntactically valid `__Host-devcaught-auth.session_token` is not a session. Remediation 001B let every well-formed value spend the shared 90/minute session-control budget and occupy one of 256 session keys. This change closes that hole without raising the 600/minute aggregate and without a database lookup in the limiter.

## Control admission

Sign-out and get-session still have their own ceilings. The limiter reads the cookie header only after the 8192-character cap. It then does one local HMAC-SHA256 check, the same construction Better Auth uses for signed cookies (`token` + `.` + standard base64 signature of 44 characters). The key is `BETTER_AUTH_SECRET` when the budget object does not receive an explicit secret. The limiter does not import `src/lib/auth/server.ts`.

| Presented cookie | Budget |
| --- | --- |
| Missing, foreign, short, unsigned, or bad signature | anonymous control, 30/minute, one key |
| HMAC matches the configured secret | that session, 60/minute, inside a 90/minute total and 256 keys |
| Any cookie when the secret is missing or blank | anonymous control only |

Forged values never create session-map entries, so distinct cookies cannot grow memory. A missing secret fails closed onto the anonymous ceiling. Authentication, capture, and the private API still do not share these counters. `X-Forwarded-For` and `Forwarded` are still ignored. Express `trust proxy` stays false. An exhausted budget is still 429 with `Retry-After`. A handler failure is still 503. The auth route still returns 503 before the limiter when the auth module cannot load. `PRIVATE_INBOX_POSTGRES_VERIFIED` stays false, and the private-inbox guard still runs before its limiter.

The HMAC runs only for control requests that already fit the header bound. It is not a session-table read. The auth handler, which can touch PostgreSQL, still runs after admission.

## HTML parser and preview sanitizer

`packages/parsers/src/htmlText.ts` remains a bounded forward scan. Work stays within `boundedChars * MAX_PARSE_WORK_FACTOR` (80) and `MAX_PARSE_WORK`. Nesting stays within 256. The raw string is sliced, not mutated. `htmlToText` is detection text. `sanitizeEmailHtml` is the preview path and still removes script markup on its own. Extracted text can contain the characters of an escaped tag; that string is not the preview.

## Historical Grok copies

No Grok integration is restored. `scripts/exclude-historical-grok-assets.mjs` still deletes only `__grok` directories under build outputs. It refuses `public/`, `.grok/`, and any output whose real path leaves the workspace. It does not walk symbolic links. A link named `__grok`, a linked child of a copied directory, or an output path that points outside the workspace cannot delete the link target.

## What this environment did not validate

Same boundary as 001B. These tests do not prove a deployed PostgreSQL auth database, a live `BETTER_AUTH_SECRET`, or browser sign-in. Do not treat a 503 from a missing `DATABASE_URL` as a successful login.
