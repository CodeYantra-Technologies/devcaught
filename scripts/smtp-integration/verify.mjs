import assert from 'node:assert/strict';
import net from 'node:net';
import {readFileSync} from 'node:fs';
import {category,emit} from './diagnostics.mjs';

let manifest;
assert.ok(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--readiness-only'));
const readinessOnly=process.argv[2]==='--readiness-only';
let currentCase='bootstrap',substage='bootstrap:start';
function mark(name,step='start') {currentCase=name;substage=`${name}:${step}`;emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,outcome:'progress',category:'none'});}
function capture(error) {if(error && !error.diagnosticSubstage)error.diagnosticSubstage=substage;return error;}
function statusCheck(actual,expected) {if(actual!==expected)throw Object.assign(new Error('SMTP status mismatch'),{code:'SMTP_STATUS',diagnosticSubstage:substage});}
const evidence=[];
function record(check,details={}) {evidence.push({check,...details});console.log(JSON.stringify({result:'PASS',check,...details}));}
async function connect() {
  mark(currentCase,'connect');
  const socket=net.connect({host:'smtp-test',port:1025});
  socket.setTimeout(10000,()=>socket.destroy(Object.assign(new Error('SMTP timeout'),{code:'TIMEOUT'})));
  let buffer='',lines=[];const waiters=[];
  let failed;
  socket.on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\n')) {
      const end=buffer.indexOf('\n');const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
      lines.push(line);
      if(/^\d{3} /.test(line)) {const reply=lines;lines=[];waiters.shift()?.resolve(reply);}
    }
  });
  socket.on('error',error=>{failed=error;for(const waiter of waiters.splice(0)) waiter.reject(error);});
  socket.on('close',()=>{failed??=Object.assign(new Error('SMTP socket closed'),{code:'SOCKET_CLOSED'});for(const waiter of waiters.splice(0))waiter.reject(failed);});
  const reply=()=>new Promise((resolve,reject)=>{if(failed)reject(failed);else waiters.push({resolve,reject});});
  const command=async(text,expected)=>{
    const response=reply();socket.write(text+'\r\n');
    const received=await response;statusCheck(Number(received.at(-1).slice(0,3)),expected);
  };
  try {
    const greeting=await reply();assert.equal(Number(greeting.at(-1).slice(0,3)),220);
    mark(currentCase,'ehlo');await command('EHLO synthetic.integration.invalid',250);
    return {socket,command};
  }catch(error){socket.destroy();throw error;}
}
async function send(recipients,marker,{rcpt=250,data=250,beforeData}={}) {
  const client=await connect();
  try {
    mark(currentCase,'mail');await client.command('MAIL FROM:<synthetic-sender@integration.invalid>',250);
    mark(currentCase,'rcpt');
    for(const recipient of recipients) await client.command(`RCPT TO:<${recipient}>`,rcpt);
    if(rcpt!==250)return;
    if(beforeData)await beforeData();
    mark(currentCase,'data_command');await client.command('DATA',354);
    mark(currentCase,'data_body');
    await client.command(`From: spoofed@integration.invalid\r\nTo: ${manifest.b.destination}\r\nCc: attacker@integration.invalid\r\nMessage-ID: <${marker}@integration.invalid>\r\nSubject: SYNTHETIC SMTP INTEGRATION ${marker}\r\n\r\nSYNTHETIC TEST ONLY ${marker}\r\n.`,data);
  } catch(error) {throw capture(error);} finally {client.socket.destroy();}
}
async function fault(command) {
  mark(currentCase,command==='DOWN'?'proxy_down':'proxy_up');
  await new Promise((resolve,reject)=>{
    const client=net.connect('/evidence/proxy.sock');let response='';
    client.setTimeout(3000,()=>client.destroy(Object.assign(new Error('control timeout'),{code:'TIMEOUT'})));
    client.on('error',reject);client.on('connect',()=>client.write(command+'\n'));
    client.on('data',data=>{response+=data;});client.on('end',()=>{try{assert.equal(response.trim(),'OK');resolve();}catch(error){reject(error);}});
  });
}
async function main() {
  mark('manifest');manifest=JSON.parse(readFileSync('/manifest.json','utf8'));
  mark('web_ready');
  let ready=false;
  for(let i=0;i<60;i++) {
    try {
      let healthy=true;
      for(const port of [3000,8025]) {
        const r=await fetch(`http://smtp-test:${port}/api/health`,{signal:AbortSignal.timeout(2000)});
        healthy&&=r.status===200;await r.body?.cancel();
      }
      if(healthy){ready=true;break;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(ready,'test application readiness');
  mark('smtp_ready');
  let smtpReady=false;
  for(let i=0;i<30;i++) {try {const client=await connect();client.socket.destroy();smtpReady=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}
  assert.ok(smtpReady,'SMTP startup');
  // Opens only the newly created integration volume, never any application volume.
  mark('sqlite_open');const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync('/evidence/smtp-integration.db',{readOnly:true});
  try {
    const rows=()=>db.prepare('SELECT inbox_id,subject FROM messages ORDER BY id').all();
    const check=(a,b)=>{
      mark(currentCase,'sqlite_check');
      const stored=rows();assert.equal(stored.length,a+b);
      assert.equal(stored.filter(r=>r.inbox_id===manifest.a.inbox).length,a);
      assert.equal(stored.filter(r=>r.inbox_id===manifest.b.inbox).length,b);
      assert.equal(stored.filter(r=>r.inbox_id===null).length,0);
      assert.ok(stored.every(r=>r.subject.startsWith('SYNTHETIC SMTP INTEGRATION '+manifest.run)));
    };
    mark('initial');check(0,0);
    if(readinessOnly) {
      await fault('UP');
      mark('complete');emit({component:'verifier',executionStage:'verifier execution',
        verifierSubstage:substage,outcome:'pass',exitCode:0,category:'none'});
      return;
    }
    mark('owner_a');await send([manifest.a.destination],manifest.run+'-owner-a');check(1,0);
    mark('owner_b');await send([manifest.b.destination],manifest.run+'-owner-b');check(1,1);
    mark('aliases');await send([manifest.a.destination,manifest.alias],manifest.run+'-aliases');check(2,1);
    record('owner delivery ignores spoofed headers; same-owner aliases store once');
    mark('unknown');await send([`unknown-${manifest.run}@integration.invalid`],manifest.run+'-unknown',{rcpt:550});check(2,1);
    mark('revoked');await send([manifest.revoked],manifest.run+'-revoked',{rcpt:550});check(2,1);
    mark('mixed');await send([manifest.a.destination,manifest.b.destination],manifest.run+'-mixed',{data:550});check(2,1);
    record('unknown/revoked recipients and cross-owner DATA reject with 550; no fallback writes');
    mark('database_rcpt_fault');await fault('DOWN');
    try {await send([manifest.a.destination],manifest.run+'-db-down',{rcpt:451});check(2,1);}
    finally {await fault('UP');}
    mark('database_data_fault');try {await send([manifest.a.destination],manifest.run+'-db-down-data',{data:451,beforeData:()=>fault('DOWN')});check(2,1);}
    finally {await fault('UP');}
    mark('recovery');await send([manifest.a.destination],manifest.run+'-recovery');check(3,1);
    record('isolated PostgreSQL connection outage returns 451; no fallback; recovery delivers');
    const marker=manifest.run+'-retry';
    mark('retry_first');await send([manifest.a.destination],marker);mark('retry_second');await send([manifest.a.destination],marker);check(5,1);
    assert.equal(rows().filter(r=>r.subject.endsWith(marker)).length,2);
    record('identical SMTP retry stores two messages (current behavior)',{retryRows:2});
    mark('api_guard');for(const path of ['/api/messages','/api/status','/api/messages/not-a-uuid','/api/messages/not-a-uuid/raw']) {
      assert.equal((await fetch('http://smtp-test:3000'+path,{signal:AbortSignal.timeout(5000)})).status,503);
    }
    for(const path of ['/api/messages/test','/api/messages/clear'])assert.equal((await fetch('http://smtp-test:3000'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)})).status,503);
    assert.equal((await fetch('http://smtp-test:3000/api/messages/not-a-uuid',{method:'DELETE',signal:AbortSignal.timeout(5000)})).status,503);
    record('normal private API guard remains 503');
    record('final scoped persistence and zero unassigned rows',{ownerA:5,ownerB:1,unassigned:0});
    mark('complete');emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,outcome:'pass',exitCode:0,category:'none'});
  } finally {db.close();}
}
emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:substage,outcome:'start',category:'none'});
main().catch(error=>{emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:error?.diagnosticSubstage??substage,outcome:'fail',exitCode:1,category:category(error),timeout:category(error)==='timeout'?'socket_timeout':'none'});process.exitCode=1;});
