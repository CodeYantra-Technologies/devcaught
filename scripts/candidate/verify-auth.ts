import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const origin = 'http://localhost:3300';
async function call(path: string, method = 'GET', cookie?: string, body?: unknown, requestOrigin: string | null = origin) {
  return fetch(origin + path, { method, redirect: 'manual', signal: AbortSignal.timeout(10000), headers: {
    ...(cookie ? {Cookie: cookie} : {}), ...(requestOrigin === null ? {} : {Origin: requestOrigin}),
    'Content-Type': 'application/json',
  }, ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
}
async function expect(path: string, status: number, method = 'GET', cookie?: string, body?: unknown, requestOrigin: string | null = origin) {
  const response = await call(path, method, cookie, body, requestOrigin);
  assert.equal(response.status, status, `${method} ${path}: unexpected status`);
  return response;
}
async function main() {
  let listening = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await call('/api/auth/get-session')).status === 200) { listening = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(listening, 'candidate startup');
  if (process.env.AUTH_VERIFY_MODE === 'closed') {
    for (const cookie of [undefined, 'candidate=enabled']) {
      for (const path of ['/api/messages', '/api/status', `/api/messages/${randomUUID()}`, `/api/messages/${randomUUID()}/raw`]) await expect(path, 503, 'GET', cookie);
      await expect('/api/messages/test', 503, 'POST', cookie, {});
      await expect('/api/messages/clear', 503, 'POST', cookie, {});
      await expect(`/api/messages/${randomUUID()}`, 503, 'DELETE', cookie);
    }
    console.log('PASS: all private routes closed at 503');
    return;
  }
  assert.equal(process.env.AUTH_VERIFY_MODE, 'active');
  const db = new pg.Client({host: 'postgres-dev', database: 'devcaught_auth_dev', user: 'devcaught_auth_app',
    password: readFileSync('/run/secrets/app_password', 'utf8').trim(), connectionTimeoutMillis: 10000});
  await db.connect();
  const fixtures: {email: string; password: string; cookie: string; id: string; marker: string; message: string}[] = [];
  const emails: string[] = [];
  async function login(email: string, password: string) {
    const response = await expect('/api/auth/sign-in/email', 200, 'POST', undefined, {email, password});
    const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    assert.ok(cookie.includes('__Host-devcaught-auth.session_token='));
    return cookie;
  }
  try {
    for (let i = 0; i < 2; i++) {
      const email = `candidate-auth-${randomUUID()}@example.invalid`;
      emails.push(email);
      const token = randomBytes(32).toString('base64url');
      const password = randomBytes(24).toString('hex');
      await db.query('INSERT INTO invitation (id,email,"tokenHash","createdAt","expiresAt") VALUES ($1,$2,$3,now(),now()+interval \'1 hour\')',
        [randomUUID(), email, createHash('sha256').update(token).digest('hex')]);
      await expect('/api/auth/register-invitation', 200, 'POST', undefined, {email, password, invitationToken: token, name: 'SYNTHETIC AUTHORIZATION TEST'});
      const cookie = await login(email, password);
      const session = await (await expect('/api/auth/get-session', 200, 'GET', cookie)).json();
      assert.equal(session.user.email, email);
      const fixture = {email, password, cookie, id: session.user.id, marker: `SYNTHETIC-DEVCAUGHT-AUTH-TEST-${randomUUID()}`, message: ''};
      fixtures.push(fixture);
      const message = await (await expect('/api/messages/test', 201, 'POST', cookie, {
        from: 'synthetic-sender@example.invalid', to: email, subject: fixture.marker,
        text: `${fixture.marker} Synthetic authorization fixture. Not real mail.`,
      })).json();
      fixture.message = message.id;
      assert.ok(fixture.message);
    }
    const [a,b] = fixtures;
    assert.notEqual(a.id, b.id);
    for (const [owner, other] of [[a,b], [b,a]]) {
      const listing = await (await expect('/api/messages', 200, 'GET', owner.cookie)).text();
      assert.ok(listing.includes(owner.marker)); assert.ok(!listing.includes(other.marker));
      for (const query of [owner.marker, other.marker]) {
        const results = await (await expect(`/api/messages?q=${encodeURIComponent(query)}`, 200, 'GET', owner.cookie)).json();
        assert.equal(results.messages.length, query === owner.marker ? 1 : 0);
        assert.ok(!JSON.stringify(results).includes(other.marker));
      }
      for (const suffix of ['', '/raw']) {
        const own = await (await expect(`/api/messages/${owner.message}${suffix}`, 200, 'GET', owner.cookie)).text();
        assert.ok(own.includes(owner.marker)); assert.ok(!own.includes(other.marker));
        const denied = await (await expect(`/api/messages/${other.message}${suffix}`, 404, 'GET', owner.cookie)).text();
        assert.ok(!denied.includes(other.marker));
      }
      await expect(`/api/messages/${other.message}`, 404, 'DELETE', owner.cookie);
      const status = await (await expect('/api/status', 200, 'GET', owner.cookie)).json();
      assert.equal(status.messageCount, 1);
      for (const bad of ['not-a-uuid', 'inbox_fake', '%27OR%201%3D1']) {
        await expect(`/api/messages/${bad}`, 400, 'GET', owner.cookie);
        await expect(`/api/messages/${bad}/raw`, 400, 'GET', owner.cookie);
        await expect(`/api/messages/${bad}`, 400, 'DELETE', owner.cookie);
      }
      // Direct API access still requires session; mutations require exact Origin.
      await expect('/api/messages', 200, 'GET', owner.cookie, undefined, null);
      await expect('/api/messages/clear', 403, 'POST', owner.cookie, {}, null);
      await expect('/api/messages/clear', 403, 'POST', owner.cookie, {}, 'https://untrusted.invalid');
      await expect('/api/messages', 403, 'GET', owner.cookie, undefined, 'https://untrusted.invalid');
    }
    for (const cookie of [undefined, '__Host-devcaught-auth.session_token=malformed']) {
      await expect('/api/messages', 401, 'GET', cookie);
      await expect(`/api/messages/${a.message}`, 401, 'GET', cookie);
      await expect(`/api/messages/${a.message}/raw`, 401, 'GET', cookie);
      await expect(`/api/messages/${a.message}`, 401, 'DELETE', cookie);
      await expect('/api/messages/clear', 401, 'POST', cookie, {});
      await expect('/api/messages/test', 401, 'POST', cookie, {});
      await expect('/api/status', 401, 'GET', cookie);
    }
    await expect(`/api/messages/${a.message}`, 200, 'DELETE', a.cookie);
    await expect(`/api/messages/${a.message}`, 404, 'GET', a.cookie);
    assert.equal((await (await expect('/api/status', 200, 'GET', b.cookie)).json()).messageCount, 1);
    await expect('/api/messages/clear', 200, 'POST', a.cookie, {});
    await expect(`/api/messages/${b.message}`, 200, 'GET', b.cookie);
    await expect('/api/messages/clear', 200, 'POST', b.cookie, {});
    for (const owner of fixtures) {
      assert.equal((await (await expect('/api/status', 200, 'GET', owner.cookie)).json()).messageCount, 0);
      // Expire only sessions created for this run's synthetic user.
      await db.query('UPDATE session SET "expiresAt"=now()-interval \'1 minute\' WHERE "userId"=$1', [owner.id]);
      await expect('/api/messages', 401, 'GET', owner.cookie);
      owner.cookie = await login(owner.email, owner.password);
      await expect('/api/auth/sign-out', 200, 'POST', owner.cookie, {});
      await expect('/api/messages', 401, 'GET', owner.cookie);
    }
    console.log('PASS: real owner list/search/detail/raw/delete/count/clear; cross-user isolation; anonymous/malformed/expired/revoked sessions; malformed IDs and origin rejection');
  } finally {
    try {
      // Scoped cleanup uses only this run's new identities, never the root SQLite store.
      for (const owner of fixtures) {
        const cookie = await login(owner.email, owner.password);
        await expect('/api/messages/clear', 200, 'POST', cookie, {});
      }
      for (const email of emails) {
        await db.query('DELETE FROM private_inbox WHERE owner_id IN (SELECT id FROM "user" WHERE email=$1)', [email]);
        await db.query('DELETE FROM "user" WHERE email=$1', [email]);
        await db.query('DELETE FROM invitation WHERE email=$1', [email]);
      }
    } finally { await db.end(); }
  }
}
main().catch(() => { console.error('FAIL: candidate authorization verification (sensitive details suppressed). Preserve isolated fixtures for diagnosis if cleanup failed.'); process.exitCode = 1; });
