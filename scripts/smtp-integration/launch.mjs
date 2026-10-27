import net from 'node:net';
import {readFileSync, chownSync, chmodSync,appendFileSync,writeSync} from 'node:fs';
import {spawn} from 'node:child_process';
let applicationPhase='bootstrap',shutdownReason=null;
function event({processName='launcher',outcome='progress',exitCode=null,signal=null,category='none',reason=shutdownReason}={}) {
  const row={kind:'smtp_integration_diagnostic',component:'application',executionStage:'container startup',verifierSubstage:'not_started',outcome,
    exitCode:Number.isInteger(exitCode)&&exitCode>=0&&exitCode<=255?exitCode:null,
    signal:['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGHUP','SIGPIPE'].includes(signal)?signal:null,
    timeout:'none',category:['none','child_exit','child_signal','spawn_failure','permission','file_missing','postgres_dependency','unknown'].includes(category)?category:'unknown',
    processName:['launcher','web','ingestion'].includes(processName)?processName:'launcher',applicationPhase,
    shutdownReason:['cleanup_requested','peer_exit','unexpected_exit','startup_failure'].includes(reason)?reason:null,
    cleanupRequested:reason==='cleanup_requested'};
  const line=JSON.stringify(row)+'\n';
  try {appendFileSync('/app/data/process-diagnostics.jsonl',line,{mode:0o600,flush:true});}
  catch {writeSync(1,line);}
}

// This proxy exists only in the new test container. It never controls PostgreSQL.
const sockets = new Set();
let available = true;
const proxy = net.createServer(client => {
  // Observation only: retain the actual proxy path, but make any startup database
  // dependency visible to the isolated preflight without logging connection data.
  if(process.env.DEVCAUGHT_LAUNCHER_PREFLIGHT==='1')event({outcome:'fail',category:'postgres_dependency',reason:'startup_failure'});
  if (!available) {client.destroy(); return;}
  const upstream = net.connect({host:'postgres-dev',port:5432});
  for (const socket of [client,upstream]) {
    sockets.add(socket);
    socket.on('error',()=>{client.destroy();upstream.destroy();});
    socket.on('close',()=>{sockets.delete(socket);client.destroy();upstream.destroy();});
  }
  client.pipe(upstream).pipe(client);
});
const control = net.createServer(client => {
  client.setTimeout(2000,()=>client.destroy());
  let input='';
  client.on('error',()=>{});
  client.on('data',data=>{
    input+=data;
    if(input.length>20) {client.destroy();return;}
    if(!input.includes('\n')) return;
    const command=input.trim();
    if(command==='DOWN') {available=false;for(const socket of sockets) socket.destroy();}
    else if(command==='UP') available=true;
    else {client.end('ERROR\n');return;}
    client.end('OK\n');
  });
});
async function main() {
  // Default SMTP profile remains web-owned. SMS uses only the fresh standalone
  // bundle; never run the historical web bundle alongside it.
  const owner=process.env.DEVCAUGHT_INTEGRATION_INGESTION_OWNER??'web';
  if(!['web','sms','private-api-test'].includes(owner)) {
    throw new Error('unsupported harness listener owner');
  }
  if(owner==='sms'&&(process.env.DEVCAUGHT_SMS_ROUTING_MODE!=='private'||
    (process.env.DEVCAUGHT_SMTP_ROUTING_MODE??'')!==''))throw new Error('unsupported SMS harness configuration');
  if(owner==='private-api-test'&&(!/^[a-f0-9-]{36}$/.test(process.env.DEVCAUGHT_PRIVATE_API_RUN??'')||
    process.env.DEVCAUGHT_DB_PATH!=='/app/data/private-api-acceptance.db'||process.env.PORT!=='3000')) {
    throw new Error('unsupported private API test configuration');
  }
  event({outcome:'start'});applicationPhase='credentials';event();
  const secret=name=>{
    const value=readFileSync(`/run/secrets/${name}`,'utf8').trim();
    if(!/^[a-f0-9]{64}$/.test(value)) throw new Error('credential format');
    return value;
  };
  const url=new URL('postgresql://devcaught_auth_app@127.0.0.1:15432/devcaught_auth_dev');
  url.password=secret('app_password');
  const env={...process.env,DATABASE_URL:url.toString(),
    ...(owner==='web'?{BETTER_AUTH_SECRET:secret('better_auth_secret')}:{})};
  applicationPhase='volume';event();chownSync('/app/data',1000,1000);
  // Let the unprivileged harness bootstrap append only structured startup events.
  chownSync('/app/data/process-diagnostics.jsonl',1000,1000);
  applicationPhase='proxy';event();
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(15432,'127.0.0.1',resolve);});
  await new Promise((resolve,reject)=>{control.once('error',reject);control.listen('/app/data/proxy.sock',resolve);});
  chownSync('/app/data/proxy.sock',1000,1000);chmodSync('/app/data/proxy.sock',0o600);
  applicationPhase='children';event();
  const children=[owner==='sms'?'ingestion-bootstrap.mjs':'.output/server/index.mjs']
    .map(file=>spawn(process.execPath,[file],{cwd:'/app',env,uid:1000,gid:1000,stdio:['inherit','inherit','ignore']}));
  let exiting=false;
  const stop=signal=>{for(const child of children)child.kill(signal);};
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{shutdownReason='cleanup_requested';event({outcome:'observation',signal});stop(signal);});
  for(const child of children) {
    const processName=owner==='sms'?'ingestion':'web';
    child.on('error',()=>{event({processName,outcome:'fail',category:'spawn_failure',reason:'startup_failure'});shutdownReason='peer_exit';stop('SIGTERM');process.exitCode=1;});
    child.on('exit',(code,signal)=>{
      event({processName,outcome:shutdownReason==='cleanup_requested'?'observation':'fail',exitCode:code,signal,category:signal?'child_signal':'child_exit',reason:shutdownReason??'unexpected_exit'});
      if(exiting)return;exiting=true;
      shutdownReason??='peer_exit';stop('SIGTERM');for(const socket of sockets)socket.destroy();proxy.close();control.close();process.exitCode=code??1;
    });
  }
}
main().catch(error=>{event({outcome:'fail',exitCode:1,reason:'startup_failure',category:({EACCES:'permission',EPERM:'permission',ENOENT:'file_missing'})[error?.code]??'unknown'});process.exit(1);});
