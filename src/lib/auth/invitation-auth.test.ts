import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { Kysely } from "kysely";
import { invitationAuthPolicy, invitationPlugin } from "./invitation-policy.ts";
import { pgliteDialect } from "./pglite-dialect.ts";
import { AUTH_COOKIES } from "./auth-config.ts";
import { handleAuthRequest } from "./http-handler.ts";
import { newInvitation } from "./invitations.ts";
import { verifiedSessionUser } from "./session-policy.ts";
import { resolvePrivateInbox } from "./private-inbox.ts";
import { invitationCommand } from "../../../scripts/invitations.ts";
import { requireInboxAccess, requireGenericWebhookAccess } from "../../../apps/server/src/http/access-policy.ts";

// Explicit file allowlist. Never import the runtime auth/database singleton.
const migrations = ["0001_auth.sql", "0002_invitations.sql", "0003_private_inboxes.sql"].map(name => ({
  name, sql: readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"),
}));
const origin = "http://localhost:8080";
const email = "invited@example.test";
const password = "Disposable-test-password-8429!";

async function applyMigrations(db: PGlite) {
  await db.exec("CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY)");
  for (const { name, sql } of migrations) {
    await db.transaction(async tx => {
      if ((await tx.query("SELECT name FROM _migrations WHERE name = $1", [name])).rows.length) return;
      await tx.exec(sql);
      await tx.query("INSERT INTO _migrations(name) VALUES ($1)", [name]);
    });
  }
}

async function fixture(t: TestContext, failAccount = false) {
  const db = new PGlite();
  t.after(async () => { await db.close(); });
  await applyMigrations(db);
  const ownershipDb = new Kysely<unknown>({ dialect: pgliteDialect(() => db) });
  t.after(async () => { await ownershipDb.destroy(); });
  const auth = betterAuth({
    ...invitationAuthPolicy,
    database: { dialect: pgliteDialect(() => db), type: "postgres", transaction: true },
    secret: "isolated-test-only-signing-material-at-least-32-chars",
    baseURL: origin,
    trustedOrigins: [origin],
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
      cookies: AUTH_COOKIES,
      ipAddress: { ipAddressHeaders: [] },
    },
    plugins: [invitationPlugin()],
    databaseHooks: failAccount ? { account: { create: { before: async () => { throw new Error("synthetic internal failure"); } } } } : undefined,
  });
  const sql = {
    async query(text: string, values?: unknown[]) {
      const result = await db.query<Record<string, unknown>>(text, values);
      return { rows: result.rows };
    },
  };
  const invite = async (address = email) => {
    const output = JSON.parse(await invitationCommand(sql, ["create", address]));
    return output as { token: string; id: string };
  };
  const request = (path: string, body?: unknown, cookie?: string, extraHeaders?: Record<string, string>) => new Request(origin + "/api/auth/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const send = (path: string, body?: unknown, cookie?: string, extra?: Record<string, string>) =>
    handleAuthRequest(request(path, body, cookie, extra), auth);
  const register = (token?: string, address = email) => send("register-invitation", {
    name: "Invited User", email: address, password, invitationToken: token,
  });
  const login = async () => {
    const response = await send("sign-in/email", { email, password });
    assert.equal(response.status, 200, await response.clone().text());
    return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  };
  const count = async (table: "user" | "account" | "session") =>
    Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]!.n);
  return { db, sql, auth, send, register, invite, login, count, ownershipDb };
}

describe("invitation-only authentication (isolated PGlite, not PostgreSQL concurrency proof)", { timeout: 30_000 }, () => {
  it("blocks built-in signup and registration without an invitation", async t => {
    const h = await fixture(t);
    assert.equal((await h.send("sign-up/email", { email, password, name: "Public" })).status, 404);
    assert.equal((await h.auth.handler(new Request(origin + "/api/auth/sign-up/email", {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "Public" }),
    }))).ok, false);
    assert.equal((await h.register()).ok, false);
    assert.equal(await h.count("user"), 0);
  });

  it("registers a valid email-bound invitation and creates one credential account", async t => {
    const h = await fixture(t);
    const invite = await h.invite(" Invited@Example.Test ");
    assert.equal((await h.register(invite.token)).status, 200);
    assert.equal(await h.count("user"), 1);
    assert.equal(await h.count("account"), 1);
    assert.equal(await h.count("session"), 0, "no session may escape before commit");
    const inboxes = await h.db.query<{ owner_id: string }>("SELECT owner_id FROM private_inbox");
    const users = await h.db.query<{ id: string }>('SELECT id FROM "user"');
    assert.deepEqual(inboxes.rows.map(row => row.owner_id), users.rows.map(row => row.id));
    const row = (await h.db.query<{ consumed: boolean }>('SELECT "consumed" FROM "invitation"')).rows[0]!;
    assert.equal(row.consumed, true);
  });

  for (const state of ["invalid", "expired", "revoked", "consumed"]) {
    it(`rejects a ${state} invitation`, async t => {
      const h = await fixture(t);
      const invite = await h.invite();
      if (state === "expired") await h.db.query('UPDATE "invitation" SET "createdAt" = now() - interval \'2 days\', "expiresAt" = now() - interval \'1 day\'');
      if (state === "revoked") await invitationCommand(h.sql, ["revoke", invite.id]);
      if (state === "consumed") await h.db.query('UPDATE "invitation" SET "consumed" = true, "consumedAt" = now()');
      const response = await h.register(state === "invalid" ? "x".repeat(43) : invite.token);
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), { error: "Authentication request failed" });
      assert.equal(await h.count("user"), 0);
    });
  }

  it("rejects mismatched email without consuming the invitation", async t => {
    const h = await fixture(t);
    const invite = await h.invite();
    assert.equal((await h.register(invite.token, "other@example.test")).status, 422);
    assert.equal((await h.register(invite.token)).status, 200);
  });

  it("permits one redemption under concurrent requests (embedded DB only)", async t => {
    const h = await fixture(t);
    const invite = await h.invite();
    const responses = await Promise.all([h.register(invite.token), h.register(invite.token)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 422]);
    assert.equal(await h.count("user"), 1);
    assert.equal(await h.count("account"), 1);
  });

  it("rejects reuse and duplicate accounts with the same generic failure", async t => {
    const h = await fixture(t);
    const first = await h.invite();
    await h.register(first.token);
    const reuse = await h.register(first.token);
    const second = await h.invite();
    const duplicate = await h.register(second.token);
    assert.equal(reuse.status, 422);
    assert.equal(duplicate.status, 422);
    assert.deepEqual(await reuse.json(), await duplicate.json());
    assert.equal(await h.count("user"), 1);
    const row = (await h.db.query<{ consumed: boolean }>('SELECT consumed FROM invitation WHERE id = $1', [second.id])).rows[0]!;
    assert.equal(row.consumed, false, "duplicate account failure rolls back claim");
  });

  it("rolls back both the invitation claim and user when credential creation fails", async t => {
    const h = await fixture(t, true);
    const invite = await h.invite();
    const response = await h.register(invite.token);
    assert.equal(response.status, 422);
    assert.doesNotMatch(await response.text(), /synthetic|internal|password|tokenHash/);
    assert.equal(await h.count("user"), 0);
    assert.equal(await h.count("account"), 0);
    assert.equal((await h.db.query("SELECT id FROM private_inbox")).rows.length, 0);
    const row = (await h.db.query<{ consumed: boolean }>('SELECT consumed FROM invitation')).rows[0]!;
    assert.equal(row.consumed, false);
  });

  it("logs in, verifies a real session, logs out and invalidates the old cookie", async t => {
    const h = await fixture(t);
    await h.register((await h.invite()).token);
    const cookie = await h.login();
    const session = await h.send("get-session", undefined, cookie);
    assert.equal((await session.json()).user.email, email);
    const verified = await verifiedSessionUser(h.auth, new Headers({ cookie }), true);
    assert.equal(verified?.email, email);
    const inbox = await resolvePrivateInbox(h.auth, new Headers({ cookie }), true, h.ownershipDb);
    assert.equal(inbox?.owner_id, verified?.id);
    assert.equal((await h.send("sign-out", {}, cookie)).status, 200);
    assert.equal(await verifiedSessionUser(h.auth, new Headers({ cookie }), true), null);
    assert.equal(await resolvePrivateInbox(h.auth, new Headers({ cookie }), true, h.ownershipDb), null);
  });

  it("returns identical login failures for unknown email and incorrect password", async t => {
    const h = await fixture(t);
    await h.register((await h.invite()).token);
    const incorrect = await h.send("sign-in/email", { email, password: "Incorrect-disposable-password" });
    const unknown = await h.send("sign-in/email", { email: "unknown@example.test", password });
    assert.equal(incorrect.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await incorrect.json(), await unknown.json());
    assert.equal(await h.count("session"), 0);
  });

  for (const state of ["invalid", "expired", "revoked"]) {
    it(`rejects ${state} sessions using authoritative verification`, async t => {
      const h = await fixture(t);
      await h.register((await h.invite()).token);
      let cookie = await h.login();
      if (state === "invalid") cookie = `${AUTH_COOKIES.session_token.name}=forged`;
      if (state === "expired") await h.db.query('UPDATE session SET "expiresAt" = now() - interval \'1 day\'');
      if (state === "revoked") await h.db.query("DELETE FROM session");
      assert.equal(await verifiedSessionUser(h.auth, new Headers({ cookie }), true), null);
      assert.equal(await resolvePrivateInbox(h.auth, new Headers({ cookie }), true, h.ownershipDb), null);
      assert.equal(await (await h.send("get-session", undefined, cookie)).json(), null);
    });
  }

  it("cannot authenticate through development identity or unlock tenant policies", async t => {
    const h = await fixture(t);
    await h.register((await h.invite()).token);
    const cookie = await h.login();
    assert.equal(await verifiedSessionUser(h.auth, new Headers({ cookie }), false), null);
    assert.equal(await verifiedSessionUser(h.auth, new Headers({ "x-user-id": "dev-user" }), true), null);
    assert.equal(requireInboxAccess().allowed, false);
    assert.equal(requireGenericWebhookAccess().allowed, false);
  });

  it("enforces registration rate limits even when forwarded IP headers change", async t => {
    const h = await fixture(t);
    let last!: Response;
    for (let i = 0; i < 11; i++) last = await h.send("register-invitation", {
      email, password, name: "Test", invitationToken: "x".repeat(43),
    }, undefined, { "x-forwarded-for": `192.0.2.${i + 1}` });
    assert.equal(last.status, 429);
    assert.ok(last.headers.has("retry-after"));
    assert.equal(last.headers.get("retry-after"), last.headers.get("x-retry-after"));
    assert.equal(await h.count("user"), 0);
  });

  it("rejects cross-origin registration and oversized requests", async t => {
    const h = await fixture(t);
    const invite = await h.invite();
    assert.equal((await h.send("register-invitation", { email, password, name: "Test", invitationToken: invite.token }, undefined, { origin: "https://other.example" })).ok, false);
    assert.equal((await h.send("register-invitation", { name: "x".repeat(20_000) })).status, 413);
    assert.equal(await h.count("user"), 0);
  });

  it("migrates repeatedly without losing existing identity records", async t => {
    const h = await fixture(t);
    await h.register((await h.invite()).token);
    await applyMigrations(h.db);
    for (const migration of migrations) await h.db.exec(migration.sql);
    assert.equal(await h.count("user"), 1);
    assert.equal(await h.count("account"), 1);
    assert.equal((await h.db.query("SELECT * FROM _migrations")).rows.length, 3);
  });

  it("CLI prints the token only on creation, lists metadata, and revokes", async t => {
    const h = await fixture(t);
    const invite = await h.invite();
    const list = await invitationCommand(h.sql, ["list"]);
    assert.doesNotMatch(list, /tokenHash|token/);
    assert.ok(!list.includes(invite.token));
    assert.equal(newInvitation(email).token.length, 43);
    await invitationCommand(h.sql, ["revoke", invite.id]);
    assert.equal((await h.register(invite.token)).status, 422);
    await assert.rejects(() => invitationCommand(h.sql, ["create", email, "0"]));
    await assert.rejects(() => invitationCommand(h.sql, ["revoke", randomUUID(), "extra"]));
  });
});

describe("authentication error response headers", () => {
  for (const upstream of [
    { "x-retry-after": "60" },
    { "retry-after": "30" },
    { "retry-after": "30", "x-retry-after": "60" },
  ] as Record<string, string>[]) {
    it(`preserves only approved headers from ${Object.keys(upstream).join(" and ")}`, async () => {
      const response = await handleAuthRequest(new Request(origin + "/api/auth/get-session"), {
        handler: async () => new Response("synthetic internal detail", {
          status: 429,
          headers: {
            ...upstream,
            "set-cookie": "synthetic-cookie=private",
            authorization: "synthetic-credential",
            "x-internal-detail": "synthetic internal detail",
          },
        }),
      });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), upstream["retry-after"] ?? upstream["x-retry-after"]);
      assert.equal(response.headers.get("x-retry-after"), upstream["x-retry-after"] ?? null);
      for (const name of ["set-cookie", "authorization", "x-internal-detail"]) {
        assert.equal(response.headers.has(name), false);
      }
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "Authentication request failed" });
    });
  }
});
