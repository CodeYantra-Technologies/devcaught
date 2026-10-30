import { sql, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { canonicalSmtpDestination, lookupSmtpInbox } from '../../../../src/lib/inbox/private-inbox-routing.server.ts';
import { InboxService } from '../ingest/inboxService.ts';
import type { InboxStore } from '../store/sqlite.ts';
import type { DevCaughtConfig } from '../config.ts';
import type { SmtpRecipientResolver, SmtpInboxFactory } from './receiver.ts';

/** Uses only the routing registry's SELECT surface, never auth bootstrap. */
export function privateSmtpDependencies(db: Kysely<unknown>, store: InboxStore, config: DevCaughtConfig): {
  resolveRecipient: SmtpRecipientResolver; inboxForId: SmtpInboxFactory;
} {
  return {
    resolveRecipient: async address => {
      // Invalid envelope destinations are permanent rejections, not DB outages.
      try { canonicalSmtpDestination(address); } catch { return null; }
      return db.transaction().setAccessMode('read only').execute(async tx => {
        // Explicit command also enforces this with the embedded fixture dialect.
        await sql`SET TRANSACTION READ ONLY`.execute(tx);
        const {rows} = await sql<{role: string}>`SELECT current_user AS role`.execute(tx);
        if (rows[0]?.role !== 'devcaught_auth_app') throw new Error('SMTP application database role required');
        return lookupSmtpInbox(tx, address);
      });
    },
    inboxForId: inboxId => new InboxService(store.forInbox(inboxId), {
      retentionDays: config.retentionDays, maxMessages: config.maxMessages,
    }),
  };
}

/** Called only after explicit private-mode selection. No PGLite/root fallback. */
export function configuredPrivateSmtpDependencies(store: InboxStore, config: DevCaughtConfig) {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('Private SMTP requires configured PostgreSQL');
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new Error('Private SMTP requires a valid PostgreSQL connection'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== 'devcaught_auth_app') {
    throw new Error('Private SMTP requires PostgreSQL application-role credentials');
  }
  const pool = new Pool({connectionString, max: 4, connectionTimeoutMillis: 4000,
    statement_timeout: 4000, idle_in_transaction_session_timeout: 5000});
  pool.on('error', () => { /* Failed lookups reject delivery; never log credentials. */ });
  pool.on('connect', client => {
    // pg-pool removes its idle error listener while a client is checked out.
    // Keep a client-level listener for unexpected disconnect events throughout
    // checkout; pg query promises still reject and the transaction remains fail-closed.
    client.on('error', () => { /* Consume only the EventEmitter error; never log query or connection data. */ });
  });
  const db = new Kysely<unknown>({dialect: new PostgresDialect({pool})});
  return {...privateSmtpDependencies(db, store, config), close: () => db.destroy()};
}
