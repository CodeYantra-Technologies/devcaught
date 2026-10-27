import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { pgliteDialect } from "../auth/pglite-dialect.ts";
import { privateInboxTargetReady } from "./private-inbox-readiness.ts";

async function fixture(t: TestContext) {
  const pg = new PGlite();
  const db = new Kysely<unknown>({ dialect: pgliteDialect(() => pg) });
  t.after(async () => { await db.destroy(); await pg.close(); });
  await pg.exec('CREATE TABLE "user" (id text PRIMARY KEY); CREATE TABLE _migrations (name text PRIMARY KEY)');
  return { pg, db };
}

test("target readiness requires the actual migration ledger and registry constraints", async t => {
  const { pg, db } = await fixture(t);
  assert.equal(await privateInboxTargetReady(db), false);
  await pg.exec(readFileSync(new URL("../../../migrations/0003_private_inboxes.sql", import.meta.url), "utf8"));
  assert.equal(await privateInboxTargetReady(db), false);
  await pg.exec("INSERT INTO _migrations VALUES ('0001_auth.sql'), ('0002_invitations.sql'), ('0003_private_inboxes.sql')");
  assert.equal(await privateInboxTargetReady(db), true);
  await pg.exec("ALTER TABLE private_inbox DROP CONSTRAINT private_inbox_owner_id_key");
  assert.equal(await privateInboxTargetReady(db), false);
});

test("missing target ledger and query errors fail closed", async t => {
  const { pg, db } = await fixture(t);
  await pg.exec("DROP TABLE _migrations");
  assert.equal(await privateInboxTargetReady(db), false);
  const broken = db.withPlugin({ transformQuery() { throw new Error("fixture connection failure"); }, transformResult: async ({ result }) => result });
  assert.equal(await privateInboxTargetReady(broken), false);
});
