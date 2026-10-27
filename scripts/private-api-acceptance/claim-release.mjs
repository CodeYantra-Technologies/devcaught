import assert from 'node:assert/strict';
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,readdirSync,realpathSync,writeFileSync,unlinkSync} from 'node:fs';
import {join,dirname,isAbsolute,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {acquireCoordinationLock} from './coordination.mjs';
import {evidenceRoot,ensurePrivateDirectory,recoveryMetadata,atomicJson,syncDirectory} from './evidence.mjs';
import {resources,validateManifest} from './profile.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function parseArguments(args) {
  const options={};
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(!['--run','--evidence-dir','--dry-run','--confirm-release'].includes(key)||Object.hasOwn(options,key))throw new Error('Invalid release arguments');
    if(key==='--dry-run')options[key]=true;
    else {if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing argument');options[key]=args[++i];}
  }
  const run=options['--run'],dir=options['--evidence-dir'];
  if(!uuid.test(run??'')||!dir||!isAbsolute(dir))throw new Error('Explicit run UUID and absolute evidence directory required');
  if(options['--dry-run']?(options['--confirm-release']!==undefined):(options['--confirm-release']!==run))throw new Error('Use --dry-run or --confirm-release with the same UUID');
  return {run,dir,dryRun:options['--dry-run']===true};
}
function readPrivate(path) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const info=fstatSync(fd);
    if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink!==1||info.size>8*1024*1024)throw new Error('Unsafe evidence file');
    const text=readFileSync(fd,'utf8');
    return {text,info};
  }finally{closeSync(fd);}
}
export function validateEligibility({run,dir,claim,meta,manifest,cleanup,diagnostics}) {
  assert.match(run,uuid);
  validateManifest(manifest);
  assert.deepEqual(claim,{evidenceDir:dir,run});
  assert.equal(manifest.run,run);
  const expected=recoveryMetadata(dir,manifest);
  for(const field of ['schemaVersion','profile','run','evidenceDir','resources','fixtures','recovery'])assert.deepEqual(meta[field],expected[field]);
  assert.equal(meta.completed,true);assert.equal(meta.phase,'complete');assert.equal(meta.acceptance,'FAIL');
  assert.equal(meta.cleanup,'unknown');
  assert.equal(cleanup.state,'not_provisioned');assert.equal(cleanup.manifest,'manifest.json');
  assert.equal(cleanup.cancellationDestination,manifest.cancelled);
  assert.deepEqual(cleanup.resources,resources);
  assert.equal(cleanup.recoveryCommand,expected.recovery.command);
  assert.ok(Array.isArray(diagnostics)&&diagnostics.length>0);
  assert.ok(diagnostics.some(row=>row.executionStage==='resource and target preflight'&&row.outcome==='pass'));
  assert.ok(diagnostics.some(row=>row.executionStage==='normal image and standalone ingestion build'&&row.outcome==='fail'&&row.category==='child_exit'&&Number.isInteger(row.exitCode)&&row.exitCode>0));
  for(const row of diagnostics) {
    assert.equal(row.kind,'smtp_integration_diagnostic');assert.equal(row.component,'runner');
    assert.equal(row.signal,null);assert.equal(row.timeout,'none');
    assert.ok(['resource and target preflight','normal image and standalone ingestion build'].includes(row.executionStage));
    if(row.outcome==='fail') {
      assert.equal(row.executionStage,'normal image and standalone ingestion build');
      assert.ok(['child_exit','unknown'].includes(row.category));
    }else {assert.equal(row.outcome,'pass');assert.equal(row.exitCode,0);assert.equal(row.category,'none');}
  }
}
export function assertNoAcceptanceProcesses() {
  if(process.platform!=='linux')throw new Error('Reliable Linux process inspection required');
  const mounts=readFileSync('/proc/mounts','utf8').split('\n').filter(line=>line.split(' ')[1]==='/proc');
  if(mounts.length!==1||mounts[0].includes('hidepid='))throw new Error('Unrestricted process visibility required');
  const nesting=readFileSync('/proc/self/status','utf8').match(/^NSpid:\s*(.*)$/m);
  if(!nesting||nesting[1].trim().split(/\s+/).length!==1)throw new Error('Host WSL process namespace required');
  const relevant=['node','nodejs','bun','deno','tsx','docker','flock'];
  for(const entry of readdirSync('/proc')) {
    if(!/^\d+$/.test(entry)||Number(entry)===process.pid)continue;
    try {
      const comm=readFileSync(`/proc/${entry}/comm`,'utf8').trim();
      if(!relevant.includes(comm))continue;
      const args=readFileSync(`/proc/${entry}/cmdline`,'utf8').split('\0').filter(Boolean);
      if(args.length===0&&!/^State:\s+Z/m.test(readFileSync(`/proc/${entry}/status`,'utf8')))throw new Error('Uninspectable process');
      if(args.some(arg=>basename(arg)==='run-controlled.mjs')&&args.includes('--private-api')||
        args.some(arg=>arg.includes('private-api-acceptance/')&&basename(arg)==='verify.mjs')||
        comm==='docker'&&args.some(arg=>arg.includes('private-api')||arg.includes('private_api')))throw new Error('Active private API operation');
    }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')continue;throw new Error('Active operation detected or process inspection unavailable');}
  }
}
function docker(args) {
  const result=spawnSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw new Error('Docker inventory unavailable');
  return result.stdout.trim();
}
export function assertNoDockerResources() {
  // Process inspection is only meaningful alongside a local Docker endpoint.
  if(process.env.DOCKER_HOST&&!process.env.DOCKER_HOST.startsWith('unix://'))throw new Error('Local Docker endpoint required');
  const endpoint=JSON.parse(docker(['context','inspect','--format','{{json .Endpoints.docker.Host}}']));
  if(typeof endpoint!=='string'||!endpoint.startsWith('unix://'))throw new Error('Local Docker context required');
  const queries=[];
  for(const name of [resources.container,resources.readiness,resources.verifier])queries.push(['container','ls','-a','-q','--filter',`name=^/${name}$`]);
  for(const [kind,name] of [['volume',resources.volume],['network',resources.network]])queries.push([kind,'ls','-q','--filter',`name=${name}`]);
  for(const kind of ['container','volume','network'])queries.push([kind,'ls',...(kind==='container'?['-a']:[]),'-q','--filter',`label=com.docker.compose.project=${resources.project}`]);
  queries.push(['image','ls','-q','--no-trunc',resources.image]);
  for(const query of queries)if(docker(query)!=='')throw new Error('Dedicated Docker resource exists');
}
export function inspectRelease(options) {
  const root=evidenceRoot();
  // Validation only: never create missing evidence paths.
  for(const path of [root,options.dir]) {
    const info=lstatSync(path);
    if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(path)!==path||info.uid!==process.getuid()||(info.mode&0o077))throw new Error('Unsafe evidence directory');
  }
  ensurePrivateDirectory(root);
  if(dirname(options.dir)!==root||!/^run-[A-Za-z0-9]+$/.test(basename(options.dir)))throw new Error('Evidence must be a direct run directory in the configured root');
  const snapshots=new Map();
  const read=path=>{const value=readPrivate(path);snapshots.set(path,value);return value.text;};
  const claimPath=join(root,'attempt.claim');
  const claim=JSON.parse(read(claimPath));
  const meta=JSON.parse(read(join(options.dir,'run.json')));
  const manifest=JSON.parse(read(join(options.dir,'manifest.json')));
  const cleanup=JSON.parse(read(join(options.dir,'cleanup-state.json')));
  const diagnostics=read(join(options.dir,'diagnostics.jsonl')).trim().split('\n').map(line=>JSON.parse(line));
  for(const name of ['readiness.jsonl','verification.jsonl','recovery.jsonl','application-source.jsonl','image.json']) {
    try {lstatSync(join(options.dir,name));throw new Error('Evidence extends beyond supported pre-build failure');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  validateEligibility({...options,claim,meta,manifest,cleanup,diagnostics});
  return {root,claimPath,snapshots};
}
function unchanged(snapshots) {
  for(const [path,old] of snapshots) {
    const now=readPrivate(path);
    if(now.info.ino!==old.info.ino||now.info.dev!==old.info.dev||now.text!==old.text)throw new Error('Evidence changed during release checks');
  }
}
export function performRelease(options) {
  if(!options||!uuid.test(options.run??'')||!isAbsolute(options.dir??'')||typeof options.dryRun!=='boolean')throw new Error('Invalid release options');
  acquireCoordinationLock();
  const inspection=inspectRelease(options);
  assertNoAcceptanceProcesses();assertNoDockerResources();
  unchanged(inspection.snapshots);
  if(options.dryRun)return {result:'ELIGIBLE',dryRun:true,claimReleased:false};
  const directory=join(inspection.root,'claim-releases');ensurePrivateDirectory(directory);
  const name=`claim-${options.run}-${randomUUID()}`;
  const archive=join(directory,name+'.claim.json'),recordPath=join(directory,name+'.release.json');
  const original=inspection.snapshots.get(inspection.claimPath).text;
  // Exclusive archive and durable intent precede unlink. A crash can leave a
  // prepared record; it never silently erases the original claim bytes.
  writeFileSync(archive,original,{flag:'wx',mode:0o600,flush:true});syncDirectory(directory);
  const record={schemaVersion:1,run:options.run,evidenceDir:options.dir,archive:basename(archive),state:'prepared',reason:'completed_pre_provisioning_build_failure',recordedAt:new Date().toISOString()};
  writeFileSync(recordPath,JSON.stringify(record)+'\n',{flag:'wx',mode:0o600,flush:true});syncDirectory(directory);
  assertNoAcceptanceProcesses();assertNoDockerResources();unchanged(inspection.snapshots);
  unlinkSync(inspection.claimPath);syncDirectory(inspection.root);
  atomicJson(recordPath,{...record,state:'released',releasedAt:new Date().toISOString()});
  return {result:'RELEASED',claimReleased:true,archive,releaseRecord:recordPath};
}
