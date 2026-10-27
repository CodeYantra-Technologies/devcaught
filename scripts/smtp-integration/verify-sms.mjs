import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {emit,category} from './diagnostics.mjs';
import {validateManifest,syntheticToken,readinessCheck,requiredChecks} from './sms-profile.mjs';

let substage='bootstrap:start',manifest;
const mark=(name,step='start')=>{substage=`${name}:${step}`;emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,outcome:'progress',category:'none'});};
const record=(check,details={})=>console.log(JSON.stringify({result:'PASS',check,...details}));
const base='http://sms-test:8025';
const sid=label=>'SM'+createHash('sha256').update(`${manifest.run}:${label}`).digest('hex').slice(0,32);
const signature=(url,params)=>{
  let value=url;
  for(const key of [...new Set(params.keys())].sort())for(const item of [...new Set(params.getAll(key))])value+=key+item;
  return createHmac('sha1',syntheticToken).update(value).digest('base64');
};
async function post(label,destination,{json=false,expected=200,badSignature=false,account=manifest.accountSid,extra={},duplicateTo=false}={}) {
  const fields={AccountSid:account,To:destination,From:'+15555550199',Body:`SYNTHETIC SMS INTEGRATION ${manifest.run} ${label}`,
    MessageSid:sid(label),SmsStatus:'received',...extra};
  const params=new URLSearchParams(fields);if(duplicateTo)params.append('To',destination);
  const body=json?JSON.stringify(fields):params.toString();
  const query=json?'?bodySHA256='+createHash('sha256').update(body).digest('hex'):'';
  // Public URL is only signed as text. All requests go to the internal service.
  const signed=signature(manifest.publicUrl+query,json?new URLSearchParams():params);
  const response=await fetch(base+'/api/webhooks/twilio'+query,{method:'POST',signal:AbortSignal.timeout(5000),
    headers:{'content-type':json?'application/json':'application/x-www-form-urlencoded','x-twilio-signature':badSignature?'invalid':signed},body});
  try {
    emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,
      outcome:response.status===expected?'observation':'fail',category:response.status===expected?'none':'http_status_mismatch',httpStatus:response.status});
    if(response.status!==expected)throw Object.assign(new Error('Synthetic SMS HTTP status mismatch'),{code:'HTTP_STATUS'});
    if(expected===200) {
      const result=await response.json();assert.equal(result.ok,true);
      assert.match(result.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      return result.id;
    }
  }finally{await response.body?.cancel().catch(()=>{});}
}
async function control(command) {
  await new Promise((resolve,reject)=>{
    const socket=net.connect('/evidence/proxy.sock');let reply='',done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve();};
    const timer=setTimeout(()=>finish(Object.assign(new Error('Control timeout'),{code:'TIMEOUT'})),2000);
    socket.on('error',finish);
    socket.on('connect',()=>socket.write(command+'\n'));
    socket.on('data',data=>{reply+=data;if(reply.length>20)finish(new Error('Control response invalid'));});
    socket.on('end',()=>{try{assert.equal(reply,'OK\n');finish();}catch(error){finish(error);}});
    socket.on('close',()=>finish(Object.assign(new Error('Control closed'),{code:'SOCKET_CLOSED'})));
  });
}
async function main() {
  assert.ok(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--readiness-only'));
  mark('manifest');manifest=JSON.parse(readFileSync('/manifest.json','utf8'));validateManifest(manifest);
  mark('sms_ready');let healthy=false;
  for(let i=0;i<30;i++) {
    try {const response=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)});
      healthy=response.status===200;await response.body?.cancel();if(healthy)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(healthy);
  mark('sqlite_open');const db=new DatabaseSync('/evidence/sms-integration.db',{readOnly:true});
  try {
    const rows=()=>db.prepare('SELECT id,inbox_id,type,subject,raw_data FROM messages').all();
    const check=(a,b)=>{
      const stored=rows();assert.equal(stored.length,a+b);
      assert.equal(stored.filter(row=>row.inbox_id===manifest.a.inbox).length,a);
      assert.equal(stored.filter(row=>row.inbox_id===manifest.b.inbox).length,b);
      assert.equal(stored.filter(row=>row.inbox_id===null).length,0);
      assert.ok(stored.every(row=>row.type==='sms'&&JSON.parse(row.raw_data).sms?.verification==='valid'));
    };
    mark('sms_pre_fixture','sqlite_check');check(0,0);
    await control('UP');
    mark('sms_pre_fixture','request');
    await post('absent',manifest.unknown,{expected:404});check(0,0);
    await post('bad-signature-before-fixtures',manifest.unknown,{expected:403,badSignature:true});check(0,0);
    record(readinessCheck,{unassigned:0});
    if(process.argv[2]!=='--readiness-only') {
      mark('sms_form','request');
      const a=await post('form_a',' '+manifest.a.destination+' ',{extra:{inboxId:manifest.b.inbox,ownerId:manifest.b.user}});check(1,0);
      mark('sms_json','request');const b=await post('json_b',manifest.b.destination,{json:true});check(1,1);
      mark('sms_isolation','sqlite_check');assert.notEqual(a,b);
      for(const [id,inbox,other,label] of [[a,manifest.a.inbox,manifest.b.inbox,'form_a'],[b,manifest.b.inbox,manifest.a.inbox,'json_b']]) {
        assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE id=? AND inbox_id=? AND subject=?').get(id,inbox,sid(label)).n,1);
        assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE id=? AND inbox_id=?').get(id,other).n,0);
      }
      record(requiredChecks[0],{ownerA:1,ownerB:1,unassigned:0});
      mark('sms_duplicate','request');
      assert.equal(await post('form_a',' '+manifest.a.destination+' ',{extra:{inboxId:manifest.b.inbox,ownerId:manifest.b.user}}),a);check(1,1);
      record(requiredChecks[1],{retryRows:1});
      const otherAccount='AC'+(manifest.accountSid[2]==='f'?'e':'f')+manifest.accountSid.slice(3);
      mark('sms_auth','request');await post('wrong-account',manifest.a.destination,{json:true,account:otherAccount,expected:403});check(1,1);
      await post('bad-signature',manifest.a.destination,{badSignature:true,expected:403});check(1,1);
      mark('sms_unknown','request');await post('unknown',manifest.unknown,{expected:404});check(1,1);
      mark('sms_revoked','request');await post('revoked',manifest.revoked,{expected:404});check(1,1);
      mark('sms_malformed','request');await post('duplicate-field',manifest.a.destination,{duplicateTo:true,expected:400});check(1,1);
      await post('delivery-status',manifest.a.destination,{json:true,extra:{MessageStatus:'delivered'},expected:400});check(1,1);
      record(requiredChecks[2]);
      mark('sms_database_fault','proxy_down');await control('DOWN');
      try {mark('sms_database_fault','request');await post('database-down',manifest.a.destination,{expected:503});check(1,1);}
      finally {mark('sms_database_fault','proxy_up');await control('UP');}
      mark('sms_recovery','request');await post('recovery',manifest.a.destination);check(2,1);
      record(requiredChecks[3]);record(requiredChecks[4],{ownerA:2,ownerB:1,unassigned:0});
    }
    mark('complete');emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,outcome:'pass',exitCode:0,category:'none'});
  }finally{db.close();}
}
const deadline=setTimeout(()=>{emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,
  outcome:'fail',category:'timeout',timeout:'verifier_timeout',exitCode:1});process.exit(1);},90000);
emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,outcome:'start',category:'none'});
main().catch(error=>{emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,
  outcome:'fail',category:category(error),exitCode:1});process.exitCode=1;}).finally(()=>clearTimeout(deadline));
