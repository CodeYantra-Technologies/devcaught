import {spawn} from 'node:child_process';
import {statSync,writeSync} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {diagnostic} from './diagnostics.mjs';

const report=row=>writeSync(1,JSON.stringify(row)+'\n');
let child,finished=false,exited=false;
function finish(ok) {
  if(finished)return;finished=true;clearTimeout(deadline);
  report({check:'combined_ready',outcome:ok?'pass':'fail'});
  if(!child||exited){process.exit(ok?0:1);return;}
  child.kill('SIGTERM');
  let forcedStop=false;
  const forced=setTimeout(()=>{forcedStop=true;child.kill('SIGKILL');},3000);
  const hard=setTimeout(()=>process.exit(1),5000);
  child.once('exit',()=>{clearTimeout(forced);clearTimeout(hard);
    report({check:'web_cleanup',outcome:forcedStop?'fail':'pass'});process.exit(ok&&!forcedStop?0:1);});
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
  // Synthetic local configuration only. Network none prevents external access.
  const env={...process.env,DATABASE_URL:'postgresql://devcaught_auth_app@127.0.0.1:9/devcaught_auth_dev',
    BETTER_AUTH_SECRET:'0'.repeat(64),BETTER_AUTH_URL:'http://localhost:3000'};
  child=spawn(process.execPath,['.output/server/index.mjs'],{cwd:'/app',env,stdio:'ignore'});
  child.on('error',error=>{
    const safe=diagnostic({exceptionName:error.name,errorCode:error.code});
    report({check:'web_spawn',outcome:'fail',exceptionName:safe.exceptionName,errorCode:safe.errorCode});finish(false);
  });
  child.on('exit',(code,signal)=>{
    exited=true;const safe=diagnostic({exitCode:code,signal});
    report({check:'web_exit',outcome:finished?'observation':'fail',exitCode:safe.exitCode,signal:safe.signal});
    if(!finished)finish(false);
  });
  let ready=false;
  while(!finished) {
    const results=await Promise.all([httpReady(3000),smtpReady(),httpReady(8025)]);
    if(results.every(Boolean)) {
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
