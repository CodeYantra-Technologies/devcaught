import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {diagnostic,childDiagnostic} from './diagnostics.mjs';

// Reuse the full-derived retry image without rebuilding or replacing its bundle.
const image='devcaught:smtp-routing-integration-retry-1';
const container='devcaught-single-ingestion-startup-2h14';
const entry=fileURLToPath(new URL('./smoke-entry.mjs',import.meta.url));
const bootstrap=fileURLToPath(new URL('./ingestion-bootstrap.mjs',import.meta.url));
const diagnostics=fileURLToPath(new URL('./diagnostics.mjs',import.meta.url));
const evidence=mkdtempSync(join(tmpdir(),'devcaught-single-ingestion-2h14-'));
let stage='preflight',created=false;
function docker(args,timeout=10000) {
  return spawnSync('docker',args,{encoding:'utf8',timeout,killSignal:'SIGKILL',
    maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']});
}
function required(args) {
  const result=docker(args);assert.ok(!result.error);assert.equal(result.status,0);
  return result.stdout.trim();
}
function save(rows) {
  writeFileSync(join(evidence,'startup.jsonl'),rows.map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600,flush:true});
}
const rows=[];
try {
  required(['info','--format','{{.ServerVersion}}']);
  assert.ok(!required(['container','ls','-a','--format','{{.Names}}']).split('\n').includes(container));
  const imageId=required(['image','inspect','--format','{{.Id}}',image]);
  assert.match(imageId,/^sha256:[a-f0-9]{64}$/);
  writeFileSync(join(evidence,'image.json'),JSON.stringify({image,imageId})+'\n',{mode:0o600});
  stage='container creation';
  required(['create','--name',container,'--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges:true','--user','1000:1000','--workdir','/app',
    '--tmpfs','/app/data:rw,noexec,nosuid,size=32m,uid=1000,gid=1000,mode=0700',
    '--mount',`type=bind,src=${entry},dst=/app/single-ingestion-entry.mjs,readonly`,
    '--mount',`type=bind,src=${bootstrap},dst=/app/ingestion-bootstrap.mjs,readonly`,
    '--mount',`type=bind,src=${diagnostics},dst=/app/diagnostics.mjs,readonly`,
    '--env','DEVCAUGHT_SMTP_ROUTING_MODE=private',
    '--env','DEVCAUGHT_DB_PATH=/app/data/single-ingestion.db',
    '--env','DEVCAUGHT_REQUIRE_PERSISTENT_DB=1',
    '--env','DEVCAUGHT_RETENTION_DAYS=0','--env','DEVCAUGHT_MAX_MESSAGES=0',
    '--entrypoint','node',imageId,'/app/single-ingestion-entry.mjs']);
  created=true;stage='startup';
  const result=docker(['start','--attach',container],45000);
  for(const line of (result.stdout??'').split('\n')) {
    try {
      const input=JSON.parse(line);
      if(!['module_import','runtime_initialization','listener_start','ready'].includes(input.startupPhase))continue;
      const safe=diagnostic(input);
      rows.push({startupPhase:safe.startupPhase,outcome:safe.outcome,
        exceptionName:safe.exceptionName,errorCode:safe.errorCode});
    }catch{}
  }
  const status=childDiagnostic(result,{component:'application',executionStage:'ingestion startup'});
  rows.push({check:'attach_exit',outcome:status.outcome,exitCode:status.exitCode,
    signal:status.signal,timeout:status.timeout,category:status.category});
  save(rows);
  // Docker attach status is distinct from the actual container process outcome.
  const state=JSON.parse(required(['inspect','--format',
    '{"running":{{.State.Running}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}}}',container]));
  assert.equal(typeof state.running,'boolean');assert.equal(typeof state.oomKilled,'boolean');
  assert.ok(Number.isInteger(state.exitCode)&&state.exitCode>=0&&state.exitCode<=255);
  rows.push({check:'process_exit',outcome:!state.running&&state.exitCode===0&&!state.oomKilled?'pass':'fail',
    running:state.running,exitCode:state.exitCode,oomKilled:state.oomKilled});
  save(rows);
  assert.equal(status.outcome,'pass');assert.equal(state.running,false);
  assert.equal(state.exitCode,0);assert.equal(state.oomKilled,false);
  for(const phase of ['module_import','runtime_initialization','listener_start','ready']) {
    assert.ok(rows.some(row=>row.startupPhase===phase));
  }
  assert.ok(rows.some(row=>row.startupPhase==='ready'&&row.outcome==='pass'));
  console.log('PASS: full-derived image, standalone ingestion only; no PostgreSQL or SMTP transactions');
}catch{
  rows.push({check:'runner',outcome:'fail',stage});save(rows);
  console.error(`BLOCKED: ${stage}; only sanitized evidence retained`);process.exitCode=1;
}finally{
  // Only a successfully created new container can be stopped. Never remove resources.
  if(created) {
    const stopped=docker(['stop','--time','5',container],15000);
    rows.push({check:'cleanup_stop',outcome:stopped.status===0&&!stopped.error?'pass':'fail'});
    if(stopped.status!==0||stopped.error){console.error(`BLOCKED: stop only ${container} manually`);process.exitCode=1;}
  }
  save(rows);
  for(const row of rows)console.log(JSON.stringify(row));
  console.log(`Sanitized evidence: ${evidence}; new container retained; no image build or persistent volume`);
}
