Private inbox routing registry (not activated)
=============================================

0004_private_inbox_routing.sql is pending operator approval. It has not been
applied to an application database. Tests execute its DDL only in disposable
in-memory PGLite fixtures. It does not alter SQLite, backfill messages, grant
application writes, wire SMTP/Twilio, or change the release guard.

smtp_inbox_route reserves each canonical SMTP envelope recipient globally.
sms_inbox_route reserves (provider, provider_account_id, canonical destination).
Both reference private_inbox.id with ON DELETE RESTRICT. Active/revoked state
must agree with revoked_at. Triggers prohibit route deletion, key/destination/
inbox/creation-time changes, and reactivation or alteration of revoked tombstones.
The migration also prohibits changing any private_inbox ID or owner_id, including
before routing exists, preventing indirect reassignment and provisioning races.
Normal provisionPrivateInbox's same-owner upsert remains permitted.

SMTP policy is intentionally limited to issued ASCII addresses: trim and
lowercase, bounded local/domain parts, no display names, IDN, quoted local parts
or trailing root dot. Dots and plus tags are not collapsed. Lowercasing the local
part is an explicit policy for controlled DevCaught destination allocation, not
a claim about arbitrary external mailbox equivalence. SMS accepts only trimmed
E.164-shaped +digits; no guessed country codes, formatting, masks or short codes.
Provider account identifiers are case-sensitive. Unsupported inputs throw;
unknown/revoked routes return null; query/configuration errors propagate. Callers
must reject these outcomes without root/unassigned-storage fallback.

Provisioning is operator-only: provide a trusted owner ID and the privileged
provisioning connection. Helpers resolve the owner's existing private inbox
internally; no client-supplied inbox ID is accepted and no HTTP endpoint is added.
Same-owner active duplicates succeed without updates. Conflicts, missing owners
and revoked assignments reject. Primary-key uniqueness plus transactional conflict
checks arbitrate provisioning; FOR UPDATE serializes checks with route revocation.
Revocation is permanent and repeated revocation throws. Schema/table owners remain
trusted administrators who can deliberately change DDL; triggers are not a defense
against a privileged database administrator.

SMS authentication contract
---------------------------

authenticateSmsRoutingAccount is an adapter boundary, not a signature algorithm.
Only trusted server code may call it. configuredAccountId comes from controlled
provider configuration, not a submitted account/inbox header. Its verifier callback
must authenticate the exact request with credentials bound to that account. The
presented account must match before the module issues a frozen, in-process routing
context. Lookups reject forged, cloned and JSON-deserialized contexts.

For Twilio, the future adapter must verify the signature against the configured
public URL and exact form parameters or JSON body hash, using credentials bound
to the configured account, then compare the authenticated AccountSid to that
account. The current handler does not yet fulfill this routing integration.
MSG91 must stay disabled until an account-bound authenticity contract is verified;
parser output or an unverified account identifier is insufficient. Passing a
callback that simply returns true is allowed only in synthetic unit fixtures.

Resolve inbound SMS destination from verified, unmasked payload fields before
normalization/masking. Do not use sender numbers. Delivery reports need a future
server-recorded provider-message ownership association; destination lookup alone
is not an outbound delivery-report routing policy. No ingestion is wired here.

Required privileges after separately approved migration
------------------------------------------------------

The existing application role needs only these new grants for future lookups:

```sql
GRANT SELECT ON smtp_inbox_route, sms_inbox_route TO devcaught_auth_app;
```

Its existing SELECT on private_inbox is also required. Do not grant INSERT,
UPDATE, DELETE, TRUNCATE, schema CREATE or function-creation privileges on these
resources to the application. Do not extend existing broad application grants
to future tables. No SECURITY DEFINER functions are introduced.

Run provisioning/revocation helpers only through a separate operator connection
(initially the migration/table owner). A future restricted provisioning role needs
schema USAGE, SELECT on private_inbox and both routes, INSERT on both routes, and
UPDATE(state, revoked_at) on both routes. PostgreSQL row-locking also needs UPDATE
on at least one column; those column grants suffice. No DELETE/TRUNCATE or ability
to change private_inbox ownership is needed. Do not expose this connection to
the application or a public provisioning route.

Remaining work: approve/apply 0004 and explicit lookup grants, verify real
PostgreSQL permissions/concurrency, provision controlled destinations, wire
authenticated SMTP/SMS scoped ingestion, and test retry/revocation behavior at
the storage boundary. Lookup is a point-in-time decision; coordinating a later
SQLite write with concurrent revocation remains an ingestion integration task.
Existing readiness checker covers only 0001–0003; release readiness must explicitly
include routing migration/constraints before ingestion activation. Legacy messages
remain unassigned. Real provider verification is not established by these tests.
