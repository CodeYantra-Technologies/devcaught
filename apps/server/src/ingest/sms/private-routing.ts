import {sql, Kysely, PostgresDialect} from 'kysely';
import {Pool} from 'pg';
import {lookupSmsInbox, type AuthenticatedSmsAccount} from '../../../../../src/lib/inbox/private-inbox-routing.server.ts';
import {InboxService} from '../inboxService.ts';
import type {NormalizedMessage} from '../../../../../packages/shared/src/types.ts';
import type {InboxStore, SmsInsertResult} from '../../store/sqlite.ts';
import type {DevCaughtConfig} from '../../config.ts';

export type PrivateSmsIngest = (account: AuthenticatedSmsAccount, destination: string,
  message: NormalizedMessage, dedupeKey: string) => Promise<SmsInsertResult>;

/** Only the registry SELECT surface is used; never auth bootstrap or root storage. */
export function privateSmsDependencies(db: Kysely<unknown>, store: InboxStore, config: DevCaughtConfig): {ingest: PrivateSmsIngest} {
  return {async ingest(account, destination, message, dedupeKey) {
    const inboxId = await db.transaction().setAccessMode('read only').execute(async tx => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      const {rows} = await sql<{role: string}>`SELECT current_user AS role`.execute(tx);
      if (rows[0]?.role !== 'devcaught_auth_app') throw new Error('SMS application database role required');
      return lookupSmsInbox(tx, account, destination);
    });
    if (!inboxId) throw Object.assign(new Error('SMS route unavailable'), {code:'SMS_ROUTE_UNAVAILABLE'});
    return new InboxService(store.forInbox(inboxId), {
      retentionDays: config.retentionDays, maxMessages: config.maxMessages,
    }).ingestSms(message, dedupeKey);
  }};
}

export function configuredPrivateSmsDependencies(store: InboxStore, config: DevCaughtConfig) {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('Private SMS requires configured PostgreSQL');
  let url: URL;
  try {url = new URL(connectionString);} catch {throw new Error('Private SMS requires a valid PostgreSQL connection');}
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'devcaught_auth_app') {
    throw new Error('Private SMS requires PostgreSQL application-role credentials');
  }
  const pool = new Pool({connectionString, max:4, connectionTimeoutMillis:4000,
    statement_timeout:4000, idle_in_transaction_session_timeout:5000});
  pool.on('error', () => { /* Fail lookups without logging connection details. */ });
  const db = new Kysely<unknown>({dialect:new PostgresDialect({pool})});
  return {...privateSmsDependencies(db, store, config), close:() => db.destroy()};
}
