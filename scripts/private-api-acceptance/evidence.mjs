import {mkdirSync,realpathSync,lstatSync,openSync,closeSync,fsyncSync,writeFileSync,renameSync,readFileSync,mkdtempSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {resources,makeManifest,validateManifest,requiredChecks,readinessCheck} from './profile.mjs';
const project=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const inside=(base,path)=>{const rel=relative(base,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
export const evidenceRoot=()=>resolve(process.env.DEVCAUGHT_PRIVATE_API_EVIDENCE_DIR||join(homedir(),'.local/state/devcaught/private-api-acceptance'));
function allowed(path) {
  if(inside(project,path)||inside('/tmp',path)||inside('/var/tmp',path))throw new Error('Evidence must be outside the project and temporary directories');
}
export function syncDirectory(path) {const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function ensurePrivateDirectory(path) {
  allowed(path);
  if(!lstatExists(path)) {privateDirectoryParent(dirname(path));mkdirSync(path,{mode:0o700});syncDirectory(dirname(path));}
  const info=lstatSync(path);
  if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(path)!==path||info.uid!==process.getuid()||(info.mode&0o077))throw new Error('Evidence directory must be owned by this user, private (0700), and not symlinked');
}
function lstatExists(path) {try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function privateDirectoryParent(path) {
  if(lstatExists(path)){allowed(realpathSync(path));return;}
  privateDirectoryParent(dirname(path));mkdirSync(path,{mode:0o700});syncDirectory(dirname(path));
}
export function atomicJson(path,value) {
  const next=path+'.'+randomUUID()+'.next';
  writeFileSync(next,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600,flush:true});
  renameSync(next,path);syncDirectory(dirname(path));
}
export function createEvidence() {
  const root=evidenceRoot();ensurePrivateDirectory(root);
  const dir=mkdtempSync(join(root,'run-'));syncDirectory(root);return dir;
}
export function validateRecoveryDirectory(dir) {
  // Retain compatibility with historical recovery directories; never create them.
  if(/^\/tmp\/devcaught-private-api-2j2-[A-Za-z0-9]+$/.test(dir))return;
  allowed(dir);ensurePrivateDirectory(dir);
  if(dirname(dir)!==realpathSync(evidenceRoot())||!/^run-[A-Za-z0-9]+$/.test(dir.split('/').at(-1)))throw new Error('Unexpected recovery directory');
}
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function recoveryMetadata(dir,manifest) {
  validateManifest(manifest);
  return {schemaVersion:1,profile:'private-api',run:manifest.run,evidenceDir:dir,resources,
    fixtures:{emails:[manifest.a.email,manifest.b.email],invitationIds:[manifest.a.invitation,manifest.b.invitation],
      cancellationId:manifest.cancelled,cancellationEmail:manifest.cancelEmail,legacyId:manifest.legacyId},
    phase:'initialized',cleanup:'unknown',acceptance:'UNKNOWN',completed:false,
    recovery:{manifest:'manifest.json',command:`cd ${quote(project)} && DEVCAUGHT_PRIVATE_API_EVIDENCE_DIR=${quote(dirname(dir))} node scripts/smtp-integration/run-controlled.mjs --private-api --revoke-only ${quote(dir)}`}};
}
export function initializeEvidence(dir,manifest) {
  const metadata=recoveryMetadata(dir,manifest);atomicJson(join(dir,'run.json'),metadata);
  atomicJson(join(evidenceRoot(),'latest.json'),{schemaVersion:1,run:manifest.run,evidenceDir:dir});return metadata;
}
export function persistMetadata(dir,metadata) {atomicJson(join(dir,'run.json'),metadata);}
function readEvidence(path) {
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw new Error('Invalid evidence file');
  return readFileSync(path,'utf8');
}
function records(dir,name) {return readEvidence(join(dir,name)).trim().split('\n').map(line=>JSON.parse(line));}
export function inspectStatus(root=evidenceRoot()) {
  const unknown={latestRun:null,result:'UNKNOWN',cleanup:'unknown',evidenceLocation:null,recoveryMetadataAvailable:false};
  try {
    const latest=JSON.parse(readEvidence(join(root,'latest.json')));
    unknown.latestRun=latest.run;unknown.evidenceLocation=latest.evidenceDir;
    allowed(resolve(root));
    const dir=latest.evidenceDir;
    if(dirname(dir)!==realpathSync(root)||realpathSync(dir)!==dir) return unknown;
    const manifest=JSON.parse(readEvidence(join(dir,'manifest.json')));validateManifest(manifest);
    const meta=JSON.parse(readEvidence(join(dir,'run.json')));
    if(meta.schemaVersion!==1||meta.run!==latest.run||manifest.run!==meta.run||meta.evidenceDir!==dir||JSON.stringify(meta.resources)!==JSON.stringify(resources)||JSON.stringify(meta.fixtures)!==JSON.stringify(recoveryMetadata(dir,manifest).fixtures))return unknown;
    if(JSON.stringify(meta.recovery)!==JSON.stringify(recoveryMetadata(dir,manifest).recovery))return unknown;
    unknown.recoveryMetadataAvailable=true;
    const state=JSON.parse(readEvidence(join(dir,'cleanup-state.json')));
    if(JSON.stringify(state.resources)!==JSON.stringify(resources)||state.cancellationDestination!==manifest.cancelled)return unknown;
    unknown.cleanup=state.state==='cleanup_verified'&&meta.cleanup==='verified'?'verified':state.state==='revocation_required'?'recovery_required':'unknown';
    const diagnostics=records(dir,'diagnostics.jsonl');
    const readiness=records(dir,'readiness.jsonl'),verification=records(dir,'verification.jsonl');
    if(unknown.cleanup==='recovery_required')return {...unknown,result:'BLOCKED'};
    if(diagnostics.some(row=>row.outcome==='fail')||meta.acceptance==='FAIL')return {...unknown,result:'FAIL'};
    const passed=(rows,checks)=>checks.every(check=>rows.some(row=>row.result==='PASS'&&row.check===check))&&rows.some(row=>row.verifierSubstage==='complete:start'&&row.outcome==='pass')&&!rows.some(row=>row.outcome==='fail');
    if(meta.completed&&meta.acceptance==='PASS'&&unknown.cleanup==='verified'&&passed(readiness,[readinessCheck])&&passed(verification,requiredChecks))return {...unknown,result:'PASS'};
    return unknown;
  }catch{return unknown;}
}
