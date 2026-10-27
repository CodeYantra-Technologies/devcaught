import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {diagnostic,childDiagnostic,parseDiagnostics,parseVerifierEvidence,category} from './diagnostics.mjs';

test('allowlist excludes all arbitrary fields and strings',()=>{
  const secret='DO_NOT_EMIT_SYNTHETIC_SECRET';
  const row=diagnostic({component:secret,executionStage:secret,verifierSubstage:secret,signal:secret,exitCode:secret,category:secret,stderr:secret,message:secret,stack:secret,applicationPhase:secret,processName:secret,shutdownReason:secret});
  assert.ok(!JSON.stringify(row).includes(secret));
  assert.equal(category({code:secret,message:secret}),'unknown');
  assert.deepEqual(parseDiagnostics(`arbitrary stderr ${secret}\n{"kind":"other","password":"${secret}"}\n`),[]);
});
test('exit codes, signals, timeout and spawn errors are distinct',()=>{
  const context={component:'verifier',executionStage:'verifier execution',verifierSubstage:'owner_a:rcpt'};
  assert.equal(childDiagnostic({status:1},context).exitCode,1);
  assert.equal(childDiagnostic({status:null,signal:'SIGKILL'},context).category,'child_signal');
  const timeout=childDiagnostic({status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT',message:'secret'}},context);
  assert.equal(timeout.timeout,'verifier_timeout');assert.equal(timeout.signal,'SIGTERM');assert.equal(timeout.verifierSubstage,'owner_a:rcpt');
  assert.equal(childDiagnostic({status:null,error:{code:'ENOENT'}},context).category,'spawn_failure');
  assert.equal(childDiagnostic({status:null,error:{code:'ENOBUFS'}},context).category,'output_limit');
});
test('failure before PASS writes synchronous bootstrap and failure records without stderr',()=>{
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {emit,category} from './scripts/smtp-integration/diagnostics.mjs';
    emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:'manifest:start',outcome:'start',category:'none'});
    try {JSON.parse('invalid synthetic input');}catch(error){emit({component:'verifier',executionStage:'verifier execution',verifierSubstage:'manifest:start',outcome:'fail',exitCode:1,category:category(error)});process.exitCode=1;}
  `],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stderr,'');
  const rows=parseDiagnostics(result.stdout);assert.equal(rows.length,2);
  assert.equal(rows[1].category,'invalid_json');assert.equal(rows[1].verifierSubstage,'manifest:start');
});
test('application crashes remain distinct from cleanup requested exits',()=>{
  const crash=diagnostic({component:'application',executionStage:'application observation',processName:'ingestion',shutdownReason:'unexpected_exit',exitCode:1,outcome:'fail'});
  const cleanup=diagnostic({component:'application',executionStage:'cleanup stop',processName:'web',shutdownReason:'cleanup_requested',signal:'SIGTERM',cleanupRequested:true,outcome:'observation'});
  assert.notEqual(crash.shutdownReason,cleanup.shutdownReason);assert.equal(cleanup.cleanupRequested,true);
});
test('existing PASS evidence retains only known checks and integer counts',()=>{
  const result=parseVerifierEvidence(JSON.stringify({result:'PASS',check:'final scoped persistence and zero unassigned rows',ownerA:5,ownerB:1,unassigned:0,password:'SYNTHETIC_SECRET',body:'SYNTHETIC_BODY'}));
  assert.deepEqual(result,[{result:'PASS',check:'final scoped persistence and zero unassigned rows',ownerA:5,ownerB:1,unassigned:0}]);
  assert.deepEqual(parseVerifierEvidence('{"result":"PASS","check":"UNTRUSTED_SECRET"}'),[]);
});
test('harness sources never forward arbitrary stderr and preserve pre-cleanup observation',()=>{
  const runner=readFileSync(new URL('./run.mjs',import.meta.url),'utf8');
  const verifier=readFileSync(new URL('./verify.mjs',import.meta.url),'utf8');
  const launcher=readFileSync(new URL('./launch.mjs',import.meta.url),'utf8');
  assert.match(runner,/stdio:\['pipe','pipe','ignore'\]/);
  assert.ok(!runner.includes('result.stderr'));
  assert.ok(runner.indexOf("const state=JSON.parse")<runner.indexOf("stage='cleanup stop'"));
  assert.ok(verifier.indexOf("mark('manifest')")<verifier.indexOf("JSON.parse(readFileSync('/manifest.json'"));
  assert.match(launcher,/stdio:\['inherit','inherit','ignore'\]/);
});
