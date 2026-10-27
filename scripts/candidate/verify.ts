import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { privateInboxTargetReady } from '../../src/lib/inbox/private-inbox-readiness.ts';

async function main() {
  const db = new Kysely<unknown>({dialect: new PostgresDialect({pool: new pg.Pool({
    host: 'postgres-dev', port: 5432, database: 'devcaught_auth_dev', user: 'devcaught_auth_app',
    password: readFileSync('/run/secrets/app_password', 'utf8').trim(), connectionTimeoutMillis: 10000,
  })})});
  const emails: string[] = [];
  const origin = 'http://localhost:3300';
  const request = (path: string, body?: unknown, cookie?: string, requestOrigin = origin) => fetch(`http://candidate:3000${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
  });
  const session = async (cookie?: string) => {
    const response = await request('/api/auth/get-session', undefined, cookie);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    await db.transaction().setAccessMode('read only').execute(async tx => {
      const target = await sql<{role: string; database: string}>`SELECT current_user AS role, current_database() AS database`.execute(tx);
      assert.equal(target.rows[0].role, 'devcaught_auth_app');
      assert.equal(target.rows[0].database, 'devcaught_auth_dev');
      assert.equal(await privateInboxTargetReady(tx), true);
    });
    console.log('PASS: application-role PostgreSQL target and read-only readiness');
    let listening = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { const r = await request('/api/auth/get-session'); if (r.status === 200) { listening = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(listening, true);
    assert.equal((await session())?.user, undefined);
    const users: {id: string; cookie: string; inbox: string}[] = [];
    for (let i = 0; i < 2; i++) {
      const email = `candidate-${randomUUID()}@example.invalid`;
      emails.push(email);
      const token = randomBytes(32).toString('base64url');
      const password = randomBytes(24).toString('hex');
      await sql`INSERT INTO invitation (id, email, "tokenHash", "createdAt", "expiresAt") VALUES
        (${randomUUID()}, ${email}, ${createHash('sha256').update(token).digest('hex')}, now(), now() + interval '1 hour')`.execute(db);
      assert.equal((await request('/api/auth/register-invitation', {name: 'Candidate verification', email, password, invitationToken: token})).status, 200);
      const login = await request('/api/auth/sign-in/email', {email, password});
      assert.equal(login.status, 200);
      const cookies = login.headers.getSetCookie();
      const sessionCookie = cookies.find(c => c.startsWith('__Host-devcaught-auth.session_token='));
      assert.ok(sessionCookie && /;\s*Secure/i.test(sessionCookie) && /;\s*HttpOnly/i.test(sessionCookie)
        && /;\s*SameSite=Lax/i.test(sessionCookie) && /;\s*Path=\//i.test(sessionCookie) && !/;\s*Domain=/i.test(sessionCookie));
      const cookie = cookies.map(c => c.split(';')[0]).join('; ');
      const current = await session(cookie);
      assert.equal(current.user.email, email);
      assert.equal((await session(cookie)).user.id, current.user.id);
      const ownership = await sql<{id: string}>`SELECT id FROM private_inbox WHERE owner_id=${current.user.id}`.execute(db);
      assert.equal(ownership.rows.length, 1);
      users.push({id: current.user.id, cookie, inbox: ownership.rows[0].id});
    }
    assert.notEqual(users[0].id, users[1].id);
    assert.notEqual(users[0].inbox, users[1].inbox);
    const badOrigin = await request('/api/auth/sign-out', {}, users[0].cookie, 'https://untrusted.invalid');
    assert.equal(badOrigin.status, 403);
    for (const cookie of [undefined, 'invalid=token', users[0].cookie, users[1].cookie]) {
      for (const path of ['/api/messages', `/api/messages/${users[1].inbox}`, `/api/messages/${users[1].inbox}/raw`]) {
        assert.equal((await request(path, undefined, cookie)).status, 503);
      }
      assert.equal((await request('/api/messages/clear', {}, cookie)).status, 503);
    }
    for (const user of users) {
      assert.equal((await request('/api/auth/sign-out', {}, user.cookie)).status, 200);
      assert.equal((await session(user.cookie))?.user, undefined);
    }
    console.log('PASS: two isolated invitation registrations, login, fresh sessions, distinct ownership, origin rejection, logout and revoked sessions');
    console.log('PASS: anonymous, malformed-session and cross-user-shaped inbox requests remain 503');
    console.log('BLOCKED: endpoint ownership authorization cannot be exercised while release guard returns 503');
  } finally {
    // Delete only this run’s fixtures; never inspect other accounts or messages.
    for (const email of emails) {
      await sql`DELETE FROM private_inbox WHERE owner_id IN (SELECT id FROM "user" WHERE email=${email})`.execute(db);
      await sql`DELETE FROM "user" WHERE email=${email}`.execute(db);
      await sql`DELETE FROM invitation WHERE email=${email}`.execute(db);
    }
    await db.destroy();
  }
}
main().catch(() => { console.error('FAIL: focused candidate verification; sensitive error details suppressed'); process.exitCode = 1; });
