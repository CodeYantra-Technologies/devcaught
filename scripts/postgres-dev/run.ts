import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { privateInboxTargetReady } from '../../src/lib/inbox/private-inbox-readiness.ts';

const password = (name: string) => {
  const value = readFileSync(`/run/secrets/${name}_password`, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid credential format');
  return value;
};
const config = (user: string, secret: string, database = 'devcaught_auth_dev') => ({
  host: 'postgres-dev', port: 5432, user, password: password(secret), database,
  connectionTimeoutMillis: 10000,
});

async function main() {
  const admin = new pg.Client(config('postgres', 'admin', 'postgres'));
  await admin.connect();
  try {
    // Passwords are generated hex only; never accept arbitrary SQL literals.
    await admin.query(`CREATE ROLE devcaught_auth_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password('owner')}'`);
    await admin.query(`CREATE ROLE devcaught_auth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password('app')}'`);
    await admin.query('CREATE DATABASE devcaught_auth_dev OWNER devcaught_auth_owner');
    await admin.query('REVOKE ALL ON DATABASE devcaught_auth_dev FROM PUBLIC');
    await admin.query('GRANT CONNECT ON DATABASE devcaught_auth_dev TO devcaught_auth_app');
  } finally { await admin.end(); }

  const owner = new pg.Client(config('devcaught_auth_owner', 'owner'));
  await owner.connect();
  try { await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC'); }
  finally { await owner.end(); }

  const url = new URL('postgresql://devcaught_auth_owner@postgres-dev:5432/devcaught_auth_dev');
  url.password = password('owner');
  const migration = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8',
  });
  // Never forward error details or arbitrary child output containing credentials.
  if (migration.status !== 0) throw new Error('Migration failed');
  const grant = new pg.Client(config('devcaught_auth_owner', 'owner'));
  await grant.connect();
  try {
    await grant.query('GRANT USAGE ON SCHEMA public TO devcaught_auth_app');
    await grant.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "user", session, account, verification, invitation, "rateLimit", private_inbox TO devcaught_auth_app');
    await grant.query('GRANT SELECT ON _migrations TO devcaught_auth_app');
  } finally { await grant.end(); }

  const db = new Kysely<unknown>({ dialect: new PostgresDialect({
    pool: new pg.Pool(config('devcaught_auth_app', 'app')),
  }) });
  try {
    await db.transaction().setAccessMode('read only').execute(async tx => {
      const ledger = await sql<{name: string}>`SELECT name FROM _migrations ORDER BY name`.execute(tx);
      const expected = ['0001_auth.sql', '0002_invitations.sql', '0003_private_inboxes.sql'];
      if (JSON.stringify(ledger.rows.map(r => r.name)) !== JSON.stringify(expected)) throw new Error('Unexpected migration ledger');
      const ready = await privateInboxTargetReady(tx);
      console.log('Migrations: 0001_auth.sql, 0002_invitations.sql, 0003_private_inboxes.sql applied');
      console.log(`Read-only application-role readiness: ${ready ? 'PASS' : 'FAIL'}`);
      if (!ready) throw new Error('Readiness failed');
    });
  } finally { await db.destroy(); }
}
main().catch(() => {
  console.error('Setup BLOCKED: bootstrap, migration, grants or readiness failed; no secret details emitted. Preserve new resources for diagnosis.');
  process.exitCode = 1;
});
