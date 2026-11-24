# Security remediation 001 — investigation and implementation

Date: 2026-11-24. Branch: `security/codeql-remediation`.

Addendum: `SECURITY-REMEDIATION-001B.md` replaces the shared Web Request
budget and the htmlparser2 extraction path described below. Those two
sections are historical. The aggregate ceiling and fail-closed auth behavior
remain in force.

## Reconciliation and baseline

Fetched `origin/main` and verified it is an ancestor of HEAD; both were
`e270d97ad6730633fdf08d54d518cb4fcdfa1afb`. No merge, rebase, commit, push or
remote update was required. Existing untracked `.grok/` and `public/__grok/`
were left untouched. Installed dependencies were stale from the earlier checkout;
`npm ci --ignore-scripts` under Node 22.23.2 restored the reconciled lockfile.
Before source edits, `npm test` passed: 152 script tests plus one skipped test,
and 196 application tests. Baseline type checking passed.

SMS verification, verified-account routing, production fail-closed policies,
header redaction, local-only capture checks, retention and ownership boundaries
are present. The six earlier branding/title failures belonged to the older
checkout: the reconciled product no longer contains that suite. No branding code,
expectations or tests were changed to obtain passing results.

## Alert mapping

| CodeQL alert | Classification and implementation |
| --- | --- |
| #9 | Confirmed ReDoS: backward trailing-punctuation scan replaces repeated suffix regex matching. URL candidates use structured parsing with HTTP/HTTPS protocol checks and an 8192-character detection bound. |
| #8 | Confirmed ReDoS: whitespace repetitions are separated by mandatory non-whitespace delimiters, eliminating ambiguous adjacent whitespace matching. Existing reference formats remain supported. |
| #7 | Confirmed ReDoS: htmlparser2 tokenizes HTML; repeated incomplete script tags no longer trigger repeated regex scans. |
| #6 | Missing admission control: bounded per-peer and aggregate request budgets run before Express body parsing, guards and signature verification; local capture has separate write/read budgets; Web Request handlers use a bounded shared process budget. |
| #5 | Test-only false positive: array membership was exact equality, not URL substring authorization. Exact expected arrays now express this clearly; deceptive userinfo URLs and unsafe protocols have regression coverage. |
| #4, #3 | Test-only false positives: negative tag assertions were not sanitizers. Tokenizer-based assertions require exactly one pre element and exact decoded payload text, including mixed-case and malformed markup. |
| #2 | Text extraction defect, not demonstrated executable HTML injection: HTML parsing handles script/style end-tag syntax. Output stays plain text. Existing sanitize-html preview boundary is retained and independently tested. |
| #1 | Twilio legacy protocol requires HMAC-SHA1; retained without suppression. Rationale is documented at the call. Timing-safe comparison remains; byte-length validation now safely rejects hostile Unicode signatures. Existing independent SDK-algorithm, tampering, URL and JSON-integrity tests are included in security checks. |

Twilio reference: https://www.twilio.com/docs/usage/security#validating-requests
No security rule is suppressed and no GitHub alert has been dismissed or claimed
closed. In particular the protocol-required HMAC call may remain a CodeQL finding.
A subsequent GitHub scan is required to assess alert closure.

## Input and rate-limit contracts

Detection processes up to 10 Mi characters of corpus/HTML (matching the default
10 MiB SMTP scale); raw capture retention is unchanged. Larger configured SMTP
messages remain capturable, but detection is best effort within that bound.
URLs longer than 8192 characters are omitted from detections, not truncated into
potentially misleading URLs. htmlparser2 was already installed transitively;
it is now an explicit parser-workspace dependency, not a new parsing stack.

Fixed 60-second windows allow 120 Express requests per peer, 600 local capture
writes and 1800 local reads per peer. Local read and write budgets are separate;
health endpoints do not consume them. Each limiter admits at most 12,000 total
requests and stores at most 4096 peer keys per window. At capacity it rejects new
peers instead of evicting active quotas. Rejected requests receive HTTP 429,
integer Retry-After seconds and no-store. Ingestion and persistence do not run.
Windows may allow a double burst at a boundary, as expected for fixed windows.

Express uses the transport socket address, explicitly disables proxy trust,
normalizes IPv4-mapped IPv6, and groups IPv6 peers by /64. Forwarded headers cannot
reset quotas. Local capture still rejects proxies and retains loopback, Host,
Origin, namespace and capability checks. Web Request has no trustworthy socket
identity in its portable API: auth/private API/capture handlers share a 600/minute
process budget rather than accepting attacker-controlled IP headers. This is
conservative admission control, not a distributed per-user quota. A reverse proxy
in front of Express shares its peer budget. No automatic proxy trust is enabled.

SMTP has no HTTP limiter and retains its existing size, routing, isolation and
verification behavior. Real SMS callbacks below budget retain signature checks,
provider URL canonicalization, account binding, dedupe and status semantics.

## Dependency investigation: all 28 Phase A package entries

The earlier checkout reported 28 package entries (7 critical, 8 high, 11 moderate,
2 low). These include advisory propagation through ancestor packages, not 28
independent vulnerabilities. Reconciled main already contained security updates
for 21 entries. Its audit reports only seven moderate development entries from
one minimatch chain. All entries below were compared with the original audit,
original lockfile and reconciled audit; production execution relevance was
reviewed separately from npm installation scope.

| Package | Phase A severity | Relationship | Original install scope | Final locked version(s) at original path | Review/result |
| --- | --- | --- | --- | --- | --- |
| `@better-auth/drizzle-adapter` | low | transitive | production/mixed | 1.7.14 | Already absent after reconciliation. Optional auth adapter; configured application uses Kysely. |
| `@better-auth/kysely-adapter` | low | transitive | production/mixed | 1.7.14 | Already absent after reconciliation. Configured auth adapter; login/session traffic is relevant. |
| `@tanstack/react-start` | critical | direct | production/mixed | 1.169.3 | Already absent after reconciliation. Public rendering and server-function runtime; priority production surface. |
| `@tanstack/react-start-rsc` | critical | transitive | production/mixed | 0.1.64 | Already absent after reconciliation. Framework dependency; production runtime/build path. |
| `@tanstack/react-start-server` | critical | transitive | production/mixed | 1.167.51 | Already absent after reconciliation. Public rendering runtime; priority production surface. |
| `@tanstack/start-plugin-core` | critical | transitive | production/mixed | 1.171.54 | Already absent after reconciliation. Framework build tooling, despite production installation scope. |
| `@tanstack/start-server-core` | critical | transitive | production/mixed | 1.169.44 | Already absent after reconciliation. Public request/server-function runtime; priority production surface. |
| `@typescript-eslint/eslint-plugin` | moderate | transitive | development | 8.74.0 | Removed by this change. Development TypeScript/ESLint dependency; inherits minimatch advisory, not a distinct production flaw. |
| `@typescript-eslint/parser` | moderate | transitive | development | 8.74.0 | Removed by this change. Development TypeScript/ESLint dependency; inherits minimatch advisory, not a distinct production flaw. |
| `@typescript-eslint/type-utils` | moderate | transitive | development | 8.74.0 | Removed by this change. Development TypeScript/ESLint dependency; inherits minimatch advisory, not a distinct production flaw. |
| `@typescript-eslint/typescript-estree` | moderate | transitive | development | 8.74.0 | Removed by this change. Development TypeScript/ESLint dependency; inherits minimatch advisory, not a distinct production flaw. |
| `@typescript-eslint/utils` | moderate | transitive | development | 8.74.0 | Removed by this change. Development TypeScript/ESLint dependency; inherits minimatch advisory, not a distinct production flaw. |
| `better-auth` | critical | direct | production/mixed | 1.7.14 | Already absent after reconciliation. Authentication surface; invitation-only signup and endpoint allowlist remain intact. |
| `body-parser` | high | transitive | production/mixed | 2.4.0 | Already absent after reconciliation. Express body parsing; generic webhook and inbox access guards restrict reachability. |
| `brace-expansion` | high | transitive | development | 1.1.21, 5.1.0 | Already absent after reconciliation. Tooling glob expansion; no capture-body-to-pattern path found. |
| `fast-uri` | high | transitive | production/mixed | 3.1.9 | Already absent after reconciliation. Optional schema-validation dependency; no direct message-to-URI-parser path found. |
| `mailparser` | moderate | direct | production/mixed | 3.10.0 | Already absent after reconciliation. Untrusted SMTP/MIME parsing; priority ingestion surface. |
| `minimatch` | moderate | transitive | development | 11.0.9 | Removed by this change. ESLint TypeScript parser glob preprocessing; no inbound-message-to-glob path found. |
| `nodemailer` | high | direct | root development; transitive production | 10.1.7 | Already absent after reconciliation. Development sender and transitive MIME parsing dependency; preserve SMTP behavior. |
| `proxy-addr` | critical | transitive | production/mixed | 2.0.8 | Already absent after reconciliation. Express address handling; proxy trust stays disabled. |
| `qs` | moderate | transitive | production/mixed | 6.16.1 | Already absent after reconciliation. Express query/body parsing; access guards remain intact. |
| `sanitize-html` | moderate | direct | production/mixed | 2.18.1 | Already absent after reconciliation. Untrusted email preview sanitizer; priority rendering boundary. |
| `seroval` | high | transitive | production/mixed | 1.6.11 | Already absent after reconciliation. Framework serialization for rendering/server functions; production relevant. |
| `smtp-server` | moderate | direct | production/mixed | 3.20.2 | Already absent after reconciliation. Untrusted SMTP ingress; priority ingestion surface. |
| `source-map-js` | high | transitive | production/mixed | 1.2.2 | Already absent after reconciliation. CSS/build tooling; not called with captured message bodies. |
| `typescript-eslint` | moderate | direct | development | 8.74.0 | Removed by this change. Development TypeScript/ESLint dependency; inherits minimatch advisory, not a distinct production flaw. |
| `vite` | high | direct | root development; transitive production | 8.3.5 | Already absent after reconciliation. Development/build tooling; local-listener, CORS and local-inbox guards retained. |
| `zod` | high | direct | production/mixed | 4.6.7 | Already absent after reconciliation. Validation of untrusted inputs; existing request/body limits retained. |

Dependabot PR #1 was reviewed before changes:
https://github.com/CodeYantra-Technologies/devcaught/pull/1
The implementation follows its compatible ancestor update: typescript-eslint
8.72.1 to 8.74.0 (same major), resolving minimatch 10.2.6 to 11.0.9 through upstream
constraints. GHSA-g3hv-75wg-m249 affects >=7.0.0 <11.0.1. No forced override, major
root dependency upgrade, audit fix --force or broad dependency refresh was used.
The existing nf3 override is unchanged. Final npm audit reports zero entries.

## Verification and limits

Verified with Node 22.23.2:

- Configured npm test: 152 script tests passed, one existing OG-skill
  environment test skipped (the skill is not installed); 201 application tests passed.
- Targeted npm run test:security: 100 passed.
- Complete source discovery with test concurrency 2: 366 passed, zero failed,
  cancelled or skipped. Includes private SMTP/SMS and all invitation tests.
- Type checking and final production build passed.
- Final npm audit: zero vulnerable entries (seven moderate before this change;
  28 entries in the older Phase A checkout).
- Git diff --check passed.

The expanded source run exposed an existing aggregate 30-second invitation-suite
deadline: 20 independent PGlite fixtures require about 3–5 seconds each here.
An isolated rerun also cancelled later tests at 30 seconds. Increased only the
aggregate deadline to 180 seconds; no assertions or test cases were removed or
relaxed. The subsequent complete 366-test run passed. The complete source
suite includes tests omitted by the configured npm test list: private inbox,
private SMS/SMTP routing, local capture, Vite CORS, signatures and body rendering.
The production build skips external migrations when DATABASE_URL is unset; this
does not certify the outstanding real-PostgreSQL release readiness requirement.
This change does not alter the existing production NO-GO/release flag.

Rate limits are process-local and reset on restart; multi-instance ingress needs
shared or edge admission control before relying on a global fleet-wide quota.
No new external service, authentication bypass or caller-provided identity is
introduced. A clean npm audit is advisory evidence, not proof of absence of flaws.

## Modified files and reasons

- `packages/parsers/src/{htmlText,linkParser,commerceParser}.ts`: bounded parser-based
  extraction, linear punctuation trimming and unambiguous whitespace matching.
- `packages/parsers/test/{linkParser,security}.test.ts`: exact URL assertions,
  extraction/URL/boundary cases and adversarial child-process deadlines.
- `apps/server/src/http/rate-limit.ts` and `.test.ts`: bounded admission control,
  transport identities, retry behavior, spoofing and valid Twilio capture tests.
- `apps/server/src/http/{app,local-inbox,webhookRequest}.ts`: enforce limits before
  ingestion work; preserve local capability and production access policies.
- `apps/server/src/http/local-inbox.test.ts`: quota/recovery/health and pre-runtime
  rejection checks.
- `src/lib/{auth/http-handler,inbox/private-inbox-api.server}.ts`: shared conservative
  Web Request admission before auth/private inbox work.
- `packages/shared/src/sms/adapters.ts` and signature tests: Twilio compatibility
  rationale, timing-safe byte-length validation and hostile Unicode regression.
- `src/components/local-inbox/LocalInboxBody.test.ts`: assert parsed element structure
  and exact decoded text rather than tag-filter regexes.
- `apps/server/src/ingest/sanitizePreview.test.ts`: independent preview-sanitization
  regression coverage; sanitizer implementation remains unchanged.
- `src/lib/auth/invitation-auth.test.ts`: measured aggregate test deadline correction.
- Root package manifest/lock and parser-workspace manifest: compatible ESLint ancestor
  update, explicit existing tokenizer dependency, repeatable security test command.
- This report: evidence, all 28 dependency classifications, operational limits and
  outstanding scan/release requirements.

## Runtime browser evidence

Used the repository smoke helper with a temporary, untracked harness adaptation
for this environment's actual workspace path and installed `/usr/bin/chromium`;
no repository browser guard was changed. Observed each viewport for ten seconds
and visually inspected both desktop and mobile screenshots.

- Development: real local inbox rendered and settled, no console/page errors and
  no horizontal overflow at 1280x800 or 390x844.
- Built output: rendered a readable private-inbox-unavailable screen on both
  viewports, with no uncaught page error or horizontal overflow. The console
  records a failed HTTP 503 request because private auth is unavailable in this
  unconfigured environment. Consequently the settled production browser smoke
  exits 2; it is not a clean production browser pass.
- Development's local-only dashboard and production's private-inbox route differ
  by design. The initial baseline comparison flags that text difference; it is
  not evidence of equivalent production functionality.
- No external database/auth credentials were invented and
  `PRIVATE_INBOX_POSTGRES_VERIFIED = false` remains unchanged. Fully authenticated
  production runtime verification remains blocked by existing target readiness
  and configuration requirements. Production deployment is not approved.

Screenshots/verdicts are ignored QA artifacts under `screenshots/security-*`.
The QA-only built-output listener is stopped after verification; development
remains running. No deployment or GitHub security scan was triggered.
