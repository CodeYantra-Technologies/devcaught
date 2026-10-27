import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { pgliteDialect } from "./pglite-dialect.ts";
import { provisionPrivateInbox, resolvePrivateInbox } from "./private-inbox.ts";
import type { SessionReader } from "./session-policy.ts";

const ownershipMigration = readFileSync(
  new URL("../../../migrations/0003_private_inboxes.sql", import.meta.url), "utf8",
);

async function fixture(t: TestContext) {
  // Explicit in-memory database. No runtime singleton or configuration imports.
  const pg = new PGlite();
  const db = new Kysely<unknown>({ dialect: pgliteDialect(() => pg) });
  t.after(async () => { await db.destroy(); await pg.close(); });
  await pg.exec(readFileSync(
    new URL("../../../migrations/0001_auth.sql", import.meta.url), "utf8",
  ));
  // Simulate users who existed before ownership was introduced.
  await pg.exec(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES
    ('user-a', 'A', 'a@example.test', false),
    ('user-b', 'B', 'b@example.test', false)`);
  await pg.exec(ownershipMigration);
  return { pg, db };
}

test("existing users receive distinct private inboxes; provisioning preserves IDs", async t => {
  const { pg, db } = await fixture(t);
  const a = await provisionPrivateInbox(db, "user-a");
  const b = await provisionPrivateInbox(db, "user-b");
  assert.notEqual(a.id, b.id);
  assert.equal(a.owner_id, "user-a");
  assert.equal(b.owner_id, "user-b");
  assert.deepEqual(await provisionPrivateInbox(db, "user-a"), a);
  await pg.exec(ownershipMigration);
  assert.deepEqual(await provisionPrivateInbox(db, "user-b"), b);
  assert.equal((await pg.query("SELECT id FROM private_inbox")).rows.length, 2);
});

test("concurrent provisioning requests converge on one inbox per owner (embedded PostgreSQL)", async t => {
  const { pg, db } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    provisionPrivateInbox(db, index % 2 ? "user-a" : "user-b"),
  ));
  for (const owner of ["user-a", "user-b"]) {
    assert.equal(new Set(results.filter(row => row.owner_id === owner).map(row => row.id)).size, 1);
  }
  assert.equal((await pg.query("SELECT id FROM private_inbox")).rows.length, 2);
});

test("registry enforces ownership uniqueness and user foreign keys", async t => {
  const { pg, db } = await fixture(t);
  const a = await provisionPrivateInbox(db, "user-a");
  await assert.rejects(pg.query(
    "INSERT INTO private_inbox (id, owner_id) VALUES ($1, $2)", ["another-inbox", "user-a"],
  ), (error: { code?: string }) => error.code === "23505");
  await assert.rejects(provisionPrivateInbox(db, "missing-user"),
    (error: { code?: string }) => error.code === "23503");
  await assert.rejects(pg.query('DELETE FROM "user" WHERE id = $1', ["user-a"]),
    (error: { code?: string }) => error.code === "23001");
  assert.deepEqual(await provisionPrivateInbox(db, "user-a"), a);
});

test("provisioning preserves a pre-existing registry assignment and creation time", async t => {
  const { pg, db } = await fixture(t);
  await pg.query(
    "INSERT INTO private_inbox (id, owner_id, created_at) VALUES ($1, $2, $3)",
    ["existing-private-inbox", "user-a", "2025-01-01T00:00:00Z"],
  );
  const before = await pg.query("SELECT * FROM private_inbox");
  assert.equal((await provisionPrivateInbox(db, "user-a")).id, "existing-private-inbox");
  assert.deepEqual((await pg.query("SELECT * FROM private_inbox")).rows, before.rows);
});

test("resolver uses a fresh session and ignores supplied identity/inbox headers", async t => {
  const { db } = await fixture(t);
  const b = await provisionPrivateInbox(db, "user-b");
  let calls = 0;
  const auth: SessionReader = {
    api: { async getSession(input) {
      calls++;
      assert.equal(input.query.disableCookieCache, true);
      return { user: { id: "user-a" } };
    } },
  };
  const a = await resolvePrivateInbox(auth, new Headers({
    "x-user-id": "user-b", "x-inbox-id": b.id,
  }), true, db);
  assert.equal(a?.owner_id, "user-a");
  assert.notEqual(a?.id, b.id);
  assert.equal(calls, 1);
});

test("unauthenticated/disabled resolution never provisions; verification errors fail closed", async t => {
  const { pg, db } = await fixture(t);
  const signedOut: SessionReader = { api: { getSession: async () => null } };
  assert.equal(await resolvePrivateInbox(signedOut, new Headers(), true, db), null);
  const forbidden: SessionReader = { api: { getSession: async () => { throw new Error("unavailable"); } } };
  assert.equal(await resolvePrivateInbox(forbidden, new Headers(), false, db), null);
  await assert.rejects(resolvePrivateInbox(forbidden, new Headers(), true, db), /unavailable/);
  assert.equal((await pg.query("SELECT id FROM private_inbox")).rows.length, 0);
});

test("transaction rollback removes provisioning metadata", async t => {
  const { pg, db } = await fixture(t);
  await assert.rejects(db.transaction().execute(async tx => {
    await provisionPrivateInbox(tx, "user-a");
    throw new Error("rollback test");
  }), /rollback test/);
  assert.equal((await pg.query("SELECT id FROM private_inbox")).rows.length, 0);
});
