import { sql, type Kysely } from 'kysely';

type Db = Kysely<unknown>;
type Provider = 'twilio' | 'msg91';
type Route = { inbox_id: string; state: 'active' | 'revoked' };
const emailPattern = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Issued ASCII addresses only; no display names, Unicode or alias collapsing. */
export function canonicalSmtpDestination(value: string): string {
  const result = value.trim().toLowerCase();
  if (result.length > 254 || !emailPattern.test(result) || result.includes('..') || result.includes('.@')) {
    throw new Error('Unsupported SMTP destination');
  }
  return result;
}
/** Require an international E.164-shaped number; never guess a country code. */
export function canonicalSmsDestination(value: string): string {
  const result = value.trim();
  if (!/^\+[1-9][0-9]{1,14}$/.test(result)) throw new Error('Unsupported SMS destination');
  return result;
}
function account(provider: Provider, id: string) {
  if (!['twilio', 'msg91'].includes(provider) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error('Unsupported provider account');
  }
  return id; // Account identifiers are case-sensitive; never normalize them.
}

const authenticatedAccounts = new WeakSet<object>();
declare const verifiedAccount: unique symbol;
export type AuthenticatedSmsAccount = Readonly<{
  provider: Provider; accountId: string; [verifiedAccount]: true;
}>;
/**
 * Trusted server adapter boundary, never an HTTP endpoint. The verifier must
 * validate the exact request bytes/URL using credentials for configuredAccountId.
 * A payload AccountSid alone or a client boolean is never proof.
 */
export async function authenticateSmsRoutingAccount(
  provider: Provider, configuredAccountId: string, presentedAccountId: string,
  verifyAuthenticity: () => Promise<boolean>,
): Promise<AuthenticatedSmsAccount> {
  account(provider, configuredAccountId);
  if (presentedAccountId !== configuredAccountId || await verifyAuthenticity() !== true) {
    throw new Error('Provider account not authenticated');
  }
  const context = Object.freeze({provider, accountId: configuredAccountId}) as AuthenticatedSmsAccount;
  authenticatedAccounts.add(context);
  return context;
}

/** Null for unknown/revoked; configuration/query errors propagate (never fallback). */
export async function lookupSmtpInbox(db: Db, envelopeRecipient: string): Promise<string | null> {
  const destination = canonicalSmtpDestination(envelopeRecipient);
  const {rows} = await sql<Route>`SELECT r.inbox_id, r.state FROM smtp_inbox_route r
    JOIN private_inbox i ON i.id=r.inbox_id WHERE r.destination=${destination}`.execute(db);
  return rows.length === 1 && rows[0].state === 'active' ? rows[0].inbox_id : null;
}
export async function lookupSmsInbox(db: Db, context: AuthenticatedSmsAccount, destinationInput: string): Promise<string | null> {
  if (!authenticatedAccounts.has(context)) throw new Error('Provider account not authenticated');
  const destination = canonicalSmsDestination(destinationInput);
  const {rows} = await sql<Route>`SELECT r.inbox_id, r.state FROM sms_inbox_route r
    JOIN private_inbox i ON i.id=r.inbox_id WHERE r.provider=${context.provider}
    AND r.provider_account_id=${context.accountId} AND r.destination=${destination}`.execute(db);
  return rows.length === 1 && rows[0].state === 'active' ? rows[0].inbox_id : null;
}

/** Operator-only DB connection. ownerId is trusted provisioning input, not request input. */
export async function provisionSmtpRoute(db: Db, destinationInput: string, ownerId: string): Promise<void> {
  const destination = canonicalSmtpDestination(destinationInput);
  await db.transaction().execute(async tx => {
    await sql`INSERT INTO smtp_inbox_route (destination, inbox_id)
      SELECT ${destination}, id FROM private_inbox WHERE owner_id=${ownerId}
      ON CONFLICT (destination) DO NOTHING`.execute(tx);
    const {rows} = await sql<{owner_id: string; state: string}>`SELECT i.owner_id, r.state
      FROM smtp_inbox_route r JOIN private_inbox i ON i.id=r.inbox_id
      WHERE r.destination=${destination} FOR UPDATE OF r`.execute(tx);
    if (rows.length !== 1 || rows[0].owner_id !== ownerId || rows[0].state !== 'active') {
      throw new Error('SMTP assignment unavailable or conflicting');
    }
  });
}
export async function provisionSmsRoute(db: Db, provider: Provider, accountId: string, destinationInput: string, ownerId: string): Promise<void> {
  account(provider, accountId);
  const destination = canonicalSmsDestination(destinationInput);
  await db.transaction().execute(async tx => {
    await sql`INSERT INTO sms_inbox_route (provider, provider_account_id, destination, inbox_id)
      SELECT ${provider}, ${accountId}, ${destination}, id FROM private_inbox WHERE owner_id=${ownerId}
      ON CONFLICT (provider, provider_account_id, destination) DO NOTHING`.execute(tx);
    const {rows} = await sql<{owner_id: string; state: string}>`SELECT i.owner_id, r.state
      FROM sms_inbox_route r JOIN private_inbox i ON i.id=r.inbox_id WHERE r.provider=${provider}
      AND r.provider_account_id=${accountId} AND r.destination=${destination} FOR UPDATE OF r`.execute(tx);
    if (rows.length !== 1 || rows[0].owner_id !== ownerId || rows[0].state !== 'active') {
      throw new Error('SMS assignment unavailable or conflicting');
    }
  });
}
export async function revokeSmtpRoute(db: Db, destinationInput: string): Promise<void> {
  const destination = canonicalSmtpDestination(destinationInput);
  const {rows} = await sql`UPDATE smtp_inbox_route SET state='revoked', revoked_at=now()
    WHERE destination=${destination} AND state='active' RETURNING destination`.execute(db);
  if (rows.length !== 1) throw new Error('Active SMTP assignment not found');
}
export async function revokeSmsRoute(db: Db, provider: Provider, accountId: string, destinationInput: string): Promise<void> {
  account(provider, accountId);
  const destination = canonicalSmsDestination(destinationInput);
  const {rows} = await sql`UPDATE sms_inbox_route SET state='revoked', revoked_at=now()
    WHERE provider=${provider} AND provider_account_id=${accountId} AND destination=${destination}
    AND state='active' RETURNING destination`.execute(db);
  if (rows.length !== 1) throw new Error('Active SMS assignment not found');
}
