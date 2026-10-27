import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const resources={project:'devcaught-private-api-2j2',image:'devcaught:private-api-acceptance-2j2',
  container:'devcaught-private-api-2j2',readiness:'devcaught-private-api-readiness-2j2',verifier:'devcaught-private-api-verifier-2j2',
  volume:'devcaught_private_api_2j2_data',network:'devcaught_private_api_2j2_net'};
export const prefix='devcaught-private-api-2j2-',claim='/tmp/devcaught-private-api-2j2.claim';
export const composeFile='compose.private-api-2j2.yaml',service='auth-test',origin='http://auth-test:3000';
export const readinessCheck='AUTH framework readiness anonymous denial and isolated legacy sentinel';
export const requiredChecks=[
  'AUTH invited users login with secure cookies and real framework session ownership',
  'AUTH own reads cross-owner anonymous and legacy-unassigned denial',
  'AUTH scoped delete clear and mutation-origin enforcement',
  'AUTH logout invalidates session and old cookie replay',
];
const hash=value=>createHash('sha256').update(value).digest('hex');
// Disposable fixture material; never production credentials or recorded cookies.
export const invitationToken=(run,letter)=>createHash('sha256').update(`test-invite:${run}:${letter}`).digest('base64url');
export const password=(run,letter)=>'Synthetic-Only-'+hash(`test-password:${run}:${letter}`);
export const signingMaterial=run=>hash(`test-session-signing:${run}`);
export function makeManifest(run) {
  const owner=letter=>({email:`private-api-${run}-${letter}@integration.invalid`,invitation:`api-invite-${run}-${letter}`,
    tokenHash:hash(invitationToken(run,letter))});
  return {run,a:owner('a'),b:owner('b'),cancelled:`api-cancel-${run}`,
    cancelEmail:`private-api-${run}-cancelled@integration.invalid`,cancelHash:hash(`cancel:${run}`),legacyId:run};
}
export function validateManifest(m) {
  assert.match(m.run,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(m,makeManifest(m.run));
}
const emails=m=>`('${m.a.email}','${m.b.email}')`;
const marker=m=>`id='${m.cancelled}' AND email='${m.cancelEmail}' AND "tokenHash"='${m.cancelHash}' AND revoked=true`;
const begin=`BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE devcaught_auth_owner; SET LOCAL synchronous_commit=on; SELECT pg_advisory_xact_lock(74008);`;
const invitation=(id,email,tokenHash,revoked)=>`('${id}','${email}','${tokenHash}',now(),now()+interval '1 hour',false,${revoked})`;
export const preflightExpected={users:0,inboxes:0,invitations:0};
export function preflightSql(m) {return `SELECT json_build_object('users',(SELECT count(*) FROM "user" WHERE email IN ${emails(m)}),
  'inboxes',(SELECT count(*) FROM private_inbox WHERE owner_id IN (SELECT id FROM "user" WHERE email IN ${emails(m)})),
  'invitations',(SELECT count(*) FROM invitation WHERE id IN ('${m.a.invitation}','${m.b.invitation}','${m.cancelled}')
    OR email IN ('${m.a.email}','${m.b.email}','${m.cancelEmail}') OR "tokenHash" IN ('${m.a.tokenHash}','${m.b.tokenHash}','${m.cancelHash}')))`;}
export function provisionSql(m) {return `${begin}
  DO $authorized$ BEGIN IF EXISTS (SELECT 1 FROM invitation WHERE id='${m.cancelled}')
    THEN RAISE EXCEPTION 'Synthetic auth run cancelled'; END IF; END; $authorized$;
  INSERT INTO invitation(id,email,"tokenHash","createdAt","expiresAt",consumed,revoked) VALUES
    ${invitation(m.a.invitation,m.a.email,m.a.tokenHash,false)},${invitation(m.b.invitation,m.b.email,m.b.tokenHash,false)}; COMMIT;`;}
export function revokeSql(m) {return `${begin}
  INSERT INTO invitation(id,email,"tokenHash","createdAt","expiresAt",consumed,revoked) VALUES
    ${invitation(m.cancelled,m.cancelEmail,m.cancelHash,true)},${invitation(m.a.invitation,m.a.email,m.a.tokenHash,true)},${invitation(m.b.invitation,m.b.email,m.b.tokenHash,true)}
    ON CONFLICT (id) DO NOTHING;
  DO $identity$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM invitation WHERE ${marker(m)})
      OR NOT EXISTS (SELECT 1 FROM invitation WHERE id='${m.a.invitation}' AND email='${m.a.email}' AND "tokenHash"='${m.a.tokenHash}')
      OR NOT EXISTS (SELECT 1 FROM invitation WHERE id='${m.b.invitation}' AND email='${m.b.email}' AND "tokenHash"='${m.b.tokenHash}')
    THEN RAISE EXCEPTION 'Synthetic invitation identity mismatch'; END IF; END; $identity$;
  UPDATE invitation SET revoked=true WHERE id IN ('${m.a.invitation}','${m.b.invitation}') AND email IN ${emails(m)};
  COMMIT;
  -- Cancellation stays committed even if an unexpected route FK blocks deletion.
  ${begin}
  DELETE FROM private_inbox WHERE owner_id IN (SELECT id FROM "user" WHERE email IN ${emails(m)});
  DELETE FROM session WHERE "userId" IN (SELECT id FROM "user" WHERE email IN ${emails(m)});
  DELETE FROM account WHERE "userId" IN (SELECT id FROM "user" WHERE email IN ${emails(m)});
  DELETE FROM "user" WHERE email IN ${emails(m)}; COMMIT;`;}
export const revocationExpected={cancelled:true,revoked:2,users:0,inboxes:0};
export const cleanupSuccessState='cleanup_verified';
export function revocationCheckSql(m) {return `SELECT json_build_object('cancelled',EXISTS (SELECT 1 FROM invitation WHERE ${marker(m)}),
  'revoked',(SELECT count(*) FROM invitation WHERE id IN ('${m.a.invitation}','${m.b.invitation}') AND email IN ${emails(m)} AND revoked=true),
  'users',(SELECT count(*) FROM "user" WHERE email IN ${emails(m)}),
  'inboxes',(SELECT count(*) FROM private_inbox WHERE owner_id IN (SELECT id FROM "user" WHERE email IN ${emails(m)})))`;}

export const buildSources=[
  ['scripts/private-api-acceptance/Dockerfile','Dockerfile'],
  ['scripts/private-api-acceptance/vite.config.mjs','scripts/private-api-acceptance/vite.config.mjs'],
  ['scripts/private-api-acceptance/profile.mjs','scripts/private-api-acceptance/profile.mjs'],
  ['scripts/private-api-acceptance/app','scripts/private-api-acceptance/app',true],
  ['scripts/smtp-integration/launch.mjs','launch.mjs'],['scripts/smtp-integration/diagnostics.mjs','diagnostics.mjs'],
  ['package.json','package.json'],['package-lock.json','package-lock.json'],
  ['apps/server/package.json','apps/server/package.json'],['apps/server/src','apps/server/src',true],
  ['packages/shared/package.json','packages/shared/package.json'],['packages/shared/src','packages/shared/src',true],
  ['packages/parsers/package.json','packages/parsers/package.json'],['packages/parsers/src','packages/parsers/src',true],
  ...['auth-config.ts','invitation-policy.ts','invitations.ts','private-inbox.ts','session-policy.ts','private-inbox.server.ts','verify.server.ts','http-handler.ts']
    .map(name=>[`src/lib/auth/${name}`,`src/lib/auth/${name}`]),
  ...['private-inbox-api.ts','private-inbox-readiness.ts','private-inbox-release.ts']
    .map(name=>[`src/lib/inbox/${name}`,`src/lib/inbox/${name}`]),
  ['src/lib/http-result.ts','src/lib/http-result.ts'],
];
