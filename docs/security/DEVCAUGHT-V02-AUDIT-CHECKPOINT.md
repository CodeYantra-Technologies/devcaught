# DevCaught V0.2 — Security Audit Checkpoint

> **Historical checkpoint (2026-10-31):** Findings, configuration descriptions,
> and pending items below record the repository state at that date. They are not
> current setup instructions. For current v0.2 local-preview behavior, use the
> README. This note does not change the production NO-GO decision.

Date: 2026-10-31
Branch: fix/devcaught-v02-security-audit
Production decision: NO-GO

## Verified local commits

- d8aa43f — Upgrade Better Auth to 1.7.14 and adapt user provisioning API.
- c12727c — Patch vulnerable transitive dependencies.
- da25084 — Restrict dev-only /__app-env response to VITE_AUTH_ENABLED.

## Verification evidence

- TypeScript check: PASS.
- Authentication tests: 31/31 PASS.
- App-env and auth-invariant unit tests: 12/12 PASS.
- Git diff integrity checks: PASS.
- npm audit after non-forced fixes: 14 Moderate reported; no Critical or High reported.

## Dev server network assessment

- Vite configured for 0.0.0.0:8080; documented contract must not be changed casually.
- No process was listening on WSL TCP port 8080 during inspection.
- Installed Vite 8.3.5 host validation accepts IP-address Host headers.
- Unknown DNS hostnames are rejected unless explicitly allowed.
- Actual LAN accessibility, Windows firewall behavior and WSL forwarding remain unverified.
- /__app-env previously returned the full resolved Vite environment object.
- Endpoint now returns only VITE_AUTH_ENABLED; regression test passes.
- No confirmed real-secret disclosure was established.

## Pending verification

1. Live dev-server authentication invariant comparison.
2. Safe Vite build compatibility check without database migration.
3. Real PostgreSQL invitation concurrency verification.
4. Remaining Moderate dependency advisory review.
5. Dev-server LAN exposure and firewall assessment.
6. Broader application-level security audit.

## Restrictions

- Production remains NO-GO.
- Do not bypass PRIVATE_INBOX_POSTGRES_VERIFIED=false.
- No deployment, migration, merge or push without separate authorization.
- Do not run npm audit fix --force.
- Preserve the documented dev-server host/port contract pending review.
