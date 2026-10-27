import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {diagnostic,childDiagnostic} from './diagnostics.mjs';

process.chdir(fileURLToPath(new URL('../../',import.meta.url)));
const image='devcaught:ingestion-startup-smoke';
const container='devcaught-ingestion-startup-smoke';
const evidence=mkdtempSync(join(tmpdir(),'devcaught-ingestion-smoke-'));
let stage='preflight',attempted=false;
function docker(args,timeout=60000) {
  return spawnSync('docker',args,{encoding:'utf8',timeout,maxBuffer:8*1024*1024,stdio:['ignore','pipe','ignore']});
}
function required(args,timeout) {const result=docker(args,timeout);assert.equal(result.status,0);return result.stdout.trim();}
try {
  required(['info','--format','{{.ServerVersion}}']);
  assert.ok(!required(['container','ls','-a','--format','{{.Names}}']).split('\n').includes(container));
  assert.equal(required(['image','ls','-q',image]),'');
  stage='build';required(['build','-f','scripts/smtp-integration/Dockerfile.smoke','-t',image,'.'],600000);
  stage='startup';attempted=true;
  const result=docker(['run','--name',container,'--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges:true','--tmpfs','/app/data:rw,noexec,nosuid,size=32m,uid=1000,gid=1000,mode=0700',image],45000);
  const rows=[];
  for(const line of (result.stdout??'').split('\n')) {
    try {
      const input=JSON.parse(line);
      if(!['module_import','runtime_initialization','listener_start','ready'].includes(input.startupPhase))continue;
      const safe=diagnostic(input);
      rows.push({startupPhase:safe.startupPhase,outcome:safe.outcome,exceptionName:safe.exceptionName,errorCode:safe.errorCode});
    }catch{}
  }
  const status=childDiagnostic(result,{component:'application',executionStage:'ingestion startup'});
  rows.push({exitCode:status.exitCode,signal:status.signal,timeout:status.timeout});
  writeFileSync(join(evidence,'startup.jsonl'),rows.map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600,flush:true});
  for(const row of rows)console.log(JSON.stringify(row));
  assert.equal(result.status,0);assert.ok(rows.some(row=>row.startupPhase==='ready'&&row.outcome==='pass'));
  console.log('PASS: ingestion startup only; no PostgreSQL connectivity or SMTP messages tested');
}catch{console.error(`BLOCKED: ${stage}; only sanitized startup evidence is retained`);process.exitCode=1;}
finally{
  if(attempted){const stopped=docker(['stop','--time','5',container],15000);if(stopped.status!==0){console.error('BLOCKED: stop only devcaught-ingestion-startup-smoke manually');process.exitCode=1;}}
  console.log(`Startup evidence: ${evidence}; new stopped container/image retained; no persistent volume created`);
}
