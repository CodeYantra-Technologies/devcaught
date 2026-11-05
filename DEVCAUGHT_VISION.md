# DevCaught — Product Vision & Roadmap

**North Star:** Catch messages. Trace workflows. Ship with confidence.

## Current release scope — v0.2 Local Development Preview

DevCaught v0.2 is a local-first developer inbox for capturing test email over
loopback SMTP, synthetic SMS, and generic JSON webhooks, then inspecting them in
the Local Inbox. Captured data uses local SQLite storage. Synthetic SMS is not
delivered to a carrier, and generic webhook capture does not verify provider
signatures.

Account authentication, shared accounts, hosted inboxes, PreviewHostBridge and
legacy auth-popup workflows, and PWA installation are deferred to future
hosted/shared work. They are not supported v0.2 capabilities. Production
remains NO-GO.

## Mission
Help developers test application communications locally with an accessible,
open-source inbox for email, synthetic SMS, and generic webhook events. Hosted
and shared use may be considered in a future release after separate planning
and verification.

## Product principles
- Keep a useful, powerful self-hosted core free and open-source.
- Differentiate through workflow verification, not simply collecting messages.
- Build trust through privacy, reliability, documentation and reproducible tests.
- Monetize managed hosting, private deployment, upgrades and business support—not artificial limitations of basic testing.
- Favor small, verified increments with approximately two hours of development per day.

## P1 — Local preview (current priority)
- Keep local email, synthetic SMS, and generic webhook capture clear and testable.
- Make the Local Inbox, local setup, examples, and documentation straightforward.
- Verify loopback restrictions, local storage isolation, and focused tests for the preview.
- Gather developer feedback on local-development workflows.
- Keep hosted service readiness and production deployment outside v0.2.

## P2 — FlowTrace differentiation
- Correlate email, SMS and webhook events by test session/correlation ID.
- Add assertions, timeout/order checks, failure diagnosis and CI-friendly test results.
- Offer privacy-safe, exportable testing evidence.

## P3 — Corporate-grade offering
- Team/project isolation, role-based permissions, retention policies and audit logs.
- Private deployments, managed hosting, upgrades, support and appropriate identity/compliance capabilities.
- Validate customer demand and operating costs before pricing.

## Execution cadence
Daily 120-minute sprint: 15 minutes plan, 60 minutes build, 30 minutes test, 15 minutes record.
Maintain small milestones, evidence-based verification and clear release blockers.

## Hosted/shared release direction (deferred; not authorization)

No hosting provider, deployment target, or production deployment steps are part
of v0.2. Any future hosted/shared release requires a separate plan and explicit
approval. Existing production services remain out of scope. Production remains
NO-GO.

## Repository safety
Do not access protected `src/lib/auth/preview.ts`; do not touch production paths/services without explicit approval. Preserve existing work and secrets. Current recovery branch contains only the verified SMTP STARTTLS regression fix, not all disposable environment assets.

## Current next step

Keep v0.2 documentation and verification scoped to the local-development
preview. Treat hosted/shared capabilities and production readiness as deferred
work requiring separate approval.

*Project vision agreed 2026-10-28. This file is a portable project reference, not evidence of a repository commit or persistent memory update.*
