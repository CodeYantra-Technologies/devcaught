import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { betterAuth } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { AUTH_COOKIES } from "../auth/auth-config.ts";
import { invitationAuthPolicy, invitationPlugin } from "../auth/invitation-policy.ts";
import { pgliteDialect } from "../auth/pglite-dialect.ts";
import { provisionPrivateInbox, resolvePrivateInbox } from "../auth/private-inbox.ts";
import { openInboxStore, type InboxStore } from "../../../apps/server/src/store/sqlite.ts";
import { createPrivateInboxApi, type PrivateInboxOperation } from "./private-inbox-api.ts";
import { handlePrivateInboxRequest } from "./private-inbox-api.server.ts";
import { PRIVATE_INBOX_POSTGRES_VERIFIED } from "./private-inbox-release.ts";

const origin = "http://localhost:8080";
const password = "Isolated-private-inbox-test-password!";
const operations: PrivateInboxOperation[] = ["list", "detail", "raw", "delete", "clear", "test", "status"];
const migrations = ["0001_auth.sql", "0002_invitations.sql", "0003_private_inboxes.sql"].map(name =>
  readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"),
);

function message(subject: string) {
  return {
    type: "email" as const, source: "test" as const,
    sender: "sender@example.test", recipient: "recipient@example.test",
    subject, textBody: subject, htmlBody: "", rawData: `raw ${subject}`,
    createdAt: Date.now(), detections: [],
  };
}

function request(operation: PrivateInboxOperation, cookie?: string, options: {
  origin?: string | null; site?: string; body?: unknown; headers?: Record<string, string>;
  method?: string; query?: string;
} = {}) {
  const headers = new Headers({ origin, "sec-fetch-site": "same-origin", ...options.headers });
  if (cookie) headers.set("cookie", cookie);
  if (options.origin === null) headers.delete("origin");
  else if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.site !== undefined) headers.set("sec-fetch-site", options.site);
  const method = options.method ?? (operation === "delete" ? "DELETE" : ["clear", "test"].includes(operation) ? "POST" : "GET");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${origin}/api/${operation}${options.query ?? ""}`, {
    method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function fixture(t: TestContext) {
  // Only disposable, in-memory databases; never import runtime auth or configuration.
  const pg = new PGlite();
  const db = new Kysely<unknown>({ dialect: pgliteDialect(() => pg) });
  const { store: root } = openInboxStore(":memory:");
  t.after(async () => { root.close(); await db.destroy(); await pg.close(); });
  for (const sql of migrations) await pg.exec(sql);
  const hash = await hashPassword(password);
  for (const user of ["a", "b"]) {
    await pg.query('INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, false)',
      [`user-${user}`, user, `${user}@example.test`]);
    await pg.query('INSERT INTO account (id, "accountId", "providerId", "userId", password, "updatedAt") VALUES ($1, $2, $3, $2, $4, now())',
      [`credential-${user}`, `user-${user}`, "credential", hash]);
  }
  const a = await provisionPrivateInbox(db, "user-a");
  const b = await provisionPrivateInbox(db, "user-b");
  const aStore = root.forInbox(a.id), bStore = root.forInbox(b.id);
  const aMessage = aStore.insert(message("A private secret"));
  const bMessage = bStore.insert(message("B private secret"));
  const legacy = root.insert(message("Legacy unassigned secret"));
  const auth = betterAuth({
    ...invitationAuthPolicy,
    database: { db, type: "postgres", transaction: true },
    secret: "isolated-private-inbox-signing-material-at-least-32-characters",
    baseURL: origin, trustedOrigins: [origin],
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
      cookies: AUTH_COOKIES,
      ipAddress: { ipAddressHeaders: [] },
    },
    plugins: [invitationPlugin()],
  });
  const cookies: Record<string, string> = {};
  for (const user of ["a", "b"]) {
    const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: `${user}@example.test`, password }),
    }));
    assert.equal(response.status, 200);
    cookies[user] = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  }
  let storeOpens = 0;
  // Any accidental global operation fails the test immediately.
  const scopedOnly = new Proxy(root, {
    get(target, property) {
      if (property === "then") return undefined; // Promise resolution probes thenables.
      assert.equal(property, "forInbox", "API attempted global store access");
      return target.forInbox.bind(target);
    },
  }) as InboxStore;
  const deps = {
    postgresVerified: true,
    resolveInbox: (req: Request) => resolvePrivateInbox(auth, req.headers, true, db, { provisionMissing: false }),
    openStore: async () => { storeOpens++; return scopedOnly; },
  };
  const api = createPrivateInboxApi(deps);
  return { pg, db, root, a, b, aStore, bStore, aMessage, bMessage, legacy, cookies, deps, api, storeOpens: () => storeOpens };
}

test("runtime release gate blocks every operation before auth or database access", async () => {
  assert.equal(PRIVATE_INBOX_POSTGRES_VERIFIED, false);
  for (const operation of operations) {
    const response = await handlePrivateInboxRequest(request(operation), operation, randomUUID());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  const api = createPrivateInboxApi({
    postgresVerified: false,
    resolveInbox: async () => { throw new Error("must not resolve"); },
    openStore: async () => { throw new Error("must not open storage"); },
  });
  assert.equal((await api(request("list"), "list")).status, 503);
});

test("all operations deny absent, forged, expired and revoked real sessions before SQLite access", async t => {
  const h = await fixture(t);
  const forged = `${AUTH_COOKIES.session_token.name}=forged`;
  for (const cookie of [undefined, forged]) {
    for (const operation of operations) {
      assert.equal((await h.api(request(operation, cookie), operation, h.aMessage.id)).status, 401);
    }
  }
  await h.pg.query('UPDATE session SET "expiresAt" = now() - interval \'1 day\' WHERE "userId" = $1', ["user-a"]);
  await h.pg.query('DELETE FROM session WHERE "userId" = $1', ["user-b"]);
  for (const cookie of [h.cookies.a, h.cookies.b]) {
    for (const operation of operations) {
      assert.equal((await h.api(request(operation, cookie), operation, h.aMessage.id)).status, 401);
    }
  }
  assert.equal(h.storeOpens(), 0);
});

test("two users see only their own list/search/detail/raw/status and cannot delete others or legacy rows", async t => {
  const h = await fixture(t);
  for (const [user, own, other] of [["a", h.aMessage, h.bMessage], ["b", h.bMessage, h.aMessage]] as const) {
    const cookie = h.cookies[user];
    const list = await h.api(request("list", cookie, {
      query: `?inboxId=${user === "a" ? h.b.id : h.a.id}`,
      headers: { "x-user-id": user === "a" ? "user-b" : "user-a", "x-inbox-id": h.legacy.id },
    }), "list");
    assert.deepEqual((await list.json()).messages.map((row: { id: string }) => row.id), [own.id]);
    assert.equal(list.headers.get("cache-control"), "private, no-store");
    const search = await h.api(request("list", cookie, { query: `?q=${encodeURIComponent(other.subject!)}` }), "list");
    assert.deepEqual((await search.json()).messages, []);
    assert.equal((await (await h.api(request("detail", cookie), "detail", own.id)).json()).id, own.id);
    const raw = await h.api(request("raw", cookie), "raw", own.id);
    assert.equal(await raw.text(), own.rawData);
    assert.match(raw.headers.get("content-disposition")!, /^attachment;/);
    for (const id of [other.id, h.legacy.id, randomUUID()]) {
      for (const operation of ["detail", "raw", "delete"] as const) {
        const denied = await h.api(request(operation, cookie), operation, id);
        assert.equal(denied.status, 404);
        assert.deepEqual(await denied.json(), { error: "Message not found" });
      }
    }
    const status = await h.api(request("status", cookie), "status");
    assert.deepEqual(await status.json(), { product: "DevCaught", messageCount: 1 });
  }
  assert.equal(h.root.count(), 3);
});

test("test-message ingestion, delete and clear use only the session owner's scoped service/store", async t => {
  const h = await fixture(t);
  const created = await h.api(request("test", h.cookies.a, {
    body: {
      from: "from@example.test", to: "b@example.test", subject: "Still A's message", text: "private",
      inboxId: h.b.id, ownerId: "user-b",
    },
  }), "test");
  assert.equal(created.status, 201);
  const inserted = await created.json();
  assert.ok(h.aStore.get(inserted.id));
  assert.equal(h.bStore.get(inserted.id), null);
  assert.equal(h.bStore.count(), 1);
  assert.equal((await h.api(request("delete", h.cookies.a), "delete", h.aMessage.id)).status, 200);
  const cleared = await h.api(request("clear", h.cookies.a), "clear");
  assert.deepEqual(await cleared.json(), { ok: true, deleted: 1 });
  assert.equal(h.aStore.count(), 0);
  assert.equal(h.bStore.count(), 1);
  assert.ok(h.root.get(h.legacy.id));
  assert.equal((await (await h.api(request("status", h.cookies.a), "status")).json()).messageCount, 0);
});

test("mutations require exact same origin and reject sibling/cross-site metadata", async t => {
  const h = await fixture(t);
  for (const operation of ["delete", "clear", "test"] as const) {
    for (const options of [
      { origin: null }, { origin: "https://evil.example" }, { origin: "http://localhost:8081" },
      { origin: "https://localhost:8080" }, { site: "same-site" }, { site: "cross-site" },
    ]) {
      assert.equal((await h.api(request(operation, h.cookies.a, options), operation, h.aMessage.id)).status, 403);
    }
  }
  assert.equal((await h.api(request("list", h.cookies.a, { site: "same-site" }), "list")).status, 403);
  assert.equal((await h.api(request("clear", h.cookies.a, { method: "GET" }), "clear")).status, 405);
  assert.equal(h.storeOpens(), 0);
  assert.equal(h.aStore.count(), 1);
  assert.equal(h.bStore.count(), 1);
});

test("missing ownership fails closed without lazily provisioning or opening SQLite", async t => {
  const h = await fixture(t);
  await h.pg.query("DELETE FROM private_inbox WHERE owner_id = $1", ["user-a"]);
  for (const operation of operations) {
    assert.equal((await h.api(request(operation, h.cookies.a), operation, h.aMessage.id)).status, 401);
  }
  assert.equal((await h.pg.query("SELECT id FROM private_inbox WHERE owner_id = $1", ["user-a"])).rows.length, 0);
  assert.equal(h.storeOpens(), 0);
});

test("mismatched or malformed ownership results fail closed", async t => {
  const h = await fixture(t);
  for (const fields of [{ owner_id: "user-b" }, { id: "../legacy" }]) {
    const brokenRegistry = h.db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => ({ ...result, rows: result.rows.map(row => ({ ...row, ...fields })) }),
    });
    const api = createPrivateInboxApi({
      ...h.deps,
      resolveInbox: req => resolvePrivateInbox({
        api: { getSession: async input => {
          assert.equal(input.query.disableCookieCache, true);
          return { user: { id: "user-a" } };
        } },
      }, req.headers, true, brokenRegistry, { provisionMissing: false }),
    });
    assert.equal((await api(request("list", h.cookies.a), "list")).status, 503);
  }
  assert.equal(h.storeOpens(), 0);
});

test("PostgreSQL/schema and SQLite failures return generic no-store errors without fallback", async t => {
  const h = await fixture(t);
  await h.pg.exec("ALTER TABLE private_inbox RENAME TO unavailable_registry");
  const unavailable = await h.api(request("list", h.cookies.a), "list");
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "Private inbox unavailable" });
  assert.equal(h.storeOpens(), 0);
  const storageFailure = createPrivateInboxApi({
    ...h.deps, resolveInbox: async () => h.a,
    openStore: async () => { throw new Error("synthetic connection details must stay private"); },
  });
  const response = await storageFailure(request("list", h.cookies.a), "list");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Private inbox unavailable" });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
