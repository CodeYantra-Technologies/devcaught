import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SMTPServer} from 'smtp-server';
import {loadConfig} from '../../config.ts';
import {openInboxStore} from '../../store/sqlite.ts';
import {InboxService} from '../inboxService.ts';
import {configuredPrivateSmsDependencies} from './private-routing.ts';
import {ensureRuntime} from '../../runtime.ts';

const account='AC'+'a'.repeat(32);
function environment(values:Record<string,string|undefined>) {
  const before=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  const set=(input:Record<string,string|undefined>)=>{for(const [key,value] of Object.entries(input)) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }};
  set(values);return ()=>set(before);
}
const privateEnv={DEVCAUGHT_SMS_ROUTING_MODE:'private',TWILIO_ACCOUNT_SID:account,
  TWILIO_AUTH_TOKEN:'SYNTHETIC_TOKEN',TWILIO_PUBLIC_URL:'https://synthetic.invalid/api/webhooks/twilio'};

test('private SMS configuration is opt-in, strict and binds a valid configured account',()=>{
  const restore=environment({...privateEnv});
  try {
    assert.equal(loadConfig().smsRoutingMode,'private');assert.equal(loadConfig().twilioAccountSid,account);
    for(const [key,value] of [['DEVCAUGHT_SMS_ROUTING_MODE','typo'],['TWILIO_ACCOUNT_SID',''],
      ['TWILIO_ACCOUNT_SID','ACshort'],['TWILIO_AUTH_TOKEN',''],['TWILIO_PUBLIC_URL','http://synthetic.invalid']]) {
      const undo=environment({[key]:value});try{assert.throws(()=>loadConfig());}finally{undo();}
    }
    process.env.DEVCAUGHT_SMS_ROUTING_MODE='';process.env.TWILIO_ACCOUNT_SID='invalid';
    assert.equal(loadConfig().smsRoutingMode,undefined);assert.equal(loadConfig().twilioAccountSid,undefined);
  }finally{restore();}
});
test('persistent storage cannot downgrade to memory for private SMS',()=>{
  assert.throws(()=>openInboxStore(':memory:',{requirePersistent:true}));
  assert.throws(()=>openInboxStore('/dev/null/SYNTHETIC-private-sms.db',{requirePersistent:true}));
});
test('private SMS rejects missing or invalid PostgreSQL config without connecting',()=>{
  const restore=environment({...privateEnv,DATABASE_URL:undefined});const {store}=openInboxStore(':memory:');
  try {
    for(const value of [undefined,'invalid','sqlite:synthetic','postgresql://wrong_role@127.0.0.1:9/synthetic']) {
      const undo=environment({DATABASE_URL:value});try{assert.throws(()=>configuredPrivateSmsDependencies(store,loadConfig()));}finally{undo();}
    }
  }finally{store.close();restore();}
});
test('runtime fails before listeners for missing PostgreSQL or memory-only private SMS',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'devcaught-private-sms-fail-'));
  const restore=environment({...privateEnv,DATABASE_URL:undefined,DEVCAUGHT_DB_PATH:join(dir,'synthetic.db')});
  try {
    await assert.rejects(ensureRuntime(),/configured PostgreSQL/);
    process.env.DEVCAUGHT_DB_PATH=':memory:';
    await assert.rejects(ensureRuntime(),/persistent SQLite/);
  }finally{restore();rmSync(dir,{recursive:true,force:true});}
});
test('private SMS prevents boot-time and root-triggered global retention; pool closes with runtime',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'devcaught-private-sms-retention-')),path=join(dir,'synthetic.db');
  const restore=environment({...privateEnv,DEVCAUGHT_DB_PATH:path,DEVCAUGHT_RETENTION_DAYS:'1',DEVCAUGHT_MAX_MESSAGES:'1',
    DEVCAUGHT_SMTP_ROUTING_MODE:undefined,DATABASE_URL:'postgresql://devcaught_auth_app@127.0.0.1:9/synthetic'});
  // Suppress actual listener binding: no SMTP connection, command or transaction.
  const listen=t.mock.method(SMTPServer.prototype,'listen',function(this:SMTPServer,...args:unknown[]) {
    queueMicrotask(args.at(-1) as ()=>void);return this.server;
  });
  const close=t.mock.method(SMTPServer.prototype,'close',function(callback:()=>void){callback();});
  const {store}=openInboxStore(path,{requirePersistent:true});
  const message={type:'sms' as const,source:'http' as const,sender:'masked',recipient:'masked',subject:'SYNTHETIC OLD',
    textBody:'synthetic',htmlBody:'',rawData:'{}',createdAt:1};
  new InboxService(store.forInbox('inbox_a')).ingestSms(message,'synthetic-a');
  new InboxService(store.forInbox('inbox_b')).ingestSms(message,'synthetic-b');store.close();
  let runtime:Awaited<ReturnType<typeof ensureRuntime>>|undefined;
  try {
    runtime=await ensureRuntime();assert.equal(runtime.dbMode,'file');assert.ok(runtime.privateSmsIngest);
    assert.equal(runtime.store.count(),2);
    runtime.inbox.ingest({...message,type:'email',createdAt:Date.now()});
    assert.equal(runtime.store.forInbox('inbox_a').count(),1);assert.equal(runtime.store.forInbox('inbox_b').count(),1);
    assert.equal(runtime.store.count(),3);
  }finally {
    try{await runtime?.smtp.close();}finally{runtime?.store.close();listen.mock.restore();close.mock.restore();restore();rmSync(dir,{recursive:true,force:true});}
  }
});
