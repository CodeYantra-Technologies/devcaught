import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { pgliteDialect } from '../auth/pglite-dialect.ts';
import {
  authenticateSmsRoutingAccount, canonicalSmtpDestination, canonicalSmsDestination,
  lookupSmtpInbox, lookupSmsInbox, provisionSmtpRoute, provisionSmsRoute,
  revokeSmtpRoute, revokeSmsRoute, type AuthenticatedSmsAccount,
} from './private-inbox-routing.server.ts';

async function fixture(t: TestContext) {
  const pg = new PGlite();
  const db = new Kysely<unknown>({dialect: pgliteDialect(() => pg)});
  t.after(async () => { await db.destroy(); await pg.close(); });
  await pg.exec('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'a\'), (\'b\'), (\'c\');');
  for (const name of ['0003_private_inboxes.sql', '0004_private_inbox_routing.sql']) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  await pg.exec("INSERT INTO private_inbox (id, owner_id) VALUES ('inbox_a','a'), ('inbox_b','b')");
  return {pg, db};
}
const authenticated = (id = 'account_A') => authenticateSmsRoutingAccount('twilio', id, id, async () => true);

test('strict normalization preserves distinct aliases and rejects ambiguous input', () => {
  assert.equal(canonicalSmtpDestination(' A+Tag@Example.INVALID '), 'a+tag@example.invalid');
  assert.notEqual(canonicalSmtpDestination('a+tag@example.invalid'), canonicalSmtpDestination('a@example.invalid'));
  for (const value of ['Name <a@example.invalid>', 'a@localhost', 'a..b@example.invalid', 'a.@example.invalid', 'ü@example.invalid', 'a@example.invalid\r\nx: y']) {
    assert.throws(() => canonicalSmtpDestination(value));
  }
  assert.equal(canonicalSmsDestination(' +14155550123 '), '+14155550123');
  for (const value of ['4155550123', '+1 415 555 0123', '+*****0123', '+0123', '+1234567890123456']) assert.throws(() => canonicalSmsDestination(value));
});
test('SMTP duplicate provisioning is idempotent; conflicts and missing owners fail', async t => {
  const {pg, db} = await fixture(t);
  await provisionSmtpRoute(db, 'A@Example.INVALID', 'a');
  await provisionSmtpRoute(db, 'a@example.invalid', 'a');
  await assert.rejects(provisionSmtpRoute(db, 'a@example.invalid', 'b'));
  await assert.rejects(provisionSmtpRoute(db, 'other@example.invalid', 'missing'));
  assert.equal(await lookupSmtpInbox(db, ' A@EXAMPLE.INVALID '), 'inbox_a');
  assert.equal(await lookupSmtpInbox(db, 'unknown@example.invalid'), null);
  assert.equal((await pg.query('SELECT * FROM smtp_inbox_route')).rows.length, 1);
});
test('SMS scopes same destination to authenticated account and provider', async t => {
  const {db} = await fixture(t);
  await provisionSmsRoute(db, 'twilio', 'account_A', '+14155550123', 'a');
  await provisionSmsRoute(db, 'twilio', 'account_A', '+14155550123', 'a');
  await assert.rejects(provisionSmsRoute(db, 'twilio', 'account_A', '+14155550123', 'b'));
  await provisionSmsRoute(db, 'twilio', 'account_B', '+14155550123', 'b');
  await provisionSmsRoute(db, 'msg91', 'account_A', '+14155550123', 'b');
  assert.equal(await lookupSmsInbox(db, await authenticated(), '+14155550123'), 'inbox_a');
  assert.equal(await lookupSmsInbox(db, await authenticated('account_B'), '+14155550123'), 'inbox_b');
  assert.equal(await lookupSmsInbox(db, await authenticated('unknown'), '+14155550123'), null);
  const msg91 = await authenticateSmsRoutingAccount('msg91', 'account_A', 'account_A', async () => true);
  assert.equal(await lookupSmsInbox(db, msg91, '+14155550123'), 'inbox_b');
});
test('provider verification is required and forged or serialized contexts cannot route', async t => {
  const {db} = await fixture(t);
  await assert.rejects(authenticateSmsRoutingAccount('twilio', 'account_A', 'account_B', async () => true));
  await assert.rejects(authenticateSmsRoutingAccount('twilio', 'account_A', 'account_A', async () => false));
  await assert.rejects(authenticateSmsRoutingAccount('twilio', 'account_A', 'account_A', async () => {throw new Error('verification failure');}));
  await assert.rejects(lookupSmsInbox(db, {provider: 'twilio', accountId: 'account_A'} as AuthenticatedSmsAccount, '+14155550123'));
  const context = await authenticated();
  assert.ok(Object.isFrozen(context));
  await assert.rejects(lookupSmsInbox(db, JSON.parse(JSON.stringify(context)), '+14155550123'));
});
test('revocations retain tombstones and cannot be reassigned or reactivated', async t => {
  const {pg, db} = await fixture(t);
  await provisionSmtpRoute(db, 'a@example.invalid', 'a');
  await provisionSmsRoute(db, 'twilio', 'account_A', '+14155550123', 'a');
  await revokeSmtpRoute(db, 'a@example.invalid');
  await revokeSmsRoute(db, 'twilio', 'account_A', '+14155550123');
  assert.equal(await lookupSmtpInbox(db, 'a@example.invalid'), null);
  assert.equal(await lookupSmsInbox(db, await authenticated(), '+14155550123'), null);
  for (const owner of ['a', 'b']) {
    await assert.rejects(provisionSmtpRoute(db, 'a@example.invalid', owner));
    await assert.rejects(provisionSmsRoute(db, 'twilio', 'account_A', '+14155550123', owner));
  }
  await assert.rejects(pg.exec("UPDATE smtp_inbox_route SET state='active', revoked_at=NULL"));
  await assert.rejects(pg.exec('DELETE FROM sms_inbox_route'));
});
test('database constraints reject duplicates, invalid keys, missing inboxes and ownership mutation', async t => {
  const {pg, db} = await fixture(t);
  await provisionSmtpRoute(db, 'a@example.invalid', 'a');
  await provisionSmsRoute(db, 'twilio', 'account_A', '+14155550123', 'a');
  for (const query of [
    "INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('a@example.invalid','inbox_b')",
    "INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('A@example.invalid','inbox_b')",
    "INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('b@example.invalid','missing')",
    "INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id) VALUES ('twilio','account_A','+14155550123','inbox_b')",
    "INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id) VALUES ('twilio','account_A','masked0123','inbox_a')",
    "UPDATE smtp_inbox_route SET inbox_id='inbox_b'",
    "UPDATE sms_inbox_route SET provider_account_id='account_B'",
    "UPDATE smtp_inbox_route SET state='revoked'",
    "UPDATE private_inbox SET owner_id='c' WHERE id='inbox_a'",
    "DELETE FROM private_inbox WHERE id='inbox_a'",
  ]) await assert.rejects(pg.exec(query));
});
test('concurrent conflicting provisioning converges without reassignment', async t => {
  const {db} = await fixture(t);
  const results = await Promise.allSettled([
    provisionSmtpRoute(db, 'race@example.invalid', 'a'),
    provisionSmtpRoute(db, 'race@example.invalid', 'b'),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['inbox_a', 'inbox_b'].includes((await lookupSmtpInbox(db, 'race@example.invalid'))!));
});
test('missing registry errors propagate without falling back to an unassigned inbox', async t => {
  const {pg, db} = await fixture(t);
  await pg.exec('DROP TABLE smtp_inbox_route');
  await assert.rejects(lookupSmtpInbox(db, 'a@example.invalid'));
});
test('ambiguous lookup results fail closed defensively', async t => {
  const {db} = await fixture(t);
  await provisionSmtpRoute(db, 'a@example.invalid', 'a');
  await provisionSmsRoute(db, 'twilio', 'account_A', '+14155550123', 'a');
  // Simulate an unexpected query result; real primary keys forbid duplicates.
  const ambiguous = db.withPlugin({
    transformQuery: ({node}) => node,
    transformResult: async ({result}) => ({...result, rows: [...result.rows, ...result.rows]}),
  });
  assert.equal(await lookupSmtpInbox(ambiguous, 'a@example.invalid'), null);
  assert.equal(await lookupSmsInbox(ambiguous, await authenticated(), '+14155550123'), null);
});
test('lookup role cannot provision, revoke, delete or truncate registry assignments', async t => {
  const {pg, db} = await fixture(t);
  await provisionSmtpRoute(db, 'a@example.invalid', 'a');
  await provisionSmsRoute(db, 'twilio', 'account_A', '+14155550123', 'a');
  await pg.exec(`CREATE ROLE routing_lookup;
    GRANT USAGE ON SCHEMA public TO routing_lookup;
    GRANT SELECT ON private_inbox, smtp_inbox_route, sms_inbox_route TO routing_lookup;
    SET ROLE routing_lookup;`);
  assert.equal(await lookupSmtpInbox(db, 'a@example.invalid'), 'inbox_a');
  assert.equal(await lookupSmsInbox(db, await authenticated(), '+14155550123'), 'inbox_a');
  await assert.rejects(provisionSmtpRoute(db, 'b@example.invalid', 'b'));
  await assert.rejects(provisionSmsRoute(db, 'twilio', 'account_B', '+14155550123', 'b'));
  await assert.rejects(revokeSmtpRoute(db, 'a@example.invalid'));
  await assert.rejects(revokeSmsRoute(db, 'twilio', 'account_A', '+14155550123'));
  await assert.rejects(pg.exec('DELETE FROM smtp_inbox_route'));
  await assert.rejects(pg.exec('TRUNCATE sms_inbox_route'));
});
