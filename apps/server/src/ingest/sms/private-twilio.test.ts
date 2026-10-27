import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IncomingMessage,ServerResponse} from 'node:http';
import {Duplex} from 'node:stream';
import type {Socket} from 'node:net';
import type {Request,Response} from 'express';
import {PGlite} from '@electric-sql/pglite';
import {Kysely} from 'kysely';
import {pgliteDialect} from '../../../../../src/lib/auth/pglite-dialect.ts';
import {twilioSignature} from '../../../../../packages/shared/src/sms/adapters.ts';
import {createTwilioWebhookHandler, type TwilioWebhookConfig} from '../twilioWebhook.ts';
import {privateSmsDependencies, type PrivateSmsIngest} from './private-routing.ts';
import {openInboxStore} from '../../store/sqlite.ts';
import {InboxService} from '../inboxService.ts';
import type {DevCaughtConfig} from '../../config.ts';
import type {DevCaughtRuntime} from '../../runtime.ts';
import {createApiApp} from '../../http/app.ts';

const accountA='AC'+'a'.repeat(32),accountB='AC'+'b'.repeat(32);
const token='SYNTHETIC_OFFLINE_TOKEN',publicUrl='https://synthetic.invalid/api/webhooks/twilio';
let sequence=0;
const sid=()=> 'SM'+(++sequence).toString(16).padStart(32,'0');
const fields=(extra:Record<string,unknown>={})=>({AccountSid:accountA,To:'+14155550101',From:'+14155550000',Body:'SYNTHETIC SMS',MessageSid:sid(),SmsStatus:'received',...extra});
const config:DevCaughtConfig={host:'127.0.0.1',smtpPort:1025,httpPort:8025,dbPath:':memory:',smtpSizeLimit:4096,
  retentionDays:0,maxMessages:0,smsRoutingMode:'private',twilioAccountSid:accountA,twilioAuthToken:token,twilioPublicUrl:publicUrl};
type Handler=ReturnType<typeof createTwilioWebhookHandler>;
async function request(handler:Handler, payload:Record<string,unknown>|string, {json=false,badSignature=false,tamper=false}={}) {
  const body=typeof payload==='string'?payload:json?JSON.stringify(payload):new URLSearchParams(payload as Record<string,string>).toString();
  const params:Record<string,string|string[]>={};
  if(!json)for(const [key,value] of new URLSearchParams(body)) {
    const old=params[key];params[key]=old===undefined?value:Array.isArray(old)?[...old,value]:[old,value];
  }
  const query=json?'?bodySHA256='+createHash('sha256').update(body).digest('hex'):'';
  let status=0,response:unknown;
  const res={status(value:number){status=value;return this;},json(value:unknown){response=value;return this;}};
  await handler({body:Buffer.from(body+(tamper?' ':'')),originalUrl:'/api/webhooks/twilio'+query,headers:{
    'content-type':json?'application/json':'application/x-www-form-urlencoded',
    'x-twilio-signature':badSignature?'invalid':twilioSignature(token,publicUrl+query,json?{}:params),
  }} as unknown as Request,res as unknown as Response);
  return {status,body:response as {id?:string;error?:string}};
}

/** Exercise Express routing and its raw-body middleware entirely in memory. */
async function apiRequest(runtime:DevCaughtRuntime, payload:Record<string,string>) {
  const socket=new Duplex({read(){},write(_chunk,_encoding,callback){callback();}});
  const req=new IncomingMessage(socket as Socket);
  req.method='POST';req.url='/webhooks/twilio';req.httpVersion='1.1';req.httpVersionMajor=1;req.httpVersionMinor=1;
  const body=new URLSearchParams(payload).toString();
  req.headers={'content-type':'application/x-www-form-urlencoded','content-length':String(Buffer.byteLength(body)),
    'x-twilio-signature':twilioSignature(token,publicUrl,payload)};
  const res=new ServerResponse(req);res.assignSocket(socket as Socket);
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Synthetic HTTP pipeline timeout')),1000);
      res.once('finish',()=>{clearTimeout(timer);resolve();});res.once('error',reject);req.once('error',reject);
      createApiApp(runtime)(req,res);req.push(Buffer.from(body));req.complete=true;req.push(null);
    });
    return res.statusCode;
  }finally{req.destroy();res.destroy();socket.destroy();}
}

test('private Twilio signed inbound routes through the real embedded registry and scoped SQLite',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'devcaught-private-sms-'));
  const {store}=openInboxStore(join(dir,'synthetic.db'),{requirePersistent:true});
  const pg=new PGlite();const db=new Kysely<unknown>({dialect:pgliteDialect(()=>pg)});
  t.after(async()=>{store.close();await db.destroy();await pg.close();rmSync(dir,{recursive:true,force:true});});
  await pg.exec('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'a\'),(\'b\');');
  for(const name of ['0003_private_inboxes.sql','0004_private_inbox_routing.sql']) {
    await pg.exec(readFileSync(new URL(`../../../../../migrations/${name}`,import.meta.url),'utf8'));
  }
  await pg.exec(`INSERT INTO private_inbox(id,owner_id) VALUES ('inbox_a','a'),('inbox_b','b');
    INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id) VALUES
      ('twilio','${accountA}','+14155550101','inbox_a'),('twilio','${accountA}','+14155550102','inbox_b'),
      ('twilio','${accountA}','+14155550103','inbox_a'),('twilio','${accountB}','+14155550101','inbox_a'),
      ('msg91','${accountA}','+14155550101','inbox_b');
    INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id,state,revoked_at)
      VALUES ('twilio','${accountA}','+14155550104','inbox_a','revoked',now());
    CREATE ROLE devcaught_auth_app; GRANT USAGE ON SCHEMA public TO devcaught_auth_app;
    GRANT SELECT ON private_inbox,sms_inbox_route TO devcaught_auth_app; SET ROLE devcaught_auth_app;`);
  new InboxService(store).ingest({type:'email',source:'test',sender:'synthetic.invalid',recipient:'synthetic.invalid',
    subject:'SYNTHETIC ROOT SENTINEL',textBody:'synthetic',htmlBody:'',rawData:'',createdAt:1});
  let rootCalls=0;
  const deps=privateSmsDependencies(db,store,config);
  const handler=(ingest:PrivateSmsIngest=deps.ingest,override:Partial<TwilioWebhookConfig>={})=>
    createTwilioWebhookHandler({...config,...override},()=>{rootCalls++;throw new Error('root fallback forbidden');},ingest);
  const count=()=>store.count();

  await t.test('canonical destination is used before masking; verified message ignores client inbox claims',async()=>{
    let called=false;
    const result=await request(handler(async(context,destination,message,key)=>{
      called=true;assert.equal(context.provider,'twilio');assert.equal(context.accountId,accountA);
      assert.equal(destination,'+14155550101');assert.match(message.recipient??'',/\*/);
      assert.equal(JSON.parse(message.rawData).sms.verification,'valid');
      assert.ok(!message.rawData.includes(destination));
      return deps.ingest(context,destination,message,key);
    }),fields({To:' +14155550101 ',inboxId:'inbox_b',ownerId:'b'}));
    assert.equal(result.status,200);assert.equal(called,true);
    assert.ok(store.forInbox('inbox_a').get(result.body.id!));assert.equal(store.forInbox('inbox_b').get(result.body.id!),null);
  });
  await t.test('signed JSON inbound uses the same scoped path',async()=>{
    const result=await request(handler(),fields(),{json:true});assert.equal(result.status,200);
    assert.ok(store.forInbox('inbox_a').get(result.body.id!));
  });
  await t.test('actual Express raw-body route uses the private dependency and fails closed when missing',async()=>{
    const runtime={config,store,inbox:new InboxService(store),privateSmsIngest:deps.ingest} as DevCaughtRuntime;
    const before=count();assert.equal(await apiRequest(runtime,fields()),200);assert.equal(count(),before+1);
    runtime.privateSmsIngest=undefined;
    assert.equal(await apiRequest(runtime,fields()),503);assert.equal(count(),before+1);
  });
  await t.test('duplicate retries return the original scoped id',async()=>{
    const input=fields();const before=count();
    const first=await request(handler(),input),second=await request(handler(),input);
    assert.equal(first.status,200);assert.equal(second.body.id,first.body.id);assert.equal(count(),before+1);
  });
  await t.test('dedupe is account-namespaced even when accounts share an inbox',async()=>{
    const id=sid(),before=count();
    const a=await request(handler(),fields({MessageSid:id}));
    const b=await request(handler(deps.ingest,{twilioAccountSid:accountB}),fields({AccountSid:accountB,MessageSid:id}));
    assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.body.id,b.body.id);assert.equal(count(),before+2);
  });
  await t.test('different inboxes cannot return each other\'s duplicate or stored message',async()=>{
    const id=sid();const a=await request(handler(),fields({MessageSid:id}));
    const b=await request(handler(),fields({MessageSid:id,To:'+14155550102'}));
    assert.equal(b.status,200);assert.notEqual(a.body.id,b.body.id);
    assert.equal(store.forInbox('inbox_a').get(b.body.id!),null);assert.equal(store.forInbox('inbox_b').get(a.body.id!),null);
  });
  await t.test('bad signature and configured account mismatch reject before lookup',async()=>{
    let calls=0;const h=handler(async(...args)=>{calls++;return deps.ingest(...args);});const before=count();
    assert.equal((await request(h,fields(),{badSignature:true})).status,403);
    assert.equal((await request(h,fields(),{json:true,tamper:true})).status,403);
    assert.equal((await request(h,'{malformed',{json:true})).status,400);
    assert.equal((await request(h,fields({AccountSid:accountB}))).status,403);
    assert.equal(calls,0);assert.equal(count(),before);
  });
  await t.test('malformed identities, missing stable ID and delivery statuses never persist',async()=>{
    const before=count();
    for(const extra of [
      {AccountSid:''},{AccountSid:['ambiguous']},{To:'4155550101'},{To:['+14155550101']},
      {To:'+14155550101,+14155550102'},{MessageSid:''},{MessageSid:'SMshort'},
      {SmsMessageSid:sid()},{Body:42},{From:''},{MessageStatus:'delivered'},{SmsStatus:'sent'},{ErrorCode:'0'},
    ])assert.equal((await request(handler(),fields(extra),{json:true})).status,400);
    const missing=fields();delete (missing as Partial<typeof missing>).MessageSid;
    assert.equal((await request(handler(),missing)).status,400);
    assert.equal((await request(handler(),{MessageSid:sid(),MessageStatus:'received'},{json:true})).status,400);
    assert.equal(count(),before);
  });
  await t.test('duplicate form and JSON fields, including escaped key names, reject after signature verification',async()=>{
    const before=count(),input=fields();
    const form=new URLSearchParams(input).toString();
    for(const key of ['AccountSid','To','MessageSid','SmsMessageSid']) {
      const base=key==='SmsMessageSid'?form+'&SmsMessageSid='+input.MessageSid:form;
      const value=key==='AccountSid'?accountA:key==='To'?input.To:input.MessageSid;
      assert.equal((await request(handler(),base+'&'+key+'='+encodeURIComponent(value))).status,400);
    }
    const raw=JSON.stringify(input);
    for(const key of ['AccountSid','To','MessageSid','\\u0054o']) {
      const value=key==='AccountSid'?accountA:key==='MessageSid'?input.MessageSid:input.To;
      assert.equal((await request(handler(),raw.slice(0,-1)+',"'+key+'":'+JSON.stringify(value)+'}',{json:true})).status,400);
    }
    // Strings containing braces, quotes and nested duplicate keys are not top-level identities.
    assert.equal((await request(handler(),fields({Body:'SYNTHETIC { "To": "escaped" }',metadata:{To:'nested'}}),{json:true})).status,200);
    assert.equal(count(),before+1);
  });
  await t.test('unknown, revoked and ambiguous routes reject without writes',async()=>{
    const before=count();
    for(const To of ['+14155550999','+14155550104'])assert.equal((await request(handler(),fields({To}))).status,404);
    const ambiguous=db.withPlugin({transformQuery:({node})=>node,transformResult:async({result})=>
      result.rows[0]&&'inbox_id' in result.rows[0]?{...result,rows:[...result.rows,...result.rows]}:result});
    assert.equal((await request(handler(privateSmsDependencies(ambiguous,store,config).ingest),fields())).status,404);
    assert.equal(count(),before);
  });
  await t.test('revocation is checked even for an already-stored retry',async()=>{
    const input=fields({To:'+14155550103'});assert.equal((await request(handler(),input)).status,200);
    const before=count();
    await pg.exec("RESET ROLE; UPDATE sms_inbox_route SET state='revoked',revoked_at=now() WHERE destination='+14155550103'; SET ROLE devcaught_auth_app;");
    assert.equal((await request(handler(),input)).status,404);assert.equal(count(),before);
  });
  await t.test('database errors, wrong role and SQLite errors fail without exposing details or root fallback',async()=>{
    const before=count();
    const broken=db.withPlugin({transformQuery(){throw new Error('SYNTHETIC PRIVATE DATABASE DETAIL');},transformResult:async({result})=>result});
    const failure=await request(handler(privateSmsDependencies(broken,store,config).ingest),fields());
    assert.equal(failure.status,503);assert.doesNotMatch(JSON.stringify(failure.body),/DETAIL/);
    await pg.exec('RESET ROLE');
    try {assert.equal((await request(handler(),fields())).status,503);} finally {await pg.exec('SET ROLE devcaught_auth_app');}
    const mock=t.mock.method(store,'forInbox',()=>{throw new Error('SYNTHETIC SQLITE DETAIL');});
    try {assert.equal((await request(handler(),fields())).status,503);} finally {mock.mock.restore();}
    assert.equal(count(),before);
  });
  await t.test('success is not acknowledged until async persistence completes',async()=>{
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    let acknowledged=false;
    const pending=request(handler(async(...args)=>{entered();await gate;return deps.ingest(...args);}),fields()).then(result=>{acknowledged=true;return result;});
    await started;assert.equal(acknowledged,false);release();assert.equal((await pending).status,200);
  });
  await t.test('missing private dependency/configuration cannot fall through to legacy storage',async()=>{
    const h=createTwilioWebhookHandler(config,()=>{rootCalls++;});
    assert.equal((await request(h,fields())).status,503);
    assert.equal((await request(handler(deps.ingest,{twilioAccountSid:undefined}),fields())).status,503);
  });
  assert.equal(rootCalls,0);
  assert.equal(store.count(),1+store.forInbox('inbox_a').count()+store.forInbox('inbox_b').count());
});

test('disabled private SMS retains legacy root storage and legacy ID/dedupe behavior',async t=>{
  const {store}=openInboxStore(':memory:');t.after(()=>store.close());const inbox=new InboxService(store);
  const legacy=createTwilioWebhookHandler({twilioAuthToken:token,twilioPublicUrl:publicUrl},(message,key)=>inbox.ingestSms(message,key));
  const input={From:'123',To:'456',Body:'SYNTHETIC LEGACY',MessageSid:'SMlegacy'};
  const a=await request(legacy,input),b=await request(legacy,input);
  assert.equal(a.status,200);assert.equal(b.body.id,a.body.id);assert.equal(store.count(),1);
  assert.equal(store.get(a.body.id!)?.sms?.verification,'unverified');
  const status={MessageSid:'SMlegacy-status',MessageStatus:'delivered'};
  const first=await request(legacy,status,{json:true}),retry=await request(legacy,status,{json:true});
  assert.equal(first.status,200);assert.equal(retry.body.id,first.body.id);
  assert.equal(store.get(first.body.id!)?.sms?.kind,'delivery_status');
  assert.equal((await request(legacy,{...status,MessageStatus:'failed'},{json:true})).status,200);
  assert.equal(store.count(),3);
});
