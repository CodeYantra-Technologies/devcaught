import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,appendFileSync,mkdirSync,copyFileSync,cpSync,realpathSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {diagnostic,childDiagnostic,parseDiagnostics,parseVerifierEvidence,category} from './diagnostics.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const sms=process.argv[2]==='--sms',privateApi=process.argv[2]==='--private-api';
const durable=privateApi?await import('../private-api-acceptance/evidence.mjs'):null;
const profileFlag=sms?'--sms':privateApi?'--private-api':'';
const args=process.argv.slice(profileFlag?3:2);
const recovery=args.length===2&&args[0]==='--revoke-only';
assert.ok(args.length===0||recovery,'Unsupported arguments');
const profile=sms?await import('./sms-profile.mjs'):privateApi?await import('../private-api-acceptance/profile.mjs'):null;
const resources=profile?.resources??{project:'devcaught-smtp-integration-2h27',image:'devcaught:smtp-routing-integration-2h27',
  container:'devcaught-smtp-routing-2h27',verifier:'devcaught-smtp-routing-verifier-2h27',
  readiness:'devcaught-smtp-routing-readiness-2h27',volume:'devcaught_smtp_routing_2h27_data',network:'devcaught_smtp_routing_2h27_net'};
const historical='devcaught:smtp-routing-integration-retry-1';
const expectedBaseId='sha256:720d70dce51ab1613b55610a0f448aa2f66a7b3ed33440b6fa2658c536caaf0b';
// Hold the global private-API lock before any evidence or claim mutation.
if(privateApi)(await import('../private-api-acceptance/coordination.mjs')).acquireCoordinationLock();
const evidenceDir=recovery?realpathSync(args[1]):privateApi?durable.createEvidence():mkdtempSync(join(tmpdir(),profile?.prefix??'devcaught-smtp-integration-2h27-'));
if(recovery&&privateApi)durable.validateRecoveryDirectory(evidenceDir);
if(recovery&&!privateApi)assert.match(evidenceDir,profile?new RegExp('^/tmp/'+profile.prefix+'[A-Za-z0-9]+$'):/^\/tmp\/devcaught-smtp-integration-2h27-[A-Za-z0-9]+$/);
const owner=(run,letter)=>({user:`smtp_it_${letter}_${run}`,inbox:`inbox_smtp_it_${letter}_${run}`,destination:`smtp-it-${run}-${letter}@integration.invalid`});
const makeManifest=profile?.makeManifest??(run=>({run,a:owner(run,'a'),b:owner(run,'b'),alias:`smtp-it-${run}-alias@integration.invalid`,revoked:`smtp-it-${run}-revoked@integration.invalid`}));
const manifest=recovery?JSON.parse(readFileSync(join(evidenceDir,'manifest.json'),'utf8')):makeManifest(randomUUID());
assert.match(manifest.run,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
assert.deepEqual(manifest,makeManifest(manifest.run));
profile?.validateManifest(manifest);
// A separate, never-deliverable tombstone is the durable per-run cancellation
// fence. Derive it from the validated manifest so recovery needs no new schema.
const cancellationDestination=profile?manifest.cancelled:`smtp-it-${manifest.run}-cancelled@integration.invalid`;
const env={...process.env,DEVCAUGHT_AUTH_SECRET_DIR:join(process.env.HOME,'.local/share/devcaught/auth-dev-secrets'),
  DEVCAUGHT_SMTP_MANIFEST:join(evidenceDir,'manifest.json'),DEVCAUGHT_SMTP_RUN:manifest.run,DEVCAUGHT_SMTP_VERIFIER_IMAGE:expectedBaseId,
  ...(sms?{DEVCAUGHT_SMS_ACCOUNT:manifest.accountSid,DEVCAUGHT_SMS_TEST_TOKEN:profile.syntheticToken}:{}),
  ...(privateApi?{DEVCAUGHT_PRIVATE_API_RUN:manifest.run}:{})};
if(!recovery)writeFileSync(env.DEVCAUGHT_SMTP_MANIFEST,JSON.stringify(manifest)+'\n',{mode:privateApi?0o600:0o644,flag:'wx',flush:true});
function syncEvidenceDirectory() {
  if(!privateApi)return;
  const fd=openSync(evidenceDir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
syncEvidenceDirectory();
let durableMetadata=privateApi?(recovery?durable.recoveryMetadata(evidenceDir,manifest):durable.initializeEvidence(evidenceDir,manifest)):null;
const compose=['compose','--env-file','/dev/null','-p',resources.project,
  ...(profile?['-f',profile.composeFile]:['-f','compose.smtp-integration.yaml','-f','compose.smtp-integration-2h27.yaml'])];
let stage='resource and target preflight',fixtures=recovery,started=recovery&&privateApi,interrupted=false,cleaning=false,active,protectActive=false;
function save(input){if(privateApi){durableMetadata.phase=stage;durable.persistMetadata(evidenceDir,durableMetadata);}appendFileSync(join(evidenceDir,recovery?'recovery.jsonl':'diagnostics.jsonl'),JSON.stringify(diagnostic({executionStage:stage,...input}))+'\n',{mode:0o600,flush:true});}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(interrupted)return;interrupted=true;save({outcome:'fail',signal,category:'child_signal'});
  // Let cleanup complete even if another signal arrives.
  if(!cleaning&&!protectActive)active?.kill('SIGKILL');
});
async function docker(args,{input,timeout=30000,evidence,optional=false,critical=false}={}) {
  if(privateApi){durableMetadata.phase=stage;durable.persistMetadata(evidenceDir,durableMetadata);}
  if(!cleaning&&interrupted)throw new Error('interrupted');
  const result=await new Promise(resolve=>{
    const child=spawn('docker',args,{cwd:root,env,stdio:['pipe','pipe','ignore']});active=child;protectActive=critical;
    let stdout='',error;
    const timer=setTimeout(()=>{error={code:'ETIMEDOUT'};child.kill('SIGKILL');},timeout);
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.stdout.on('data',data=>{if(stdout.length+data.length>4*1024*1024){error={code:'ENOBUFS'};child.kill('SIGKILL');}else stdout+=data.toString();});
    child.on('error',value=>{error=value;});
    child.on('close',(status,signal)=>{clearTimeout(timer);if(active===child){active=undefined;protectActive=false;}resolve({stdout,status,signal,error});});
  });
  const summary=childDiagnostic(result,{component:evidence?'verifier':'runner',executionStage:stage});
  if(evidence) {
    const records=parseVerifierEvidence(result.stdout);
    writeFileSync(join(evidenceDir,evidence),[...records,summary].map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600,flush:true});
    for(const row of records)if(row.kind==='smtp_integration_diagnostic')save(row);
    if(summary.outcome==='pass') {
      assert.ok(records.some(row=>row.kind==='smtp_integration_diagnostic'&&row.verifierSubstage==='complete:start'&&row.outcome==='pass'),'Missing verifier completion');
      if(profile)for(const check of evidence==='readiness.jsonl'?[profile.readinessCheck]:profile.requiredChecks) {
        assert.ok(records.some(row=>row.result==='PASS'&&row.check===check),'Missing profile verification check');
      }
    }
  }
  save(summary);
  if(!optional&&(summary.outcome!=='pass'||(!cleaning&&interrupted)))throw new Error('bounded operation failed');
  return result;
}
const output=async(args,options)=>(await docker(args,options)).stdout.trim();
const psql=text=>output(['exec','-i','devcaught-pg-dev','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-U','postgres','-d','devcaught_auth_dev'],
  {input:`SET statement_timeout='15s'; SET lock_timeout='3s';\n${text}\n`,timeout:90000,critical:true});
const json=async text=>JSON.parse((await psql(text)).split('\n').filter(Boolean).at(-1));
const scoped=profile?null:`((inbox_id='${manifest.a.inbox}' AND destination IN ('${manifest.a.destination}','${manifest.alias}')) OR (inbox_id='${manifest.b.inbox}' AND destination='${manifest.b.destination}'))`;
function cleanupState(state){
  const file=join(evidenceDir,'cleanup-state.json');
  const value={state,manifest:'manifest.json',cancellationDestination,resources,
    recoveryCommand:`cd ~/projects/devcaught && node scripts/smtp-integration/run-controlled.mjs ${profileFlag?profileFlag+' ':''}--revoke-only ${evidenceDir}`};
  if(privateApi){
    value.recoveryCommand=durableMetadata.recovery.command;
    durable.atomicJson(file,value);
    durableMetadata.phase=stage;
    durableMetadata.cleanup=state==='cleanup_verified'?'verified':state==='revocation_required'?'recovery_required':'unknown';
    durable.persistMetadata(evidenceDir,durableMetadata);
  }else writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600,flush:true});
}
async function targetPreflight() {
  const meta=format=>output(['inspect','--type','container','--format',format,'devcaught-pg-dev']);
  assert.equal(await meta('{{.Name}}'),'/devcaught-pg-dev');
  assert.equal(await meta('{{index .Config.Labels "com.docker.compose.project"}}'),'devcaught-auth-dev');
  assert.equal(await meta('{{index .Config.Labels "com.docker.compose.service"}}'),'postgres-dev');
  assert.equal(await meta('{{.State.Health.Status}}'),'healthy');
  assert.equal(await meta('{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'),'devcaught_pg_dev_data');
  assert.equal(await output(['network','inspect','--format','{{.Internal}}','devcaught_pg_dev_net']),'true');
  assert.deepEqual(await json("SELECT json_build_object('database',current_database(),'version',current_setting('server_version_num')::int/10000,'socket',inet_server_addr() IS NULL)"),
    {database:'devcaught_auth_dev',version:16,socket:true});
  assert.deepEqual(await json('SELECT json_agg(name ORDER BY name) FROM _migrations'),['0001_auth.sql','0002_invitations.sql','0003_private_inboxes.sql','0004_private_inbox_routing.sql']);
}
async function revoke() {
  if(profile) {
    await psql(profile.revokeSql(manifest));
    assert.deepEqual(await json(profile.revocationCheckSql(manifest)),profile.revocationExpected??{cancelled:true,active:0});
    return;
  }
  // Fence and revoke atomically. If provisioning has not started yet, its owner
  // and inbox may not exist: create only the synthetic A anchor needed by the FK.
  // READ COMMITTED is explicit so a command after waiting for the lock sees the
  // previous holder's commit, regardless of the database's default isolation.
  await psql(`BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE devcaught_auth_owner; SET LOCAL synchronous_commit=on;
    SELECT pg_advisory_xact_lock(74008);
    INSERT INTO "user"(id,name,email,"emailVerified") VALUES
      ('${manifest.a.user}','SYNTHETIC SMTP INTEGRATION OWNER A','${manifest.a.destination}',false)
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO private_inbox(id,owner_id) VALUES ('${manifest.a.inbox}','${manifest.a.user}') ON CONFLICT (id) DO NOTHING;
    DO $anchor$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM "user" WHERE id='${manifest.a.user}' AND email='${manifest.a.destination}')
        OR NOT EXISTS (SELECT 1 FROM private_inbox WHERE id='${manifest.a.inbox}' AND owner_id='${manifest.a.user}')
      THEN RAISE EXCEPTION 'Synthetic cancellation anchor mismatch'; END IF;
    END; $anchor$;
    INSERT INTO smtp_inbox_route(destination,inbox_id,state,revoked_at)
      VALUES ('${cancellationDestination}','${manifest.a.inbox}','revoked',now()) ON CONFLICT (destination) DO NOTHING;
    DO $cancel$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM smtp_inbox_route WHERE destination='${cancellationDestination}'
        AND inbox_id='${manifest.a.inbox}' AND state='revoked' AND revoked_at IS NOT NULL)
      THEN RAISE EXCEPTION 'Synthetic cancellation fence mismatch'; END IF;
    END; $cancel$;
    UPDATE smtp_inbox_route SET state='revoked',revoked_at=now() WHERE state='active' AND ${scoped}; COMMIT;`);
  assert.deepEqual(await json(`SELECT json_build_object('cancelled',EXISTS (
    SELECT 1 FROM smtp_inbox_route WHERE destination='${cancellationDestination}' AND inbox_id='${manifest.a.inbox}'
      AND state='revoked' AND revoked_at IS NOT NULL),
    'active',(SELECT count(*) FROM smtp_inbox_route WHERE state='active' AND ${scoped}))`),{cancelled:true,active:0});
}
async function stopOwned(name) {
  const names=await output(['container','ls','-a','--format','{{.Names}}']);
  if(!names.split('\n').includes(name))return;
  assert.equal(await output(['inspect','--format','{{index .Config.Labels "devcaught.smtp-run"}}',name]),manifest.run,'Container ownership mismatch');
  await output(['stop','--time','5',name],{timeout:15000});
}
try {
  await output(['info','--format','{{.ServerVersion}}']);
  if(!recovery) {
    for(const [kind,name] of [['container',resources.container],['container',resources.verifier],['container',resources.readiness],['volume',resources.volume],['network',resources.network]]) {
      const names=await output([kind,'ls',...(kind==='container'?['-a']:[]),'--format',kind==='container'?'{{.Names}}':'{{.Name}}']);
      assert.ok(!names.split('\n').includes(name),'Resource conflict');
    }
    for(const kind of ['container','volume','network'])assert.equal(await output([kind,'ls',...(kind==='container'?['-a']:[]),'-q','--filter',`label=com.docker.compose.project=${resources.project}`]),'');
    assert.equal(await output(['image','ls','-q',resources.image]),'');
    assert.equal(await output(['image','inspect','--format','{{.Id}}',historical]),expectedBaseId);
    await output([...compose,'config','--quiet']);
    await targetPreflight();
    assert.deepEqual(await json(profile?profile.preflightSql(manifest):`SELECT json_build_object('users',(SELECT count(*) FROM "user" WHERE id IN ('${manifest.a.user}','${manifest.b.user}') OR email IN ('${manifest.a.destination}','${manifest.b.destination}')),
      'inboxes',(SELECT count(*) FROM private_inbox WHERE id IN ('${manifest.a.inbox}','${manifest.b.inbox}')),
      'routes',(SELECT count(*) FROM smtp_inbox_route WHERE destination IN ('${manifest.a.destination}','${manifest.b.destination}','${manifest.alias}','${manifest.revoked}','${cancellationDestination}')))`),profile?.preflightExpected??{users:0,inboxes:0,routes:0});
    // Exclusive durable one-attempt reservation, never removed automatically.
    writeFileSync(privateApi?join(durable.evidenceRoot(),'attempt.claim'):profile?.claim??'/tmp/devcaught-smtp-integration-2h27.claim',JSON.stringify({evidenceDir,run:manifest.run})+'\n',{flag:'wx',mode:0o600,flush:true});
    if(privateApi)durable.syncDirectory(durable.evidenceRoot());
    cleanupState('not_provisioned');
    stage='normal image and standalone ingestion build';
    const context=join(evidenceDir,'build-context');mkdirSync(context,{mode:0o700});
    const sources=profile?profile.buildSources:[['scripts/smtp-integration/Dockerfile.controlled','Dockerfile'],
      ['scripts/smtp-integration/launch.mjs','launch.mjs'],['scripts/smtp-integration/ingestion-bootstrap.mjs','ingestion-bootstrap.mjs'],
      ['scripts/smtp-integration/diagnostics.mjs','diagnostics.mjs']];
    for(const [source,target,directory] of sources) {
      const destination=join(context,target);mkdirSync(dirname(destination),{recursive:true,mode:0o700});
      if(directory)cpSync(join(root,source),destination,{recursive:true});else copyFileSync(join(root,source),destination);
    }
    await output(['build','--network','none','--pull=false','--build-arg',`HISTORICAL_IMAGE=${historical}`,'-t',resources.image,context],{timeout:120000});
    assert.equal(await output(['image','inspect','--format','{{.Id}}',historical]),expectedBaseId);
    const imageId=await output(['image','inspect','--format','{{.Id}}',resources.image]);assert.match(imageId,/^sha256:[a-f0-9]{64}$/);
    writeFileSync(join(evidenceDir,'image.json'),JSON.stringify({historical,expectedBaseId,image:resources.image,imageId,...(profile?{profile:sms?'sms':'private-api',bundle:sms?'current standalone source':'isolated framework acceptance'}:{})})+'\n',{mode:0o600,flush:true});
    stage='container startup';started=true;
    await output([...compose,'up','-d','--no-deps','--no-build','--pull','never',profile?.service??'smtp-test']);
    // Each profile gates fixtures on its real service and isolated SQLite state.
    // Private API acceptance intentionally seeds one inaccessible legacy sentinel.
    await output([...compose,'run','--no-deps','--pull','never','--name',resources.readiness,'verifier','--readiness-only'],{timeout:180000,evidence:'readiness.jsonl'});
    const state=JSON.parse(await output(['inspect','--format','{"running":{{.State.Running}},"oom":{{.State.OOMKilled}}}',resources.container]));
    assert.deepEqual(state,{running:true,oom:false});
    stage='synthetic fixture provisioning';
    cleanupState('revocation_required');fixtures=true;
    await psql(profile?profile.provisionSql(manifest):`BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE devcaught_auth_owner; SET LOCAL synchronous_commit=on;
      SELECT pg_advisory_xact_lock(74008);
      -- This is a separate command after lock acquisition, so its snapshot sees
      -- any cancellation committed by a previous lock holder. No fixture write
      -- may precede this authorization check or release the lock before COMMIT.
      DO $authorized$ BEGIN
        IF EXISTS (SELECT 1 FROM smtp_inbox_route WHERE destination='${cancellationDestination}')
        THEN RAISE EXCEPTION 'Synthetic run permanently cancelled'; END IF;
      END; $authorized$;
      INSERT INTO "user"(id,name,email,"emailVerified") VALUES
        ('${manifest.a.user}','SYNTHETIC SMTP INTEGRATION OWNER A','${manifest.a.destination}',false),
        ('${manifest.b.user}','SYNTHETIC SMTP INTEGRATION OWNER B','${manifest.b.destination}',false);
      INSERT INTO private_inbox(id,owner_id) VALUES ('${manifest.a.inbox}','${manifest.a.user}'),('${manifest.b.inbox}','${manifest.b.user}');
      INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('${manifest.a.destination}','${manifest.a.inbox}'),('${manifest.alias}','${manifest.a.inbox}'),('${manifest.b.destination}','${manifest.b.inbox}');
      INSERT INTO smtp_inbox_route(destination,inbox_id,state,revoked_at) VALUES ('${manifest.revoked}','${manifest.a.inbox}','revoked',now()); COMMIT;`);
    if(!profile)await psql(`BEGIN; SET LOCAL ROLE devcaught_auth_owner;
      DO $test$ BEGIN BEGIN INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('${manifest.a.destination}','${manifest.b.inbox}');
        EXCEPTION WHEN unique_violation THEN RETURN; END; RAISE EXCEPTION 'Ambiguous assignment unexpectedly accepted'; END $test$; ROLLBACK;`);
    stage='verifier execution';
    await output([...compose,'run','--no-deps','--pull','never','--name',resources.verifier,'verifier'],{timeout:240000,evidence:'verification.jsonl'});
    save({outcome:'pass',category:'none'});
  }else {await targetPreflight();}
}catch(error){save({outcome:'fail',category:category(error)});process.exitCode=1;}
finally {
  cleaning=true;
  if(started) {
    stage='cleanup stop';
    for(const name of [resources.verifier,resources.readiness,resources.container]) {
      try{await stopOwned(name);}catch{save({outcome:'fail',category:'unknown'});process.exitCode=1;}
    }
    stage='application observation';
    try {
      const file=join(evidenceDir,'application-source.jsonl');await output(['cp',`${resources.container}:/app/data/process-diagnostics.jsonl`,file]);
      const records=parseDiagnostics(readFileSync(file,'utf8'));writeFileSync(file,records.map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600,flush:true});
      for(const row of records)save(row);
    }catch{save({outcome:'fail',category:'file_missing'});process.exitCode=1;}
  }
  stage='cleanup fixture revocation';
  if(fixtures) {
    let revoked=false;
    // Recovery must revalidate the dedicated target too; never mutate an unchecked DB.
    try {
      await targetPreflight();
      for(let attempt=0;attempt<3&&!revoked;attempt++)try{await revoke();
        if(privateApi) {
          const names=await output(['container','ls','-a','--format','{{.Names}}']);
          if(names.split('\n').includes(resources.container)) {
            assert.equal(await output(['inspect','--format','{{index .Config.Labels "devcaught.smtp-run"}}',resources.container]),manifest.run);
            assert.equal(await output(['inspect','--format','{{.State.Running}}',resources.container]),'false');
          }
        }
        revoked=true;}catch{save({outcome:'fail',category:'unknown'});}
    }catch{save({outcome:'fail',category:'unknown'});}
    cleanupState(revoked?(profile?.cleanupSuccessState??'revoked_verified'):'revocation_required');save({outcome:revoked?'pass':'fail',category:revoked?'none':'unknown'});
    if(!revoked){process.exitCode=1;console.error(`BLOCKED: revocation required; use retained recovery command in ${evidenceDir}/cleanup-state.json`);}
  }
  if(interrupted)process.exitCode=1;
  if(privateApi){durableMetadata.phase='complete';durableMetadata.completed=true;durableMetadata.acceptance=recovery?'UNKNOWN':process.exitCode?'FAIL':'PASS';durable.persistMetadata(evidenceDir,durableMetadata);}
  console.log(privateApi
    ?`Sanitized evidence and scoped recovery: ${evidenceDir}; cancelled invitations and new Docker resources retained`
    :`Sanitized evidence and scoped recovery: ${evidenceDir}; synthetic owners/inboxes and route tombstones are permanent; new Docker resources retained`);
}
