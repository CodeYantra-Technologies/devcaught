// Bounded, offline validation only: never call release, process or Docker checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseArguments,validateEligibility} from './claim-release.mjs';
import {makeManifest,resources} from './profile.mjs';
import {recoveryMetadata} from './evidence.mjs';
const run='00000000-0000-4000-8000-000000000000',dir='/home/example/evidence/run-ABC123';
function eligible() {
  const manifest=makeManifest(run),expected=recoveryMetadata(dir,manifest);
  return {run,dir,manifest,claim:{run,evidenceDir:dir},meta:{...expected,phase:'complete',completed:true,acceptance:'FAIL'},
    cleanup:{state:'not_provisioned',manifest:'manifest.json',cancellationDestination:manifest.cancelled,resources,recoveryCommand:expected.recovery.command},
    diagnostics:[{kind:'smtp_integration_diagnostic',component:'runner',executionStage:'resource and target preflight',outcome:'pass',exitCode:0,category:'none',signal:null,timeout:'none'},
      {kind:'smtp_integration_diagnostic',component:'runner',executionStage:'normal image and standalone ingestion build',outcome:'fail',exitCode:1,category:'child_exit',signal:null,timeout:'none'}]};
}
test('completed pre-provisioning build failure qualifies without I/O',()=>{validateEligibility(eligible());});
for(const [name,mutate] of [
  ['wrong claim owner',v=>v.claim.run='different'],
  ['wrong evidence directory',v=>v.claim.evidenceDir='/different'],
  ['missing manifest',v=>v.manifest=undefined],
  ['wrong manifest identity',v=>v.manifest.run='different'],
  ['incomplete run',v=>v.meta.completed=false],
  ['nonterminal phase',v=>v.meta.phase='container startup'],
  ['successful acceptance',v=>v.meta.acceptance='PASS'],
  ['recovery-required metadata',v=>v.meta.cleanup='recovery_required'],
  ['recovery-required state',v=>v.cleanup.state='revocation_required'],
  ['mismatched resources',v=>v.meta.resources={}],
  ['mismatched recovery command',v=>v.cleanup.recoveryCommand='different'],
  ['missing diagnostics',v=>v.diagnostics=[]],
  ['interrupted run',v=>v.diagnostics[1].signal='SIGTERM'],
  ['timed-out child',v=>v.diagnostics[1].timeout='operation_timeout'],
  ['fixture stage reached',v=>v.diagnostics[1].executionStage='synthetic fixture provisioning'],
  ['unrecorded build failure',v=>v.diagnostics[1].exitCode=null],
])test('refuses '+name,()=>{const value=structuredClone(eligible());mutate(value);assert.throws(()=>validateEligibility(value));});
test('CLI requires exact identity and a mutually exclusive action',()=>{
  const base=['--run',run,'--evidence-dir',dir];
  assert.equal(parseArguments([...base,'--dry-run']).dryRun,true);
  assert.equal(parseArguments([...base,'--confirm-release',run]).dryRun,false);
  for(const args of [[],base,[...base,'--confirm-release','wrong'],[...base,'--dry-run','--confirm-release',run],[...base,'--dry-run','--dry-run'],['--run',run,'--evidence-dir','../run','--dry-run']])assert.throws(()=>parseArguments(args));
});
test('static safety ordering and syscall constraints',()=>{
  const source=readFileSync(new URL('./claim-release.mjs',import.meta.url),'utf8');
  const action=source.slice(source.indexOf('export function performRelease'));
  assert.ok(action.indexOf('acquireCoordinationLock()')<action.indexOf('inspectRelease(options)'));
  assert.ok(action.indexOf('if(options.dryRun)return')<action.indexOf('writeFileSync(archive'));
  assert.ok(action.indexOf("state:'prepared'")<action.indexOf('unlinkSync(inspection.claimPath)'));
  assert.ok(action.indexOf('syncDirectory(directory);\n  assertNoAcceptanceProcesses()')<action.indexOf('unlinkSync(inspection.claimPath)'));
  assert.ok(action.indexOf('syncDirectory(inspection.root)')<action.indexOf("state:'released'"));
  assert.equal((action.match(/assertNoDockerResources\(\)/g)||[]).length,2);
  assert.ok(source.includes('constants.O_RDONLY|constants.O_NOFOLLOW'));
  assert.ok(source.includes("flag:'wx',mode:0o600,flush:true"));
  assert.ok(source.includes("if(error.code!=='ENOENT')throw error"));
  assert.ok(source.includes("throw new Error('Docker inventory unavailable')"));
  assert.ok(source.includes("throw new Error('Unrestricted process visibility required')"));
  assert.doesNotMatch(source,/\['(?:stop|rm|down|build|exec|run|prune)'/);
  const runner=readFileSync(new URL('../smtp-integration/run-controlled.mjs',import.meta.url),'utf8');
  assert.ok(runner.includes("if(privateApi)(await import('../private-api-acceptance/coordination.mjs')).acquireCoordinationLock()"));
  assert.ok(runner.indexOf('acquireCoordinationLock()')<runner.indexOf('const evidenceDir='));
  const lock=readFileSync(new URL('./coordination.mjs',import.meta.url),'utf8');
  assert.ok(lock.includes("'.local/state/devcaught'"));
  assert.ok(lock.includes("['--exclusive','--nonblock','3']"));
  assert.ok(lock.includes("process.once('exit',()=>closeSync(fd))"));
  assert.doesNotMatch(lock,/unlinkSync|renameSync/);
});
