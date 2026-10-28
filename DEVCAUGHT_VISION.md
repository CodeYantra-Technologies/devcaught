# DevCaught — Product Vision & Roadmap

**North Star:** Catch messages. Trace workflows. Ship with confidence.

## Mission
Help small developers test application communications with a powerful, accessible, open-source platform; give companies a secure, affordable and practical alternative for testing email, SMS and webhooks.

## Product principles
- Keep a useful, powerful self-hosted core free and open-source.
- Differentiate through workflow verification, not simply collecting messages.
- Build trust through privacy, reliability, documentation and reproducible tests.
- Monetize managed hosting, private deployment, upgrades and business support—not artificial limitations of basic testing.
- Favor small, verified increments with approximately two hours of development per day.

## P1 — Fast launch and adoption (current priority)
- Stabilize and secure existing email, SMS and webhook capture.
- Deliver a polished, approachable interface and a compelling GitHub README with screenshots and a clear product story.
- Make Docker setup, examples and documentation straightforward.
- Verify security, access restrictions, resource limits, backups and restore, monitoring and release readiness before public hosting.
- Launch, seek authentic developer feedback and earn stars organically; do not promise outcomes.
- Avoid expanding scope with P2/P3 features before P1 is ready.

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

## Deployment direction (not authorization)
Evaluate Oracle Cloud 1 GB instance for initial low-traffic DevCaught deployment. First measure actual memory and load. Do not remove Hermes until a recoverable backup and an approved retirement plan exist. No production changes without explicit approval.

## Repository safety
Do not access protected `src/lib/auth/preview.ts`; do not touch production paths/services without explicit approval. Preserve existing work and secrets. Current recovery branch contains only the verified SMTP STARTTLS regression fix, not all disposable environment assets.

## Current next step
P1 release-readiness inventory and 1 GB RAM compatibility test in a disposable environment; prioritize safe public launch and clear README/product visuals.

*Project vision agreed 2026-10-28. This file is a portable project reference, not evidence of a repository commit or persistent memory update.*
