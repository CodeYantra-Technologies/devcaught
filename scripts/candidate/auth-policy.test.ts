import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { candidateAuthorizationEnabled } from './auth-policy.ts';
import { transform } from './prepare-auth-build.mjs';

test('candidate capability requires every local condition and ignores client opt-ins', () => {
  const keys = {
    DEVCAUGHT_APP_ENV: 'local-development', DEVCAUGHT_CANDIDATE_AUTH_TEST: 'enabled',
    BETTER_AUTH_URL: 'http://localhost:3300', PORT: '3300',
    DEVCAUGHT_DB_PATH: '/app/data/candidate-auth-verification.db',
    DEVCAUGHT_CANDIDATE_AUTH_EXPIRES: String(Date.now() + 10 * 60_000),
  };
  const saved = { ...process.env };
  try {
    Object.assign(process.env, keys);
    const request = new Request('http://localhost:3300/api/messages');
    assert.equal(candidateAuthorizationEnabled(request), true);
    for (const key of Object.keys(keys)) {
      delete process.env[key];
      assert.equal(candidateAuthorizationEnabled(request), false);
      Object.assign(process.env, keys);
    }
    assert.equal(candidateAuthorizationEnabled(new Request('https://production.invalid/api/messages')), false);
    for (const expires of ['0', 'NaN', String(Date.now() - 1), String(Date.now() + 60 * 60_000)]) {
      process.env.DEVCAUGHT_CANDIDATE_AUTH_EXPIRES = expires;
      assert.equal(candidateAuthorizationEnabled(request), false);
    }
    Object.assign(process.env, keys);
    process.env.DEVCAUGHT_CANDIDATE_AUTH_TEST = 'disabled';
    assert.equal(candidateAuthorizationEnabled(new Request(request, {headers: {
      'x-candidate-auth-test': 'enabled', Cookie: 'candidate=enabled',
    }})), false);
  } finally {
    for (const key of Object.keys(keys)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
test('separate build fails closed on release or server guard drift', () => {
  const release = readFileSync('src/lib/inbox/private-inbox-release.ts', 'utf8');
  const server = readFileSync('src/lib/inbox/private-inbox-api.server.ts', 'utf8');
  assert.match(release, /export const PRIVATE_INBOX_POSTGRES_VERIFIED = false;/);
  assert.match(server, /if \(!PRIVATE_INBOX_POSTGRES_VERIFIED\) return inboxUnavailable\(\);/);
  assert.match(transform(release, server), /candidateAuthorizationEnabled\(request\)/);
  assert.match(transform(release, server), /if \(!await privateInboxTargetReady\(authDatabase\)\)/);
  assert.match(transform(release, server), /return await requirePrivateInbox\(\)/);
  assert.throws(() => transform(release.replace('= false', '= true'), server));
  assert.throws(() => transform(release, server + server));
  assert.throws(() => transform(release, server.replace('if (!PRIVATE_INBOX_POSTGRES_VERIFIED)', 'if (true)')));
});
