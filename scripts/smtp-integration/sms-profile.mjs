import assert from 'node:assert/strict';

export const resources={project:'devcaught-sms-integration-2i4',image:'devcaught:sms-routing-integration-2i4',
  container:'devcaught-sms-routing-2i4',verifier:'devcaught-sms-routing-verifier-2i4',
  readiness:'devcaught-sms-routing-readiness-2i4',volume:'devcaught_sms_routing_2i4_data',network:'devcaught_sms_routing_2i4_net'};
export const prefix='devcaught-sms-integration-2i4-';
export const claim='/tmp/devcaught-sms-integration-2i4.claim';
export const composeFile='compose.sms-integration-2i4.yaml';
export const service='sms-test';
// Public fixture value, not a real Twilio credential. Never used externally.
export const syntheticToken='SYNTHETIC_SMS_INTEGRATION_2I4_ONLY';
export const readinessCheck='SMS pre-fixture signed absent route returns 404 with zero writes';
export const requiredChecks=[
  'SMS signed form and JSON deliver to correct isolated inboxes',
  'SMS duplicate returns the original scoped message without another write',
  'SMS invalid authentication unknown revoked and malformed requests never write',
  'SMS PostgreSQL proxy outage returns 503 without writes and recovery delivers',
  'SMS final scoped persistence and zero unassigned rows',
];
export function makeManifest(run) {
  const hex=run.replaceAll('-','');
  const digits=(Number.parseInt(hex.slice(0,8),16)%1000000).toString().padStart(6,'0');
  const number=suffix=>`+1555${digits}${suffix}`;
  const owner=(letter,suffix)=>({user:`sms_it_${letter}_${run}`,inbox:`inbox_sms_it_${letter}_${run}`,
    email:`sms-it-${run}-${letter}@integration.invalid`,destination:number(suffix)});
  return {run,provider:'twilio',accountSid:'AC'+hex,a:owner('a','1'),b:owner('b','2'),
    revoked:number('3'),unknown:number('4'),cancelled:number('5'),
    publicUrl:'https://sms.integration.invalid/api/webhooks/twilio'};
}
export function validateManifest(manifest) {
  assert.match(manifest.run,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(manifest,makeManifest(manifest.run));
}
const account=m=>`provider='twilio' AND provider_account_id='${m.accountSid}'`;
const fence=m=>`${account(m)} AND destination='${m.cancelled}'`;
const begin=`BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE devcaught_auth_owner;
  SET LOCAL synchronous_commit=on; SELECT pg_advisory_xact_lock(74008);`;
export function preflightSql(m) {
  return `SELECT json_build_object('users',(SELECT count(*) FROM "user" WHERE id IN ('${m.a.user}','${m.b.user}') OR email IN ('${m.a.email}','${m.b.email}')),
    'inboxes',(SELECT count(*) FROM private_inbox WHERE id IN ('${m.a.inbox}','${m.b.inbox}')),
    'routes',(SELECT count(*) FROM sms_inbox_route WHERE ${account(m)}))`;
}
export function provisionSql(m) {
  return `${begin}
    -- A separate statement after lock acquisition must observe committed fencing.
    DO $authorized$ BEGIN IF EXISTS (SELECT 1 FROM sms_inbox_route WHERE ${fence(m)})
      THEN RAISE EXCEPTION 'Synthetic SMS run permanently cancelled'; END IF; END; $authorized$;
    INSERT INTO "user"(id,name,email,"emailVerified") VALUES
      ('${m.a.user}','SYNTHETIC SMS OWNER A','${m.a.email}',false),('${m.b.user}','SYNTHETIC SMS OWNER B','${m.b.email}',false);
    INSERT INTO private_inbox(id,owner_id) VALUES ('${m.a.inbox}','${m.a.user}'),('${m.b.inbox}','${m.b.user}');
    INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id) VALUES
      ('twilio','${m.accountSid}','${m.a.destination}','${m.a.inbox}'),('twilio','${m.accountSid}','${m.b.destination}','${m.b.inbox}');
    INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id,state,revoked_at)
      VALUES ('twilio','${m.accountSid}','${m.revoked}','${m.a.inbox}','revoked',now()); COMMIT;`;
}
export function revokeSql(m) {
  return `${begin}
    INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('${m.a.user}','SYNTHETIC SMS OWNER A','${m.a.email}',false) ON CONFLICT (id) DO NOTHING;
    INSERT INTO private_inbox(id,owner_id) VALUES ('${m.a.inbox}','${m.a.user}') ON CONFLICT (id) DO NOTHING;
    DO $anchor$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM "user" WHERE id='${m.a.user}' AND email='${m.a.email}')
        OR NOT EXISTS (SELECT 1 FROM private_inbox WHERE id='${m.a.inbox}' AND owner_id='${m.a.user}')
      THEN RAISE EXCEPTION 'Synthetic SMS anchor mismatch'; END IF; END; $anchor$;
    INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id,state,revoked_at)
      VALUES ('twilio','${m.accountSid}','${m.cancelled}','${m.a.inbox}','revoked',now())
      ON CONFLICT (provider,provider_account_id,destination) DO NOTHING;
    DO $cancel$ BEGIN IF NOT EXISTS (SELECT 1 FROM sms_inbox_route WHERE ${fence(m)}
      AND inbox_id='${m.a.inbox}' AND state='revoked' AND revoked_at IS NOT NULL)
      THEN RAISE EXCEPTION 'Synthetic SMS fence mismatch'; END IF; END; $cancel$;
    UPDATE sms_inbox_route SET state='revoked',revoked_at=now()
      WHERE ${account(m)} AND inbox_id IN ('${m.a.inbox}','${m.b.inbox}') AND state='active'; COMMIT;`;
}
export function revocationCheckSql(m) {
  return `SELECT json_build_object('cancelled',EXISTS (SELECT 1 FROM sms_inbox_route WHERE ${fence(m)}
    AND inbox_id='${m.a.inbox}' AND state='revoked' AND revoked_at IS NOT NULL),
    'active',(SELECT count(*) FROM sms_inbox_route WHERE ${account(m)} AND state='active'))`;
}
// Paths relative to the workspace; only these source trees/files enter the build.
export const buildSources=[
  ['scripts/smtp-integration/Dockerfile.sms','Dockerfile'],
  ['scripts/smtp-integration/launch.mjs','launch.mjs'],
  ['scripts/smtp-integration/ingestion-bootstrap.mjs','ingestion-bootstrap.mjs'],
  ['scripts/smtp-integration/diagnostics.mjs','diagnostics.mjs'],
  ['scripts/smtp-integration/ingestion.vite.mjs','scripts/smtp-integration/ingestion.vite.mjs'],
  ['package.json','package.json'],['package-lock.json','package-lock.json'],
  ['apps/server/package.json','apps/server/package.json'],['apps/server/src','apps/server/src',true],
  ['packages/shared/package.json','packages/shared/package.json'],['packages/shared/src','packages/shared/src',true],
  ['packages/parsers/package.json','packages/parsers/package.json'],['packages/parsers/src','packages/parsers/src',true],
  ['src/lib/inbox/private-inbox-routing.server.ts','src/lib/inbox/private-inbox-routing.server.ts'],
];
