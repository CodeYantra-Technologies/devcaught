Opt-in private Twilio inbound SMS
================================

Prepared in Task 2I.2; no Docker or real-provider integration was executed.

Configuration (read only at application runtime):

- DEVCAUGHT_SMS_ROUTING_MODE=private explicitly enables private SMS routing.
  Unset/empty preserves the existing legacy handler. Other values fail startup.
- TWILIO_ACCOUNT_SID must be the configured account associated with the configured
  TWILIO_AUTH_TOKEN; the account SID is compared exactly, including case.
- TWILIO_PUBLIC_URL retains its existing exact external HTTPS callback contract.
- DEVCAUGHT_DB_PATH must identify persistent SQLite. Private SMS forces persistent
  opening regardless of DEVCAUGHT_REQUIRE_PERSISTENT_DB; no memory fallback.
- DATABASE_URL must configure PostgreSQL as devcaught_auth_app. A bounded lazy pool
  is created without importing auth bootstrap. Each lookup verifies current_user
  inside an explicitly read-only transaction. Connectivity is established on lookup;
  failure produces 503 rather than a fallback write or success acknowledgement.

The dedicated Express handler is /api/webhooks/twilio on the ingestion HTTP
listener (8025 by default). The port-3000 generic webhook routes remain denied;
this change does not publish a new dashboard endpoint or activate private APIs.
Do not change the release guard to enable ingestion.

Authentication and write flow:

1. Existing bounded raw-body middleware and exact Twilio form/JSON signature
   verification remain in place. JSON also requires the existing body hash check.
2. After verification, reject repeated form parameters or repeated top-level JSON
   properties (including escaped spellings). Require scalar AccountSid, To, From,
   Body and MessageSid; require a full stable SM/MM message SID. If SmsMessageSid
   is supplied it must match MessageSid exactly. Never use a fallback fingerprint
   for private messages. Status-only callbacks, errors and non-received statuses
   are explicitly rejected; a normal full inbound form may carry SmsStatus=received.
3. Canonicalize original To to an international E.164-shaped destination before
   normalization masks it. Bind AccountSid to the configured signed account through
   authenticateSmsRoutingAccount. Provider is fixed to twilio, never caller-selected.
4. Resolve exactly one active registry entry by provider/account/destination through
   lookupSmsInbox. Account, owner and inbox claims supplied by callers do not select
   the storage scope. Unknown, revoked and ambiguous results store nothing.
5. Persist only with InboxService(store.forInbox(resolvedInboxId)).ingestSms and
   await completion. The stored normalized event is marked verification=valid.
   Account-namespaced stable keys and the existing inbox-scoped unique index collapse
   retries without returning another account/inbox's duplicate ID. Routing is checked
   before dedupe, including retries received after revocation.

Responses are deliberately generic:

- 200: scoped persistence or an authenticated, currently routable duplicate.
- 400: malformed/ambiguous identity, invalid destination/ID or unsupported status event.
- 403: missing/invalid signature, JSON integrity failure or account mismatch.
- 404: no unique active route (unknown, revoked or ambiguous).
- 503: private dependency/configuration unavailable, database failure, wrong DB role
  or scoped persistence failure. Startup configuration errors normally prevent the
  runtime from being created at all.
- Existing 413/415 middleware/content-type failures remain unchanged.

No exception details, connection configuration or raw provider payload are emitted.
Routing uses the original signed destination only transiently; the normalized view
keeps the existing masking rules. With private SMS disabled, legacy persistence,
dedupe keys, status parsing and verification metadata retain their existing behavior.

Any private ingestion mode disables both boot-time global retention and pruning
triggered by the root InboxService. Explicit retention in a scoped service affects
only that inbox. The SMS pool closes through the existing runtime SMTP-close
lifecycle, including initialization failures; SMTP routing itself is unchanged.

Verification is offline: the new tests use signed synthetic payloads, an in-memory
PGlite routing registry, fresh SQLite storage and an in-memory Express transport.
Runtime tests mock SMTP binding; no SMTP connection or message is sent. Existing
loopback HTTP tests require a host environment that permits local socket binding.

Remaining boundaries / STOP conditions:

- No real Twilio, Docker or external PostgreSQL integration is established by these
  tests. Do not execute that integration without separate authorization.
- Delivery-status routing and multi-account credential selection are not implemented.
- PostgreSQL lookup and SQLite persistence are not atomic against concurrent route
  revocation. Stop if a strict cross-database atomic revocation guarantee is required.
- Replay collapse depends on the retained scoped dedupe row. Deleting or pruning it
  can permit a previously signed message to be stored again; no timestamp/nonce
  replay window is introduced.
- Missing configuration, malformed identities, unavailable/revoked routes and
  database/storage failures must never be repaired by root, memory or embedded
  registry fallback, automatic provisioning, or weakening a release guard.
- PRIVATE_INBOX_POSTGRES_VERIFIED remains false. Migration schema, existing routing
  tombstones, protected auth source and SMTP integration evidence are unchanged.
