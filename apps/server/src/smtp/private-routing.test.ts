import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { SMTPServer, type SMTPServerSession, type SMTPServerDataStream } from 'smtp-server';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { pgliteDialect } from '../../../../src/lib/auth/pglite-dialect.ts';
import { openInboxStore } from '../store/sqlite.ts';
import { InboxService } from '../ingest/inboxService.ts';
import { normalizeTestEmail } from '../ingest/normalizeEmail.ts';
import { loadConfig, type DevCaughtConfig } from '../config.ts';
import { startSmtpReceiver, type SmtpRecipientResolver } from './receiver.ts';
import { privateSmtpDependencies, configuredPrivateSmtpDependencies } from './private-routing.ts';

const config: DevCaughtConfig = {host:'127.0.0.1', smtpPort:0, httpPort:0, dbPath:':memory:', smtpSizeLimit:4096,
  retentionDays:0, maxMessages:0, smtpRoutingMode:'private'};
const code = (e: Error | null | undefined) => (e as Error & {responseCode?:number})?.responseCode;
async function fixture(t: TestContext) {
  const pg = new PGlite();
  const db = new Kysely<unknown>({dialect:pgliteDialect(() => pg)});
  const {store} = openInboxStore(':memory:');
  t.after(async () => {store.close(); await db.destroy(); await pg.close();});
  await pg.exec('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'a\'),(\'b\');');
  for (const name of ['0003_private_inboxes.sql','0004_private_inbox_routing.sql']) {
    await pg.exec(readFileSync(new URL(`../../../../migrations/${name}`,import.meta.url),'utf8'));
  }
  await pg.exec(`INSERT INTO private_inbox(id,owner_id) VALUES ('inbox_a','a'),('inbox_b','b');
    INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('a@example.invalid','inbox_a'),('alias@example.invalid','inbox_a'),('b@example.invalid','inbox_b');
    CREATE ROLE devcaught_auth_app; GRANT USAGE ON SCHEMA public TO devcaught_auth_app;
    GRANT SELECT ON private_inbox,smtp_inbox_route TO devcaught_auth_app; SET ROLE devcaught_auth_app;`);
  const legacy = new InboxService(store).ingest(normalizeTestEmail({from:'synthetic@example.invalid',to:'legacy@example.invalid',subject:'SYNTHETIC LEGACY',text:'unassigned synthetic fixture'}));
  const deps = privateSmtpDependencies(db,store,config);
  async function hooks(resolve: SmtpRecipientResolver = deps.resolveRecipient) {
    let server!: SMTPServer;
    const listen = t.mock.method(SMTPServer.prototype,'listen',function(this:SMTPServer,...args:unknown[]) {
      server=this; queueMicrotask(args.at(-1) as () => void); return this.server;
    });
    try { await startSmtpReceiver(config,new InboxService(store),resolve,deps.inboxForId); }
    finally {listen.mock.restore();}
    const session = {envelope:{mailFrom:{address:'synthetic@example.invalid',args:{}},rcptTo:[]}} as unknown as SMTPServerSession;
    const rcpt = (address:string) => new Promise<Error|null|undefined>(done => {
      const recipient={address,args:{}};
      server.onRcptTo(recipient,session,error => {if (!error) session.envelope.rcptTo.push(recipient); done(error);});
    });
    const data = () => new Promise<Error|null|undefined>(done => {
      const stream = new PassThrough() as SMTPServerDataStream;
      server.onData(stream,session,done);
      stream.end('From: spoofed@example.invalid\r\nTo: b@example.invalid\r\nSubject: SYNTHETIC PRIVATE SMTP\r\n\r\nsynthetic body');
    });
    return {rcpt,data};
  }
  return {pg,db,store,deps,hooks,legacy};
}
test('explicit private opt-in is strict; absent mode leaves configuration unchanged', () => {
  const previous=process.env.DEVCAUGHT_SMTP_ROUTING_MODE;
  try {
    delete process.env.DEVCAUGHT_SMTP_ROUTING_MODE;
    assert.equal(loadConfig().smtpRoutingMode,undefined);
    process.env.DEVCAUGHT_SMTP_ROUTING_MODE='private'; assert.equal(loadConfig().smtpRoutingMode,'private');
    process.env.DEVCAUGHT_SMTP_ROUTING_MODE='typo'; assert.throws(() => loadConfig());
  } finally {if(previous===undefined) delete process.env.DEVCAUGHT_SMTP_ROUTING_MODE; else process.env.DEVCAUGHT_SMTP_ROUTING_MODE=previous;}
});
test('private SMTP refuses missing database configuration without fallback', () => {
  const previous=process.env.DATABASE_URL;
  const {store}=openInboxStore(':memory:');
  try {delete process.env.DATABASE_URL; assert.throws(() => configuredPrivateSmtpDependencies(store,config));}
  finally {store.close(); if(previous===undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=previous;}
});
test('real registry lookup as read-only application role delivers two owners and same-owner aliases, ignoring headers',async t => {
  const {hooks,store,legacy}=await fixture(t);
  const first=await hooks();
  assert.equal(await first.rcpt('A@EXAMPLE.INVALID'),undefined);
  assert.equal(await first.rcpt('alias@example.invalid'),undefined);
  assert.equal(await first.data(),undefined);
  const second=await hooks(); await second.rcpt('b@example.invalid'); assert.equal(await second.data(),undefined);
  assert.equal(store.forInbox('inbox_a').count(),1); assert.equal(store.forInbox('inbox_b').count(),1);
  assert.equal(store.count(),3); assert.equal(store.get(legacy.id)?.subject,'SYNTHETIC LEGACY');
});
test('unknown, invalid and revoked recipients and cross-inbox DATA reject without root writes',async t => {
  const {hooks,pg,store}=await fixture(t);
  const h=await hooks();
  for(const address of ['unknown@example.invalid','Name <a@example.invalid>','a@localhost']) assert.equal(code(await h.rcpt(address)),550);
  await pg.exec("RESET ROLE; UPDATE smtp_inbox_route SET state='revoked',revoked_at=now() WHERE destination='alias@example.invalid'; SET ROLE devcaught_auth_app;");
  assert.equal(code(await h.rcpt('alias@example.invalid')),550);
  await h.rcpt('a@example.invalid'); await h.rcpt('b@example.invalid'); assert.equal(code(await h.data()),550);
  assert.equal(store.count(),1);
});
test('revocation after DATA validation is checked again immediately before storage',async t => {
  const {hooks,pg,store,deps}=await fixture(t); let calls=0;
  const h=await hooks(async address => {
    if(++calls===3) await pg.exec("RESET ROLE; UPDATE smtp_inbox_route SET state='revoked',revoked_at=now() WHERE destination='a@example.invalid'; SET ROLE devcaught_auth_app;");
    return deps.resolveRecipient(address);
  });
  await h.rcpt('a@example.invalid'); assert.equal(code(await h.data()),451);
  assert.equal(calls,3); assert.equal(store.count(),1);
});
test('database failure during final validation returns sanitized 451 with no root downgrade',async t => {
  const {hooks,store,deps,db}=await fixture(t); let calls=0;
  const broken=db.withPlugin({transformQuery(){throw new Error('SYNTHETIC DATABASE FAILURE');},transformResult:async({result})=>result});
  const failing=privateSmtpDependencies(broken,store,config);
  const h=await hooks(address => ++calls===3 ? failing.resolveRecipient(address) : deps.resolveRecipient(address));
  await h.rcpt('a@example.invalid'); const error=await h.data(); assert.equal(code(error),451);
  assert.doesNotMatch(error!.message,/SYNTHETIC DATABASE/); assert.equal(store.count(),1);
});
test('wrong DB role and ambiguous lookup result never deliver',async t => {
  const {hooks,pg,store,db}=await fixture(t);
  await pg.exec('RESET ROLE');
  const wrong=await hooks(); assert.equal(code(await wrong.rcpt('a@example.invalid')),451);
  await pg.exec('SET ROLE devcaught_auth_app');
  const ambiguous=db.withPlugin({transformQuery:({node})=>node,transformResult:async({result})=>
    result.rows[0] && 'inbox_id' in result.rows[0] ? {...result,rows:[...result.rows,...result.rows]} : result});
  const h=await hooks(privateSmtpDependencies(ambiguous,store,config).resolveRecipient);
  assert.equal(code(await h.rcpt('a@example.invalid')),550); assert.equal(store.count(),1);
});
