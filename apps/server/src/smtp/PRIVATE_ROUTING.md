Trusted SMTP private routing (not activated)
============================================

DEVCAUGHT_SMTP_ROUTING_MODE=private is an explicit server-side opt-in. Unset/empty
retains the existing receiver invocation, which currently rejects RCPT with 451
because no resolver is provided. This change does not introduce public root
delivery or change that existing behavior. Unknown nonempty modes fail startup.
No Compose configuration or release guard is changed by this implementation.

Private mode requires persistent SQLite and a PostgreSQL DATABASE_URL using
devcaught_auth_app. It has no PGLite or root-ingestion fallback. The independent
pool never imports authentication bootstrap. Each lookup verifies current_user
and uses BEGIN READ ONLY plus the existing lookupSmtpInbox helper. The role needs
SELECT on smtp_inbox_route and private_inbox; it receives no write grants here.
Connection/query timeouts are bounded. Lookup failures produce generic SMTP 451.
No credentials, query errors, raw messages or customer values are logged.

Only SMTP envelope recipients reach the registry lookup. Canonical invalid,
unknown, revoked or ambiguous recipients reject with 550 at RCPT. All accepted
recipients must still resolve to one unchanged inbox when DATA begins; mixed
inboxes reject the whole DATA transaction. After receiving and parsing DATA, the
receiver revalidates every recipient again immediately before synchronous scoped
insertion. A late revocation/change/failure returns 451 and stores nothing.
Different aliases to the same inbox result in one message. MIME To/Cc/From fields
remain display metadata and never affect routing.

Scoped services use store.forInbox and per-inbox retention. In private mode,
boot-time root pruning and root-service pruning are suppressed so optional global
retention cannot remove private or legacy messages across inboxes. Legacy rows
remain unassigned; no copy or backfill is performed. Twilio routing is unchanged.

Remaining risks before activation:

- A registry lookup is a point-in-time decision. Revocation committed after the
  last lookup but before the synchronous SQLite insert can still race delivery;
  PostgreSQL and SQLite do not share a transaction. This is not strict atomic
  revocation and requires an agreed delivery/revocation boundary before release.
- SMTP retry after uncertain acknowledgement can duplicate mail; no idempotency
  protocol is added here.
- SMTP AUTH/TLS and sender/domain entitlement controls are unchanged. Knowledge
  of a registered recipient is not sender authentication; approved network and
  anti-abuse controls remain necessary before exposing ingestion.
- Focused embedded fixtures verify registry/receiver wiring and role rejection,
  not a real PostgreSQL SMTP end-to-end integration. Existing real registry
  verification is not repeated by this task.

Do not enable this mode or rebuild/restart containers until separately approved.
The private HTTP API still returns 503 under the unchanged normal release guard.
