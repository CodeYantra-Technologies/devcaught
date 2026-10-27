import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,appendFileSync,statSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {diagnostic,childDiagnostic,parseDiagnostics,parseVerifierEvidence,category} from './diagnostics.mjs';

process.chdir(fileURLToPath(new URL('../../',import.meta.url)));
const retry=process.argv.length===4 && process.argv[2]==='--retry-1-of' && process.argv[3]==='/tmp/devcaught-smtp-integration-3QQba4';
assert.ok(process.argv.length===2 || retry,'Unsupported retry arguments');
if(retry) {
  assert.equal(realpathSync(process.argv[3]),process.argv[3]);
  assert.ok(statSync(process.argv[3]).isDirectory());
  for(const name of ['manifest.json','verification.jsonl'])assert.ok(statSync(join(process.argv[3],name)).isFile());
}
const resources=retry?{
  project:'devcaught-smtp-integration-retry-1',container:'devcaught-smtp-routing-retry-1',verifier:'devcaught-smtp-routing-retry-verifier-1',
  volume:'devcaught_smtp_routing_retry_1_data',network:'devcaught_smtp_routing_retry_1_net',image:'devcaught:smtp-routing-integration-retry-1',
}:{project:'devcaught-smtp-integration',container:'devcaught-smtp-routing-test',verifier:'devcaught-smtp-routing-verifier',volume:'devcaught_smtp_routing_test_data',network:'devcaught_smtp_routing_test_net',image:'devcaught:smtp-routing-integration'};
const evidenceDir=mkdtempSync(join(tmpdir(),'devcaught-smtp-integration-'));
let stage='resource and target preflight',fixtures=false,started=false;
const run=randomUUID();
const owner=letter=>({user:`smtp_it_${letter}_${run}`,inbox:`inbox_smtp_it_${letter}_${run}`,destination:`smtp-it-${run}-${letter}@integration.invalid`});
const manifest={run,a:owner('a'),b:owner('b'),alias:`smtp-it-${run}-alias@integration.invalid`,revoked:`smtp-it-${run}-revoked@integration.invalid`};
if(retry) {
  const previous=JSON.parse(readFileSync(join(process.argv[3],'manifest.json'),'utf8'));
  assert.match(previous.run,/^[a-f0-9-]{36}$/);
  const oldOwner=letter=>({user:`smtp_it_${letter}_${previous.run}`,inbox:`inbox_smtp_it_${letter}_${previous.run}`,destination:`smtp-it-${previous.run}-${letter}@integration.invalid`});
  assert.deepEqual(previous,{run:previous.run,a:oldOwner('a'),b:oldOwner('b'),alias:`smtp-it-${previous.run}-alias@integration.invalid`,revoked:`smtp-it-${previous.run}-revoked@integration.invalid`});
  for(const letter of ['a','b']){manifest[letter].user=previous[letter].user;manifest[letter].inbox=previous[letter].inbox;}
  manifest.revoked=previous.revoked;
}
const env={...process.env,DEVCAUGHT_AUTH_SECRET_DIR:join(process.env.HOME,'.local/share/devcaught/auth-dev-secrets'),DEVCAUGHT_SMTP_MANIFEST:join(evidenceDir,'manifest.json')};
writeFileSync(env.DEVCAUGHT_SMTP_MANIFEST,JSON.stringify(manifest,null,2),{mode:0o644,flag:'wx'});
const compose=['compose','--env-file','/dev/null','-p',resources.project,'-f','compose.smtp-integration.yaml',...(retry?['-f','compose.smtp-integration-retry-1.yaml']:[])];
function save(input) {
  const line=JSON.stringify(diagnostic({executionStage:stage,...input}))+'\n';
  appendFileSync(join(evidenceDir,'diagnostics.jsonl'),line,{mode:0o600,flush:true});
  process.stdout.write(line);
}
function docker(args,{input,timeout=60000,evidence}={}) {
  if(evidence)writeFileSync(join(evidenceDir,evidence),JSON.stringify(diagnostic({component:'verifier',executionStage:stage,outcome:'start',category:'none'}))+'\n',{mode:0o600,flush:true});
  const result=spawnSync('docker',args,{env,input,encoding:'utf8',timeout,maxBuffer:16*1024*1024,stdio:['pipe','pipe','ignore']});
  if(evidence) {
    const records=parseVerifierEvidence(result.stdout);
    const last=records.findLast(row=>row.kind==='smtp_integration_diagnostic');
    const summary=childDiagnostic(result,{component:'verifier',executionStage:stage,verifierSubstage:last?.verifierSubstage});
    appendFileSync(join(evidenceDir,evidence),[...records,summary].map(row=>JSON.stringify(row)+'\n').join(''),{flush:true});
    for(const row of [...records,summary])if(row.kind==='smtp_integration_diagnostic')save(row);
  }
  if(result.status!==0 || result.error) {
    if(!evidence)save(childDiagnostic(result,{component:'runner',executionStage:stage}));
    throw new Error('bounded operation failed');
  }
  return result.stdout.trim();
}
const psql=text=>docker(['exec','-i','devcaught-pg-dev','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-U','postgres','-d','devcaught_auth_dev'],{input:`SET statement_timeout='15s'; SET lock_timeout='3s';\n${text}\n`});
const json=text=>JSON.parse(psql(text).split('\n').filter(Boolean).at(-1));
function cleanupFixtures() {
  psql(`BEGIN; SET LOCAL ROLE devcaught_auth_owner;
    UPDATE smtp_inbox_route SET state='revoked',revoked_at=now()
    WHERE state='active' AND ((inbox_id='${manifest.a.inbox}' AND destination IN ('${manifest.a.destination}','${manifest.alias}'))
      OR (inbox_id='${manifest.b.inbox}' AND destination='${manifest.b.destination}'));
    COMMIT;`);
  console.log('Synthetic routes revoked; permanent tombstones, owners and inboxes retained.');
}
try {
  docker(['info','--format','{{.ServerVersion}}']);
  for(const [kind,name] of [['container',resources.container],['container',resources.verifier],['volume',resources.volume],['network',resources.network]]) {
    const args=[kind,'ls',...(kind==='container'?['-a']:[]),'--format','{{.Name}}'];
    if(kind==='container')args[args.length-1]='{{.Names}}';
    assert.ok(!docker(args).split('\n').includes(name),'resource name conflict');
  }
  for(const kind of ['container','volume','network'])assert.equal(docker([kind,'ls',...(kind==='container'?['-a']:[]),'-q','--filter',`label=com.docker.compose.project=${resources.project}`]),'');
  for(const tag of [resources.image,...(retry?[]:['devcaught:smtp-routing-integration-base'])])assert.equal(docker(['image','ls','-q',tag]),'');
  if(retry)assert.ok(docker(['image','ls','-q','devcaught:smtp-routing-integration-base']),'Original normal base image required');
  const meta=format=>docker(['inspect','--type','container','--format',format,'devcaught-pg-dev']);
  assert.equal(meta('{{.Name}}'),'/devcaught-pg-dev');
  assert.equal(meta('{{index .Config.Labels "com.docker.compose.project"}}'),'devcaught-auth-dev');
  assert.equal(meta('{{index .Config.Labels "com.docker.compose.service"}}'),'postgres-dev');
  assert.equal(meta('{{.State.Health.Status}}'),'healthy');
  assert.equal(meta('{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'),'devcaught_pg_dev_data');
  assert.equal(docker(['network','inspect','--format','{{.Internal}}','devcaught_pg_dev_net']),'true');
  assert.deepEqual(json("SELECT json_build_object('database',current_database(),'version',current_setting('server_version_num')::int/10000,'socket',inet_server_addr() IS NULL)"),{database:'devcaught_auth_dev',version:16,socket:true});
  assert.deepEqual(json('SELECT json_agg(name ORDER BY name) FROM _migrations'),['0001_auth.sql','0002_invitations.sql','0003_private_inboxes.sql','0004_private_inbox_routing.sql']);
  assert.deepEqual(json(`SELECT json_build_object('users',(SELECT count(*) FROM "user" WHERE id IN ('${manifest.a.user}','${manifest.b.user}') OR email IN ('${manifest.a.destination}','${manifest.b.destination}')),
    'inboxes',(SELECT count(*) FROM private_inbox WHERE id IN ('${manifest.a.inbox}','${manifest.b.inbox}')),
    'routes',(SELECT count(*) FROM smtp_inbox_route WHERE destination IN ('${manifest.a.destination}','${manifest.b.destination}','${manifest.alias}','${manifest.revoked}')))`),retry?{users:2,inboxes:2,routes:1}:{users:0,inboxes:0,routes:0});
  if(retry)assert.deepEqual(json(`SELECT json_build_object('owners',(SELECT count(*) FROM private_inbox WHERE (id='${manifest.a.inbox}' AND owner_id='${manifest.a.user}') OR (id='${manifest.b.inbox}' AND owner_id='${manifest.b.user}')),
    'revoked',(SELECT count(*) FROM smtp_inbox_route WHERE destination='${manifest.revoked}' AND inbox_id='${manifest.a.inbox}' AND state='revoked'))`),{owners:2,revoked:1});
  const guard=readFileSync('src/lib/inbox/private-inbox-release.ts','utf8');
  assert.match(guard,/export const PRIVATE_INBOX_POSTGRES_VERIFIED = false;/);
  assert.ok(!guard.includes('= true'));
  docker([...compose,'config','--quiet']);
  if(retry)writeFileSync('/tmp/devcaught-smtp-integration-3QQba4-retry-1.claim',JSON.stringify({evidenceDir}),{flag:'wx',mode:0o600,flush:true});
  stage='normal image and standalone ingestion build';
  // No credentials or DATABASE_URL passed to either build. Dockerfile unsets it.
  if(!retry)docker(['build','-f','Dockerfile','-t','devcaught:smtp-routing-integration-base','.'],{timeout:600000});
  docker([...compose,'build','smtp-test'],{timeout:600000});
  docker(['pull','node:22-bookworm-slim'],{timeout:180000});
  stage='synthetic fixture provisioning';
  // Revocation is attempted even if COMMIT succeeds but the client loses its reply.
  fixtures=true;
  psql(`BEGIN; SET LOCAL ROLE devcaught_auth_owner;
    SELECT pg_advisory_xact_lock(74008);
    ${retry?'':`INSERT INTO "user"(id,name,email,"emailVerified") VALUES
      ('${manifest.a.user}','SYNTHETIC SMTP INTEGRATION OWNER A','${manifest.a.destination}',false),
      ('${manifest.b.user}','SYNTHETIC SMTP INTEGRATION OWNER B','${manifest.b.destination}',false);
    INSERT INTO private_inbox(id,owner_id) VALUES ('${manifest.a.inbox}','${manifest.a.user}'),('${manifest.b.inbox}','${manifest.b.user}');`}
    INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('${manifest.a.destination}','${manifest.a.inbox}'),('${manifest.alias}','${manifest.a.inbox}'),('${manifest.b.destination}','${manifest.b.inbox}');
    ${retry?'':`INSERT INTO smtp_inbox_route(destination,inbox_id,state,revoked_at) VALUES ('${manifest.revoked}','${manifest.a.inbox}','revoked',now());`}
    COMMIT;`);
  psql(`BEGIN; SET LOCAL ROLE devcaught_auth_owner;
    DO $test$ BEGIN BEGIN
      INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('${manifest.a.destination}','${manifest.b.inbox}');
      EXCEPTION WHEN unique_violation THEN RETURN; END;
      RAISE EXCEPTION 'Ambiguous assignment unexpectedly accepted'; END $test$;
    ROLLBACK;`);
  stage='container startup';started=true;
  docker([...compose,'up','-d','--no-deps','--no-build','smtp-test']);
  stage='verifier execution';
  docker([...compose,'run','--rm','--no-deps','verifier'],{timeout:180000,evidence:'verification.jsonl'});
  console.log(readFileSync(join(evidenceDir,'verification.jsonl'),'utf8').trim());
  console.log('PASS: isolated SMTP integration. Ambiguous committed assignments are prevented by verified uniqueness, not injected into the shared registry.');
} catch(error) {
  save({component:'runner',outcome:'fail',category:category(error)});
  console.error(`BLOCKED: ${stage}; diagnostics suppressed to avoid exposing runtime data.`);process.exitCode=1;
} finally {
  if(started) {
    stage='application observation';
    try {
      const state=JSON.parse(docker(['inspect','--format','{"status":"{{.State.Status}}","exitCode":{{.State.ExitCode}},"oom":{{.State.OOMKilled}}',resources.container]));
      save({component:'application',outcome:'observation',applicationState:state.status,exitCode:state.status==='exited'?state.exitCode:null,cleanupRequested:false,category:state.status==='exited'?'child_exit':'none'});
    } catch {save({component:'application',outcome:'fail',category:'unknown'});}
    stage='cleanup stop';save({component:'runner',outcome:'start',cleanupRequested:true,category:'none'});
    try{docker([...compose,'stop','smtp-test']);save({component:'runner',outcome:'pass',cleanupRequested:true,category:'none'});}catch{console.error(`BLOCKED: stop only ${resources.container} manually`);process.exitCode=1;}
    stage='application observation';
    try {
      const path=join(evidenceDir,'application-source.jsonl');
      docker(['cp',`${resources.container}:/app/data/process-diagnostics.jsonl`,path]);
      const records=parseDiagnostics(readFileSync(path,'utf8'));
      writeFileSync(path,records.map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600,flush:true});
      for(const row of records)save(row);
    } catch {save({component:'application',outcome:'fail',category:'file_missing'});}
  }
  stage='cleanup fixture revocation';
  if(fixtures)try{cleanupFixtures();save({component:'runner',outcome:'pass',category:'none'});}catch{console.error('BLOCKED: synthetic fixture revocation failed; retain manifest for scoped follow-up');process.exitCode=1;}
  console.log(`Synthetic manifest and sanitized evidence retained at ${evidenceDir}; new SQLite volume/container retained. No existing application container operated on.`);
}
