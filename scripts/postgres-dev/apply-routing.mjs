import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pendingMigrations } from '../migration-plan.mjs';

// Exact dedicated container + local Unix socket; no URL, password or secret files.
const container = 'devcaught-pg-dev';
const database = 'devcaught_auth_dev';
const expected = ['0001_auth.sql', '0002_invitations.sql', '0003_private_inboxes.sql'];
const migration = '0004_private_inbox_routing.sql';
let stage = 'target and ledger preflight';
const root = new URL('../../', import.meta.url);
const dockerArgs = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-h', '/var/run/postgresql', '-U', 'postgres', '-d', database];
function command(args, input) {
  const result = spawnSync('docker', args, {input, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024});
  if (result.status !== 0) throw new Error('Bounded Docker/PostgreSQL operation failed');
  return result.stdout.trim();
}
const query = text => command(dockerArgs, `SET statement_timeout='20s'; SET lock_timeout='5s';\n${text}\n`);
function json(text) {
  const lines = query(text).split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1));
}
function catches(statement, exception) {
  // Statements contain generated UUIDs and fixed test constants only.
  return `DO $test$ BEGIN BEGIN ${statement}; EXCEPTION WHEN ${exception} THEN RETURN; END;
    RAISE EXCEPTION 'Expected synthetic constraint rejection'; END $test$;`;
}
function identity(prefix) {
  const suffix = randomUUID();
  return {user: `${prefix}_${suffix}`, inbox: `inbox_${suffix}`, email: `${prefix}-${suffix}@example.invalid`};
}
function fixture(x) {
  return `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('${x.user}','SYNTHETIC ROUTING ROLLBACK TEST','${x.email}',false);
    INSERT INTO private_inbox(id,owner_id) VALUES ('${x.inbox}','${x.user}');`;
}
async function concurrency() {
  const a = identity('race_a'), b = identity('race_b');
  const destination = `race-${randomUUID()}@example.invalid`;
  const first = spawn('docker', dockerArgs, {stdio: ['pipe','pipe','pipe']});
  let output = '';
  first.stderr.resume(); // Never forward server diagnostics or arbitrary output.
  let exitCode;
  const completed = new Promise(resolve => first.once('close', code => {exitCode = code; resolve(code);}));
  const ready = new Promise((resolve, reject) => {
    first.stdout.on('data', data => { output += data; if (output.includes('ROUTING_RACE_READY')) resolve(); });
    first.once('error', reject);
    first.once('close', () => reject(new Error('Race setup failed')));
  });
  const timer = setTimeout(() => first.kill(), 15000);
  try {
    first.stdin.write(`SET statement_timeout='10s'; SET lock_timeout='3s'; SET idle_in_transaction_session_timeout='10s'; BEGIN; SET LOCAL ROLE devcaught_auth_owner;
      ${fixture(a)} INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('${destination}','${a.inbox}');
      SELECT 'ROUTING_RACE_READY';\n`);
    await ready;
    // The second owner attempts the same INSERT...ON CONFLICT used by provisioning.
    // Winner stays uncommitted: loser must wait on unique-key arbitration, then
    // lock_timeout rejects it. Neither transaction commits any synthetic record.
    query(`BEGIN; SET LOCAL ROLE devcaught_auth_owner; SET LOCAL lock_timeout='1s'; ${fixture(b)}
      ${catches(`INSERT INTO smtp_inbox_route(destination,inbox_id)
        SELECT '${destination}', id FROM private_inbox WHERE owner_id='${b.user}'
        ON CONFLICT(destination) DO NOTHING`, 'lock_not_available')}
      ROLLBACK;`);
    first.stdin.end('ROLLBACK;\n');
    await completed;
    assert.equal(exitCode, 0);
    assert.deepEqual(json(`SELECT json_build_object('users',(SELECT count(*) FROM "user" WHERE id IN ('${a.user}','${b.user}')),
      'routes',(SELECT count(*) FROM smtp_inbox_route WHERE destination='${destination}'));`), {users:0,routes:0});
    console.log('PASS: concurrent conflicting destination claims serialize; loser times out; both transactions rolled back');
  } finally {
    clearTimeout(timer);
    if (exitCode === undefined) { first.stdin.end('ROLLBACK;\n'); first.kill(); }
  }
}
async function main() {
  const metadata = JSON.parse(command(['inspect', '--type', 'container', '--format',
    '{{json .Name}}', container]));
  assert.equal(metadata, '/devcaught-pg-dev');
  assert.equal(command(['inspect', '--type', 'container', '--format',
    '{{index .Config.Labels "com.docker.compose.project"}}', container]), 'devcaught-auth-dev');
  assert.equal(command(['inspect', '--type', 'container', '--format',
    '{{index .Config.Labels "com.docker.compose.service"}}', container]), 'postgres-dev');
  assert.equal(command(['inspect', '--type', 'container', '--format', '{{.State.Health.Status}}', container]), 'healthy');
  assert.equal(command(['inspect', '--type', 'container', '--format',
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}', container]), 'devcaught_pg_dev_data');
  const target = json(`SELECT json_build_object('database',current_database(),'user',current_user,
    'version',current_setting('server_version_num')::int/10000,'socket',inet_server_addr() IS NULL);`);
  assert.deepEqual(target, {database, user:'postgres', version:16, socket:true});
  const dependencies = json(`SELECT json_agg(json_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner)) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('_migrations','private_inbox','user') AND c.relkind='r';`);
  assert.deepEqual(dependencies, ['_migrations','private_inbox','user'].map(name => ({name,owner:'devcaught_auth_owner'})));
  const ledger = json('SELECT coalesce(json_agg(name ORDER BY name),\'[]\'::json) FROM _migrations;');
  assert.ok(JSON.stringify(ledger) === JSON.stringify(expected) || JSON.stringify(ledger) === JSON.stringify([...expected,migration]));
  const entries = readdirSync(new URL('migrations/', root));
  const pending = pendingMigrations(entries, ledger).map(x => x.name);
  assert.ok(pending.length === 0 || JSON.stringify(pending) === JSON.stringify([migration]));
  if (pending.length) {
    const absent = json(`SELECT json_build_object('smtp',to_regclass('smtp_inbox_route') IS NULL,
      'sms',to_regclass('sms_inbox_route') IS NULL);`);
    assert.deepEqual(absent, {smtp:true,sms:true});
  }
  const ddl = pending.length ? readFileSync(new URL(`migrations/${migration}`,root),'utf8') : '';
  // Same shared pending planner, ledger and atomic apply+record mechanism as migrate.mjs.
  // A dedicated adapter uses psql over the container socket instead of URL credentials.
  const ledgerLiteral = JSON.stringify(ledger).replaceAll("'", "''");
  stage = 'atomic migration and SELECT grants';
  query(`BEGIN; SET LOCAL ROLE devcaught_auth_owner;
    SELECT pg_advisory_xact_lock(74004);
    DO $check$ BEGIN
      IF (SELECT json_agg(name ORDER BY name)::jsonb FROM _migrations) IS DISTINCT FROM '${ledgerLiteral}'::jsonb THEN
        RAISE EXCEPTION 'Migration ledger changed; refusing execution';
      END IF;
    END $check$;
    ${ddl}
    ${pending.length ? `INSERT INTO _migrations(name) VALUES ('${migration}');` : ''}
    GRANT SELECT ON smtp_inbox_route,sms_inbox_route TO devcaught_auth_app;
    COMMIT;`);
  console.log(pending.length ? 'APPLIED: 0004_private_inbox_routing.sql only' : 'UNCHANGED: 0004 already recorded; no migration replayed');
  assert.deepEqual(json('SELECT json_agg(name ORDER BY name) FROM _migrations;'), [...expected,migration]);
  stage = 'rolled-back synthetic constraints';
  const a = identity('constraint_a'), b = identity('constraint_b');
  const smtp = `synthetic-${randomUUID()}@example.invalid`;
  const account = `synthetic_${randomUUID().replaceAll('-','')}`;
  query(`BEGIN; SET LOCAL ROLE devcaught_auth_owner; ${fixture(a)} ${fixture(b)}
    INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('${smtp}','${a.inbox}');
    INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id) VALUES ('twilio','${account}','+14155550123','${a.inbox}');
    ${catches(`INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('${smtp}','${b.inbox}')`, 'unique_violation')}
    ${catches(`INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id) VALUES ('twilio','${account}','+14155550123','${b.inbox}')`, 'unique_violation')}
    ${catches(`INSERT INTO smtp_inbox_route(destination,inbox_id) VALUES ('missing-${smtp}','nonexistent_${randomUUID()}')`, 'foreign_key_violation')}
    ${catches(`INSERT INTO sms_inbox_route(provider,provider_account_id,destination,inbox_id) VALUES ('twilio','${account}','+14155550124','nonexistent_${randomUUID()}')`, 'foreign_key_violation')}
    ${catches(`UPDATE smtp_inbox_route SET inbox_id='${b.inbox}' WHERE destination='${smtp}'`, 'check_violation')}
    ${catches(`UPDATE sms_inbox_route SET inbox_id='${b.inbox}' WHERE provider_account_id='${account}'`, 'check_violation')}
    ${catches(`UPDATE private_inbox SET id='changed_${randomUUID()}' WHERE id='${a.inbox}'`, 'check_violation')}
    ${catches(`UPDATE private_inbox SET owner_id='${b.user}' WHERE id='${a.inbox}'`, 'check_violation')}
    UPDATE smtp_inbox_route SET state='revoked',revoked_at=now() WHERE destination='${smtp}';
    UPDATE sms_inbox_route SET state='revoked',revoked_at=now() WHERE provider_account_id='${account}';
    ${catches(`UPDATE smtp_inbox_route SET state='active',revoked_at=NULL WHERE destination='${smtp}'`, 'check_violation')}
    ${catches(`UPDATE sms_inbox_route SET state='active',revoked_at=NULL WHERE provider_account_id='${account}'`, 'check_violation')}
    ${catches(`DELETE FROM smtp_inbox_route WHERE destination='${smtp}'`, 'check_violation')}
    ${catches(`DELETE FROM sms_inbox_route WHERE provider_account_id='${account}'`, 'check_violation')}
    ROLLBACK;`);
  console.log('PASS: SMTP/SMS uniqueness, foreign keys, immutable assignments/parent ownership, revoked tombstones; synthetic transaction rolled back');
  stage = 'rolled-back concurrent provisioning';
  await concurrency();
  const leftovers = json(`SELECT json_build_object('users',(SELECT count(*) FROM "user" WHERE id IN ('${a.user}','${b.user}')),
    'smtp',(SELECT count(*) FROM smtp_inbox_route WHERE destination='${smtp}'),
    'sms',(SELECT count(*) FROM sms_inbox_route WHERE provider_account_id='${account}'));`);
  assert.deepEqual(leftovers, {users:0,smtp:0,sms:0});
  stage = 'application-role effective privileges';
  const privileges = json(`SET ROLE devcaught_auth_app;
    SELECT json_agg(json_build_object('table',t,'select',has_table_privilege(current_user,t,'SELECT'),
      'write',has_table_privilege(current_user,t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(current_user,t,'INSERT,UPDATE,REFERENCES')) ORDER BY t)
    FROM unnest(ARRAY['smtp_inbox_route','sms_inbox_route']) t;`);
  assert.deepEqual(privileges, [
    {table:'sms_inbox_route',select:true,write:false}, {table:'smtp_inbox_route',select:true,write:false},
  ]);
  console.log('PASS: application role SELECT only on both routing tables; no table or column write privileges');
  // Execute the existing checker query verbatim as the app role, read-only.
  stage = 'existing read-only application-role readiness';
  const checker = readFileSync(new URL('src/lib/inbox/private-inbox-readiness.ts',root),'utf8');
  const matches = [...checker.matchAll(/sql<\{ ready: boolean \}>`([\s\S]*?)`\.execute\(db\)/g)];
  assert.equal(matches.length, 1);
  assert.ok(!matches[0][1].includes('${'));
  assert.ok(query(`BEGIN READ ONLY; SET LOCAL ROLE devcaught_auth_app; ${matches[0][1]}; ROLLBACK;`).split('\n').includes('t'));
  console.log('PASS: existing private inbox readiness query as application role in read-only transaction');
  console.log('COMPLETE: ledger 0001–0004; ingestion/application containers and release guard unchanged');
}
main().catch(() => {
  console.error(`BLOCKED: ${stage}; sensitive details suppressed. A committed migration is not undone by later verification failure.`);
  process.exitCode=1;
});
