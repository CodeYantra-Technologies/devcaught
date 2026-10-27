import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {diagnostic,childDiagnostic,category} from './diagnostics.mjs';

const historical='devcaught:smtp-routing-integration-retry-1';
const expectedBaseId='sha256:720d70dce51ab1613b55610a0f448aa2f66a7b3ed33440b6fa2658c536caaf0b';
const image='devcaught:launcher-preflight-2h26',container='devcaught-launcher-preflight-2h26';
const ownership=randomUUID(),label='devcaught.launcher-preflight-owner';
const root=fileURLToPath(new URL('../../',import.meta.url));
const evidence=mkdtempSync(join(tmpdir(),'devcaught-launcher-preflight-2h26-'));
const rows=[];let stage='preflight',attempted=false,interrupted=false,active;
const checks=new Set(['web_entry','ingestion_bundle','dependencies','bootstrap_helper','diagnostics_helper',
  'launcher_ready','launcher_spawn','launcher_exit','launcher_cleanup','supervision_cleanup','launcher_event',
  'postgres_dependency','launcher_permissions','control_socket','web_3000','smtp_1025','ingestion_http_8025','deadline','entry_failure']);
const save=()=>writeFileSync(join(evidence,'preflight.jsonl'),rows.map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600,flush:true});
// Async Docker calls let host SIGINT/SIGTERM reach the bounded finally cleanup.
function docker(args,timeout=10000) {
  return new Promise(resolve=>{
    const child=spawn('docker',args,{cwd:root,stdio:['ignore','pipe','ignore']});active=child;
    let stdout='',error;
    const timer=setTimeout(()=>{error={code:'ETIMEDOUT'};child.kill('SIGKILL');},timeout);
    child.stdout.on('data',data=>{
      if(stdout.length+data.length>1024*1024){error={code:'ENOBUFS'};child.kill('SIGKILL');}
      else stdout+=data.toString();
    });
    child.on('error',value=>{error=value;});
    child.on('close',(status,signal)=>{clearTimeout(timer);if(active===child)active=undefined;resolve({stdout,status,signal,error});});
  });
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(interrupted)return;interrupted=true;rows.push({check:'interruption',outcome:'fail',signal});
  active?.kill('SIGKILL');
});
async function required(args,timeout) {
  assert.equal(interrupted,false);
  rows.push({check:'docker_operation',stage,outcome:'start'});save();
  const result=await docker(args,timeout);
  const safe=childDiagnostic(result);
  // Preserve only projected process metadata, never Docker output or arguments.
  rows.push({check:'docker_operation',stage,outcome:safe.outcome,
    exitCode:safe.exitCode,signal:safe.signal,timeout:safe.timeout,category:safe.category});save();
  assert.ok(!result.error);assert.equal(result.status,0);
  assert.equal(interrupted,false);return result.stdout.trim();
}
try {
  await required(['info','--format','{{.ServerVersion}}']);
  assert.ok(!(await required(['container','ls','-a','--format','{{.Names}}'])).split('\n').includes(container));
  assert.equal(await required(['image','ls','-q',image]),'');
  stage='base_image_resolution';
  const baseId=await required(['image','inspect','--format','{{.Id}}',historical]);assert.match(baseId,/^sha256:[a-f0-9]{64}$/);
  // Persist validated identity before any context preparation or build can fail.
  writeFileSync(join(evidence,'image.json'),JSON.stringify({historical,expectedBaseId,baseId,image})+'\n',{mode:0o600,flush:true});
  assert.equal(baseId,expectedBaseId);
  stage='build_context_preparation';
  // Send only these harness files as context, never the application workspace.
  const context=join(evidence,'build-context');mkdirSync(context,{mode:0o700});
  for(const name of ['Dockerfile.launcher-preflight','launch.mjs','ingestion-bootstrap.mjs','diagnostics.mjs','launcher-preflight-entry.mjs']) {
    copyFileSync(fileURLToPath(new URL(name,import.meta.url)),join(context,name));
  }
  stage='image_build';
  await required(['build','--network','none','--pull=false','--build-arg',`HISTORICAL_IMAGE=${historical}`,
    '-f',join(context,'Dockerfile.launcher-preflight'),'-t',image,context],120000);
  stage='post_build_inspection';
  const postBuildBaseId=await required(['image','inspect','--format','{{.Id}}',historical]);
  assert.match(postBuildBaseId,/^sha256:[a-f0-9]{64}$/);
  writeFileSync(join(evidence,'image.json'),JSON.stringify({historical,expectedBaseId,baseId,postBuildBaseId,image})+'\n',{mode:0o600,flush:true});
  assert.equal(postBuildBaseId,baseId);
  const imageId=await required(['image','inspect','--format','{{.Id}}',image]);assert.match(imageId,/^sha256:[a-f0-9]{64}$/);
  writeFileSync(join(evidence,'image.json'),JSON.stringify({historical,expectedBaseId,baseId,postBuildBaseId,image,imageId})+'\n',{mode:0o600,flush:true});
  stage='creation';attempted=true;
  // The launcher chowns proxy.sock to UID 1000 before chmod as root. FOWNER
  // permits that owner-only operation; CHOWN/DAC_OVERRIDE do not cover chmod.
  await required(['create','--name',container,'--label',`${label}=${ownership}`,'--network','none','--read-only',
    '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','KILL','--cap-add','DAC_OVERRIDE',
    '--cap-add','FOWNER',
    '--security-opt','no-new-privileges:true','--user','0:0','--workdir','/app',
    '--tmpfs','/app/data:rw,noexec,nosuid,size=32m,uid=0,gid=0,mode=0755',
    '--tmpfs','/run/secrets:rw,noexec,nosuid,size=1m,uid=0,gid=0,mode=0700',
    '--env','HOST=0.0.0.0','--env','PORT=3000','--env','DEVCAUGHT_HOST=0.0.0.0',
    '--env','DEVCAUGHT_SMTP_PORT=1025','--env','DEVCAUGHT_HTTP_PORT=8025',
    '--env','DEVCAUGHT_INTEGRATION_INGESTION_OWNER=web','--env','DEVCAUGHT_LAUNCHER_PREFLIGHT=1',
    '--env','DEVCAUGHT_SMTP_ROUTING_MODE=private','--env','DEVCAUGHT_REQUIRE_PERSISTENT_DB=1',
    '--env','DEVCAUGHT_DB_PATH=/app/data/launcher-preflight.db','--env','DEVCAUGHT_RETENTION_DAYS=0',
    '--env','DEVCAUGHT_MAX_MESSAGES=0','--env','BETTER_AUTH_URL=http://localhost:3000',imageId]);
  stage='readiness';const result=await docker(['start','--attach',container],45000);
  for(const line of result.stdout.split('\n')) {
    try {const row=JSON.parse(line);if(!checks.has(row.check))continue;const safe=diagnostic(row);
      rows.push({check:row.check,...safe});}catch{}
  }
  rows.push({check:'attach_exit',...childDiagnostic(result)});save();
  assert.equal(interrupted,false);
  const state=JSON.parse(await required(['inspect','--format',
    '{"running":{{.State.Running}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}}}',container]));
  assert.equal(typeof state.running,'boolean');assert.equal(typeof state.oomKilled,'boolean');
  assert.ok(Number.isInteger(state.exitCode)&&state.exitCode>=0&&state.exitCode<=255);
  rows.push({check:'process_exit',outcome:!state.running&&state.exitCode===0&&!state.oomKilled?'pass':'fail',...state});save();
  assert.equal(childDiagnostic(result).outcome,'pass');assert.equal(state.running,false);assert.equal(state.exitCode,0);assert.equal(state.oomKilled,false);
  for(const check of ['launcher_ready','web_3000','smtp_1025','ingestion_http_8025','launcher_permissions','control_socket','supervision_cleanup','launcher_cleanup']) {
    assert.ok(rows.some(row=>row.check===check&&row.outcome==='pass'));
  }
  assert.ok(!rows.some(row=>row.category==='postgres_dependency'||row.check==='postgres_dependency'));
}catch(error){rows.push({check:'runner',outcome:'fail',stage,category:category(error)});process.exitCode=1;}
finally {
  // A timed-out/interrupted create may have succeeded server-side. Verify our
  // unique label before stopping; never touch a pre-existing or racing container.
  if(attempted) {
    const owned=await docker(['inspect','--format',`{{index .Config.Labels "${label}"}}`,container]);
    if(owned.status===0&&owned.stdout.trim()===ownership) {
      const result=await docker(['stop','--time','5',container],15000);
      const ok=result.status===0&&!result.error;rows.push({check:'cleanup_stop',outcome:ok?'pass':'fail'});
      if(!ok){process.exitCode=1;console.error(`BLOCKED: stop only ${container} manually`);}
    }else {rows.push({check:'cleanup_ownership',outcome:'fail'});process.exitCode=1;}
  }
  if(interrupted)process.exitCode=1;
  save();for(const row of rows)console.log(JSON.stringify(row));
  console.log(`Sanitized evidence: ${evidence}; new image and stopped container retained`);
}
