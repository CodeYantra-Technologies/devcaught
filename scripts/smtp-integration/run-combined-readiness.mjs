import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {diagnostic,childDiagnostic} from './diagnostics.mjs';

const image='devcaught:smtp-routing-integration-retry-1';
const container='devcaught-combined-readiness-2h16';
const evidence=mkdtempSync(join(tmpdir(),'devcaught-combined-readiness-2h16-'));
const checks=new Set(['web_entry','ingestion_bundle','dependencies','bootstrap_helper','diagnostics_helper',
  'web_spawn','web_exit','web_cleanup','web_3000','smtp_1025','ingestion_http_8025','combined_ready','deadline','entry_failure']);
const rows=[];let created=false,stage='preflight';
const save=()=>writeFileSync(join(evidence,'readiness.jsonl'),rows.map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600,flush:true});
function docker(args,timeout=10000){return spawnSync('docker',args,{encoding:'utf8',timeout,killSignal:'SIGKILL',
  maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']});}
function required(args){const result=docker(args);assert.ok(!result.error);assert.equal(result.status,0);return result.stdout.trim();}
try {
  required(['info','--format','{{.ServerVersion}}']);
  assert.ok(!required(['container','ls','-a','--format','{{.Names}}']).split('\n').includes(container));
  const imageId=required(['image','inspect','--format','{{.Id}}',image]);assert.match(imageId,/^sha256:[a-f0-9]{64}$/);
  writeFileSync(join(evidence,'image.json'),JSON.stringify({image,imageId})+'\n',{mode:0o600});
  const mounts=[['combined-readiness-entry.mjs','combined-readiness-entry.mjs'],
    ['ingestion-bootstrap.mjs','ingestion-bootstrap.mjs'],['diagnostics.mjs','diagnostics.mjs']]
    .flatMap(([source,target])=>['--mount',`type=bind,src=${fileURLToPath(new URL(source,import.meta.url))},dst=/app/${target},readonly`]);
  stage='creation';
  required(['create','--name',container,'--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges:true','--user','1000:1000','--workdir','/app',
    '--tmpfs','/app/data:rw,noexec,nosuid,size=32m,uid=1000,gid=1000,mode=0700',...mounts,
    '--env','HOST=0.0.0.0','--env','PORT=3000','--env','DEVCAUGHT_HOST=0.0.0.0',
    '--env','DEVCAUGHT_SMTP_PORT=1025','--env','DEVCAUGHT_HTTP_PORT=8025',
    '--env','DEVCAUGHT_SMTP_ROUTING_MODE=private','--env','DEVCAUGHT_REQUIRE_PERSISTENT_DB=1',
    '--env','DEVCAUGHT_DB_PATH=/app/data/combined-readiness.db',
    '--env','DEVCAUGHT_RETENTION_DAYS=0','--env','DEVCAUGHT_MAX_MESSAGES=0',
    '--entrypoint','node',imageId,'/app/combined-readiness-entry.mjs']);
  created=true;stage='readiness';
  const result=docker(['start','--attach',container],45000);
  for(const line of (result.stdout??'').split('\n')) {
    try {
      const input=JSON.parse(line);if(!checks.has(input.check))continue;
      const safe=diagnostic(input);
      rows.push({check:input.check,outcome:safe.outcome,exceptionName:safe.exceptionName,errorCode:safe.errorCode,
        exitCode:safe.exitCode,signal:safe.signal});
    }catch{}
  }
  const status=childDiagnostic(result);rows.push({check:'attach_exit',outcome:status.outcome,
    exitCode:status.exitCode,signal:status.signal,timeout:status.timeout,category:status.category});save();
  const state=JSON.parse(required(['inspect','--format',
    '{"running":{{.State.Running}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}}}',container]));
  assert.equal(typeof state.running,'boolean');assert.equal(typeof state.oomKilled,'boolean');
  assert.ok(Number.isInteger(state.exitCode)&&state.exitCode>=0&&state.exitCode<=255);
  rows.push({check:'process_exit',outcome:!state.running&&state.exitCode===0&&!state.oomKilled?'pass':'fail',
    running:state.running,exitCode:state.exitCode,oomKilled:state.oomKilled});save();
  assert.equal(status.outcome,'pass');assert.equal(state.running,false);assert.equal(state.exitCode,0);assert.equal(state.oomKilled,false);
  for(const check of ['web_3000','smtp_1025','ingestion_http_8025','combined_ready'])assert.ok(rows.some(row=>row.check===check&&row.outcome==='pass'));
}catch{rows.push({check:'runner',outcome:'fail',stage});process.exitCode=1;}
finally {
  if(created){const result=docker(['stop','--time','5',container],15000);
    const ok=result.status===0&&!result.error;rows.push({check:'cleanup_stop',outcome:ok?'pass':'fail'});
    if(!ok){process.exitCode=1;console.error(`BLOCKED: stop only ${container} manually`);}}
  save();for(const row of rows)console.log(JSON.stringify(row));
  console.log(`Sanitized evidence: ${evidence}; new stopped container retained; original image unchanged`);
}
