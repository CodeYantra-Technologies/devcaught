import {spawn} from 'node:child_process';
import {statSync,writeSync,writeFileSync,readFileSync} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {diagnostic,parseDiagnostics,category} from './diagnostics.mjs';

const report=row=>writeSync(1,JSON.stringify(row)+'\n');
let child,finished=false,exited=false;
let lastCount=0;
const drainNotices=new Set();
function drainLauncherRecords({final=false}={}) {
  const notice=(failure,error)=>{
    if(!final||drainNotices.has(failure))return;
    drainNotices.add(failure);
    report({check:'launcher_event',...diagnostic({component:'runner',processName:'launcher',
      executionStage:'application observation',outcome:'fail',category:failure,
      applicationState:exited?'exited':null,exceptionName:error?.name,errorCode:error?.code})});
  };
  try {
    const text=readFileSync('/app/data/process-diagnostics.jsonl','utf8');
    // Only consume newline-terminated records. A concurrent partial append is
    // retried by the next poll; a final partial tail is never emitted as text.
    const end=text.lastIndexOf('\n')+1;
    const records=parseDiagnostics(text.slice(0,end));
    for(const row of records.slice(lastCount))report({check:'launcher_event',...row});
    lastCount=Math.max(lastCount,records.length);
    if(end<text.length)notice('invalid_json');
    return records;
  }catch(error){
    notice(category(error),error);
    return null;
  }
}
function finish(ok) {
  if(finished)return;finished=true;clearTimeout(deadline);
  report({check:'launcher_ready',outcome:ok?'pass':'fail'});
  if(!child||exited){drainLauncherRecords({final:true});process.exit(ok?0:1);return;}
  child.kill('SIGTERM');
  let forcedStop=false;
  const forced=setTimeout(()=>{forcedStop=true;child.kill('SIGKILL');},3000);
  const hard=setTimeout(()=>{drainLauncherRecords({final:true});process.exit(1);},5000);
  child.once('exit',()=>{clearTimeout(forced);clearTimeout(hard);
    try {
      const records=drainLauncherRecords({final:true})??[];
      const observed=records.some(row=>row.processName==='web'&&row.cleanupRequested
        &&((row.category==='child_exit'&&row.exitCode===0)||(row.category==='child_signal'&&row.signal==='SIGTERM')));
      report({check:'supervision_cleanup',outcome:observed?'pass':'fail'});
      if(!observed||records.some(row=>row.category==='postgres_dependency'))ok=false;
    }catch{ok=false;}
    report({check:'launcher_cleanup',outcome:forcedStop?'fail':'pass'});process.exit(ok&&!forcedStop?0:1);});
}
const deadline=setTimeout(()=>{report({check:'deadline',outcome:'fail'});finish(false);},30000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>finish(false));
function httpReady(port) {
  return new Promise(resolve=>{
    let done=false;
    const end=ok=>{if(done)return;done=true;clearTimeout(timer);request.destroy();resolve(ok);};
    const request=http.get({host:'127.0.0.1',port,path:'/api/health',agent:false},response=>{
      const ok=response.statusCode===200;response.destroy();end(ok);
    });
    const timer=setTimeout(()=>end(false),750);
    request.on('error',()=>end(false));
  });
}
function smtpReady() {
  return new Promise(resolve=>{
    let done=false,prefix='';
    const socket=net.connect({host:'127.0.0.1',port:1025});
    const end=ok=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(ok);};
    const timer=setTimeout(()=>end(false),750);
    socket.on('error',()=>end(false));socket.on('end',()=>end(false));
    // Read only the greeting prefix; never send any SMTP command or retain text.
    socket.on('data',data=>{prefix+=(data.subarray(0,4-prefix.length)).toString('ascii');
      if(prefix.length===4)end(prefix==='220 '||prefix==='220-');});
  });
}
try {
  for(const [check,path,directory] of [
    ['web_entry','/app/.output/server/index.mjs',false],
    ['ingestion_bundle','/app/ingestion-build/ingestion.mjs',false],
    ['dependencies','/app/node_modules',true],
    ['bootstrap_helper','/app/ingestion-bootstrap.mjs',false],
    ['diagnostics_helper','/app/diagnostics.mjs',false],
  ]) {
    const stat=statSync(path);const ok=directory?stat.isDirectory():stat.isFile();
    report({check,outcome:ok?'pass':'fail'});if(!ok)throw new Error();
  }
  // Exercise the launcher's real fixed secret-file reader with public dummy values.
  // These files exist only on a fresh /run/secrets tmpfs.
  writeFileSync('/run/secrets/app_password','1'.repeat(64),{mode:0o600,flag:'wx'});
  writeFileSync('/run/secrets/better_auth_secret','2'.repeat(64),{mode:0o600,flag:'wx'});
  const env={...process.env,DEVCAUGHT_LAUNCHER_PREFLIGHT:'1'};
  child=spawn(process.execPath,['/smtp-test-launch.mjs'],{cwd:'/app',env,stdio:'ignore'});
  child.on('error',error=>{
    const safe=diagnostic({exceptionName:error.name,errorCode:error.code});
    report({check:'launcher_spawn',outcome:'fail',exceptionName:safe.exceptionName,errorCode:safe.errorCode});finish(false);
  });
  child.on('exit',(code,signal)=>{
    exited=true;const safe=diagnostic({exitCode:code,signal});
    // The polling loop may be awaiting probes when the launcher fails rapidly.
    // Drain synchronously before finish() can terminate the supervisor.
    drainLauncherRecords({final:true});
    report({check:'launcher_exit',outcome:finished?'observation':'fail',exitCode:safe.exitCode,signal:safe.signal});
    if(!finished)finish(false);
  });
  let ready=false;
  function launcherRecords() {
    const records=drainLauncherRecords()??[];
    if(records.some(row=>row.category==='postgres_dependency')) {
      report({check:'postgres_dependency',outcome:'fail'});finish(false);
    }
    return records;
  }
  while(!finished) {
    launcherRecords();if(finished)break;
    const results=await Promise.all([httpReady(3000),smtpReady(),httpReady(8025)]);
    if(results.every(Boolean)) {
      if(!launcherRecords().some(row=>row.applicationPhase==='children')||finished)throw new Error();
      const data=statSync('/app/data'),file=statSync('/app/data/process-diagnostics.jsonl');
      const socket=statSync('/app/data/proxy.sock');
      const permissions=data.uid===1000&&data.gid===1000&&file.uid===1000&&file.gid===1000
        &&socket.uid===1000&&socket.gid===1000&&socket.isSocket()&&(socket.mode&0o777)===0o600;
      report({check:'launcher_permissions',outcome:permissions?'pass':'fail'});
      if(!permissions)throw new Error();
      // Exercise the control socket as the verifier's UID; no PostgreSQL traffic.
      const controlOk=await new Promise(resolve=>{
        const probe=spawn(process.execPath,['--input-type=module','-e',
          "import net from 'node:net';const s=net.connect('/app/data/proxy.sock');let reply='';const t=setTimeout(()=>process.exit(1),1000);s.on('error',()=>process.exit(1));s.on('connect',()=>s.write('UP\\n'));s.on('data',d=>{reply+=d;if(reply.length>20)process.exit(1);});s.on('end',()=>{clearTimeout(t);process.exit(reply==='OK\\n'?0:1);});"],
          {uid:1000,gid:1000,stdio:'ignore'});
        probe.on('error',()=>resolve(false));probe.on('exit',code=>resolve(code===0));
      });
      report({check:'control_socket',outcome:controlOk?'pass':'fail'});if(!controlOk)throw new Error();
      launcherRecords();if(finished)break;
      for(const check of ['web_3000','smtp_1025','ingestion_http_8025'])report({check,outcome:'pass'});
      ready=true;break;
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(ready&&!finished)finish(true);
}catch(error){
  const safe=diagnostic({exceptionName:error?.name,errorCode:error?.code});
  report({check:'entry_failure',outcome:'fail',exceptionName:safe.exceptionName,errorCode:safe.errorCode});finish(false);
}
