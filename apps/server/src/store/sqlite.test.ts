import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { InboxService } from "../ingest/inboxService.ts";
import { migrateInboxStore, openInboxStore, type InboxStore } from "./sqlite.ts";

describe("InboxStore", () => {
  it("inserts, lists without raw MIME, and returns raw only on demand", () => {
    const { store } = openInboxStore(":memory:");
    const inbox = new InboxService(store);
    const stored = inbox.ingest({
      type: "email",
      source: "test",
      sender: "Veltrix <noreply@example.test>",
      recipient: "developer@example.test",
      subject: "Verify your account",
      textBody: "Your verification code is 482913.\nThis code expires in 10 minutes.",
      htmlBody: "<p>Your verification code is 482913.</p><script>alert(1)</script>",
      rawData: "RAW-MIME-SECRET",
      createdAt: Date.now(),
    });

    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, stored.id);
    assert.ok(!("rawData" in list[0]!));
    assert.ok(!("htmlBody" in list[0]!));
    assert.equal(list[0]?.detections[0]?.value, "482913");

    const detail = store.get(stored.id);
    assert.ok(detail);
    assert.ok(!("rawData" in detail));
    assert.equal(detail.htmlBody.includes("<script>"), true);
    assert.equal(detail.htmlPreview.includes("<script>"), false);
    assert.equal(store.getRaw(stored.id), "RAW-MIME-SECRET");

    assert.equal(store.delete(stored.id), true);
    assert.equal(store.count(), 0);
    store.close();
  });

  it("searches sender and subject", () => {
    const { store } = openInboxStore(":memory:");
    store.insert({
      type: "email",
      source: "smtp",
      sender: "billing@example.test",
      recipient: "dev@example.test",
      subject: "Receipt",
      textBody: "Thanks",
      htmlBody: "",
      rawData: "raw",
      detections: [],
      createdAt: Date.now(),
    });
    assert.equal(store.list("billing").length, 1);
    assert.equal(store.list("missing").length, 0);
    store.close();
  });
});

describe("SMS storage", () => {
  const LEGACY_SCHEMA = `
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      sender TEXT,
      recipient TEXT,
      subject TEXT,
      text_body TEXT,
      html_body TEXT,
      raw_data TEXT,
      detections TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
  `;

  function smsRow(overrides: Partial<Parameters<InboxStore["insertSms"]>[0]> = {}) {
    return {
      type: "sms" as const,
      source: "http" as const,
      sender: "+14155550123",
      recipient: "+14155550199",
      subject: "Twilio · SMS",
      textBody: "Your code is 482913",
      htmlBody: "",
      rawData: "{}",
      detections: [],
      createdAt: Date.now(),
      dedupeKey: "sms:twilio:in:SM00000000000000000000000000000001",
      ...overrides,
    };
  }

  it("migrates a legacy database (pre-dedupe_key) without losing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "devcaught-migrate-"));
    const dbPath = join(dir, "legacy.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_SCHEMA);
    legacy
      .prepare(
        `INSERT INTO messages
           (id, type, source, sender, recipient, subject, text_body, html_body, raw_data, detections, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-1",
        "email",
        "smtp",
        "a@example.test",
        "b@example.test",
        "Old mail",
        "code 123456",
        "",
        "raw",
        "[]",
        1_000,
      );
    legacy.close();

    const { store } = openInboxStore(dbPath);
    assert.equal(store.count(), 1);
    assert.equal(store.get("legacy-1")?.subject, "Old mail");
    const inserted = store.insertSms(smsRow());
    assert.equal(inserted.duplicate, false);
    assert.equal(store.count(), 2);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps legacy messages unassigned after tenant migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(LEGACY_SCHEMA);
      db.prepare(
        `INSERT INTO messages
         (id, type, source, recipient, detections, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("legacy-unassigned", "email", "smtp", "old@example.test", "[]", 1000);

      migrateInboxStore(db);
      migrateInboxStore(db);

      const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
      assert.ok(columns.some((column) => column.name === "inbox_id"));

      const row = db.prepare(
        "SELECT inbox_id FROM messages WHERE id = ?",
      ).get("legacy-unassigned") as { inbox_id: string | null } | undefined;

      assert.ok(row);
      assert.equal(row.inbox_id, null);
    } finally {
      db.close();
    }
  });

  it("enforces separate legacy and tenant SMS dedupe keys", () => {
    const db = new DatabaseSync(":memory:");

    try {
      migrateInboxStore(db);

      const insert = db.prepare(`
        INSERT INTO messages
          (id, type, source, detections, created_at, dedupe_key, inbox_id)
        VALUES (?, 'sms', 'http', '[]', 1000, ?, ?)
      `);

      insert.run("legacy-1", "shared-key", null);
      assert.throws(() => insert.run("legacy-2", "shared-key", null));

      insert.run("tenant-a-1", "shared-key", "inbox-a");
      assert.throws(() => insert.run("tenant-a-2", "shared-key", "inbox-a"));

      insert.run("tenant-b-1", "shared-key", "inbox-b");
      assert.throws(() => insert.run("tenant-b-2", "shared-key", "inbox-b"));

      migrateInboxStore(db);

      const count = db.prepare(
        "SELECT COUNT(*) AS n FROM messages",
      ).get() as { n: number };

      assert.equal(count.n, 3);
    } finally {
      db.close();
    }
  });

  it("rolls the migration back completely when a step fails", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(LEGACY_SCHEMA);
    db.prepare(
      `INSERT INTO messages (id, type, source, detections, created_at)
       VALUES ('keep', 'email', 'smtp', '[]', 1)`,
    ).run();
    const failing = {
      exec(sql: string) {
        if (sql.includes("idx_messages_dedupe_key")) throw new Error("boom");
        db.exec(sql);
      },
      prepare: (sql: string) => db.prepare(sql),
    } as unknown as DatabaseSync;

    assert.throws(() => migrateInboxStore(failing), /boom/);
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    assert.ok(!columns.some((column) => column.name === "dedupe_key"));
    const rows = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    assert.equal(rows.n, 1);
    db.close();
  });

  it("deduplicates SMS independently across inboxes", () => {
    const { store } = openInboxStore(":memory:");

    try {
      const inboxA = store.forInbox("inbox-a");
      const inboxB = store.forInbox("inbox-b");
      const message = smsRow({ dedupeKey: "shared-provider-key" });

      const firstA = inboxA.insertSms(message);
      const retryA = inboxA.insertSms(message);
      const firstB = inboxB.insertSms(message);
      const retryB = inboxB.insertSms(message);

      assert.equal(firstA.duplicate, false);
      assert.equal(retryA.duplicate, true);
      assert.equal(firstB.duplicate, false);
      assert.equal(retryB.duplicate, true);

      assert.equal(inboxA.count(), 1);
      assert.equal(inboxB.count(), 1);
    } finally {
      store.close();
    }
  });

  it("deduplicates repeated provider events and keeps distinct delivery transitions", () => {
    const { store } = openInboxStore(":memory:");
    const first = store.insertSms(smsRow());
    const retry = store.insertSms(smsRow());
    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.duplicate && retry.id, first.duplicate === false && first.message.id);
    assert.equal(store.count(), 1);

    const delivered = store.insertSms(
      smsRow({ dedupeKey: "sms:twilio:dlr:delivered:SM1", subject: "DLR delivered" }),
    );
    const failed = store.insertSms(
      smsRow({ dedupeKey: "sms:twilio:dlr:failed:SM1", subject: "DLR failed" }),
    );
    assert.equal(delivered.duplicate, false);
    assert.equal(failed.duplicate, false);
    const retriedDelivered = store.insertSms(
      smsRow({ dedupeKey: "sms:twilio:dlr:delivered:SM1", subject: "DLR delivered" }),
    );
    assert.equal(retriedDelivered.duplicate, true);
    assert.equal(store.count(), 3);
    store.close();
  });

  it("never deduplicates simulated events and leaves non-SMS keys null", () => {
    const { store } = openInboxStore(":memory:");
    const a = store.insertSms(smsRow({ dedupeKey: null }));
    const b = store.insertSms(smsRow({ dedupeKey: null }));
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, false);
    assert.equal(store.count(), 2);

    store.insert({
      type: "email",
      source: "smtp",
      sender: "a@example.test",
      recipient: "b@example.test",
      subject: "plain",
      textBody: "hi",
      htmlBody: "",
      rawData: "raw",
      detections: [],
      createdAt: Date.now(),
    });
    assert.equal(store.count(), 3);
    store.close();
  });

  it("surfaces the existing row when a racer bypasses the pre-check and hits the UNIQUE index", () => {
    const dir = mkdtempSync(join(tmpdir(), "devcaught-race-"));
    const dbPath = join(dir, "race.db");
    const { store } = openInboxStore(dbPath);
    const first = store.insertSms(smsRow({ dedupeKey: "race-1" }));
    assert.equal(first.duplicate, false);

    // A concurrent writer that skipped the pre-check and forced the same key:
    // the partial UNIQUE index rejects it at the database level.
    const racer = new DatabaseSync(dbPath);
    racer.exec("PRAGMA busy_timeout = 2000");
    assert.throws(() =>
      racer
        .prepare(
          `INSERT INTO messages
             (id, type, source, sender, recipient, subject, text_body, html_body, raw_data, detections, created_at, dedupe_key)
           VALUES (?, 'sms', 'http', '', '', '', '', '', '{}', '[]', ?, ?)`,
        )
        .run("racer", Date.now(), "race-1"),
    );
    racer.close();

    // A later legitimate insert with the same key still returns the original,
    // never an error.
    const again = store.insertSms(smsRow({ dedupeKey: "race-1" }));
    assert.equal(again.duplicate, true);
    assert.equal(again.duplicate && again.id, first.duplicate === false && first.message.id);
    assert.equal(store.count(), 1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes the normalized masked SMS view in list, search and detail", () => {
    const { store } = openInboxStore(":memory:");
    const event = {
      provider: "twilio" as const,
      kind: "inbound" as const,
      messageSid: "SM00000000000000000000000000000001",
      from: "+*******0123",
      to: "+*******0199",
      body: "Your code is 482913",
      receivedAt: 1_700_000_000_000,
      verification: "valid" as const,
    };
    const inserted = store.insertSms(smsRow({ rawData: JSON.stringify({ sms: event, request: {} }) }));
    if (inserted.duplicate) throw new Error("unexpected duplicate");
    const detail = store.get(inserted.message.id);
    assert.equal(detail?.type, "sms");
    assert.equal(detail?.sms?.messageSid, "SM00000000000000000000000000000001");
    assert.equal(detail?.sms?.verification, "valid");
    assert.deepEqual(detail?.sms, event);
    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0]?.sms, event);
    const searched = store.list("Twilio");
    assert.equal(searched.length, 1);
    assert.deepEqual(searched[0]?.sms, event);
    assert.ok(!("rawData" in listed[0]!));
    assert.ok(!("raw_data" in listed[0]!));
    store.close();
  });

  it("pruneExpired deletes strictly older than the cutoff and keeps the boundary", () => {
    const { store } = openInboxStore(":memory:");
    const now = 1_700_000_000_000;
    const day = 86_400_000;
    store.insert(smsRow({ dedupeKey: "old", createdAt: now - 10 * day }));
    const boundary = store.insert(smsRow({ dedupeKey: "boundary", createdAt: now - 7 * day }));
    store.insert(smsRow({ dedupeKey: "fresh", createdAt: now }));

    assert.equal(store.pruneExpired(now, 7), 1);
    assert.equal(store.count(), 2);
    assert.ok(store.get(boundary.id));
    store.close();
  });

  it("pruneOverMax keeps the newest N and no-ops at exactly N", () => {
    const { store } = openInboxStore(":memory:");
    const now = 1_700_000_000_000;
    store.insert(smsRow({ dedupeKey: "a", createdAt: now - 3 }));
    store.insert(smsRow({ dedupeKey: "b", createdAt: now - 2 }));
    const newest = store.insert(smsRow({ dedupeKey: "c", createdAt: now - 1 }));

    assert.equal(store.pruneOverMax(2), 1);
    assert.equal(store.count(), 2);
    assert.ok(store.get(newest.id));
    assert.equal(store.pruneOverMax(2), 0);
    store.close();
  });

  it("retention disabled (0) or invalid deletes nothing", () => {
    const { store } = openInboxStore(":memory:");
    store.insert(smsRow({ dedupeKey: "old", createdAt: 1 }));
    store.insert(smsRow({ dedupeKey: "b", createdAt: 1_700_000_000_000 }));
    assert.equal(store.pruneExpired(1_700_000_000_000, 0), 0);
    assert.equal(store.pruneOverMax(0), 0);
    assert.equal(store.pruneExpired(1_700_000_000_000, -1), 0);
    assert.equal(store.pruneOverMax(-5), 0);
    assert.equal(store.count(), 2);
    store.close();
  });

  it("InboxService prunes after ingest when opted in, and never when disabled", () => {
    const { store } = openInboxStore(":memory:");
    const now = 1_700_000_000_000;
    const capped = new InboxService(store, { maxMessages: 2 });
    capped.ingest(emailAt(now - 2));
    capped.ingest(emailAt(now - 1));
    capped.ingest(emailAt(now));
    assert.equal(store.count(), 2);
    store.close();

    const { store: plainStore } = openInboxStore(":memory:");
    const plain = new InboxService(plainStore);
    plain.ingest(emailAt(now - 2));
    plain.ingest(emailAt(now - 1));
    plain.ingest(emailAt(now));
    assert.equal(plainStore.count(), 3);
    plainStore.close();
  });

  it("InboxService.ingestSms deduplicates retries through the service", () => {
    const { store } = openInboxStore(":memory:");
    const inbox = new InboxService(store);
    const first = inbox.ingestSms(
      {
        type: "sms",
        source: "http",
        sender: "+14155550123",
        recipient: "+14155550199",
        subject: "Twilio · SMS",
        textBody: "Your verification code is 482913",
        htmlBody: "",
        rawData: "{}",
        createdAt: Date.now(),
      },
      "sms:twilio:in:SM00000000000000000000000000000001",
    );
    const retry = inbox.ingestSms(
      {
        type: "sms",
        source: "http",
        sender: "+14155550123",
        recipient: "+14155550199",
        subject: "Twilio · SMS",
        textBody: "Your verification code is 482913",
        htmlBody: "",
        rawData: "{}",
        createdAt: Date.now(),
      },
      "sms:twilio:in:SM00000000000000000000000000000001",
    );
    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    if (!first.duplicate) {
      assert.equal(store.get(first.message.id)?.detections[0]?.value, "482913");
    }
    store.close();
  });
});

function emailAt(createdAt: number) {
  return {
    type: "email" as const,
    source: "smtp" as const,
    sender: "a@example.test",
    recipient: "b@example.test",
    subject: "m",
    textBody: "hi",
    htmlBody: "",
    rawData: "raw",
    createdAt,
  };
}


describe("Tenant inbox isolation", () => {
  it("keeps retention cleanup inside its own inbox", () => {
    const { store } = openInboxStore(":memory:");

    try {
      const inboxA = store.forInbox("inbox-a");
      const inboxB = store.forInbox("inbox-b");
      const day = 86_400_000;
      const now = 10 * day;

      const add = (
        inbox: typeof inboxA,
        subject: string,
        createdAt: number,
      ) => inbox.insert({
        type: "email",
        source: "smtp",
        sender: "sender@example.test",
        recipient: "recipient@example.test",
        subject,
        textBody: subject,
        htmlBody: "",
        rawData: subject,
        detections: [],
        createdAt,
      });

      add(inboxA, "A expired", now - 3 * day);
      add(inboxA, "A recent", now);
      add(inboxB, "B expired", now - 3 * day);
      add(inboxB, "B recent", now);

      assert.equal(inboxA.pruneExpired(now, 2), 1);
      assert.equal(inboxA.count(), 1);
      assert.equal(inboxB.count(), 2);

      add(inboxA, "A newest", now + 1);
      add(inboxB, "B newest", now + 2);

      assert.equal(inboxA.pruneOverMax(1), 1);
      assert.equal(inboxA.count(), 1);
      assert.equal(inboxA.list()[0]?.subject, "A newest");
      assert.equal(inboxB.count(), 3);
    } finally {
      store.close();
    }
  });

  it("prevents cross-inbox search matches", () => {
    const { store } = openInboxStore(":memory:");

    try {
      const inboxA = store.forInbox("inbox-a");
      const inboxB = store.forInbox("inbox-b");

      inboxA.insert({
        type: "email",
        source: "smtp",
        sender: "secret-sender@example.test",
        recipient: "private@example.test",
        subject: "Confidential invoice",
        textBody: "UniqueSecret482913",
        htmlBody: "",
        rawData: "Private raw data",
        detections: [],
        createdAt: Date.now(),
      });

      assert.equal(inboxA.list("UniqueSecret482913").length, 1);
      assert.equal(inboxB.list("UniqueSecret482913").length, 0);
      assert.equal(inboxB.list("Confidential invoice").length, 0);
      assert.equal(inboxB.list("secret-sender").length, 0);
      assert.equal(inboxB.list("private@example.test").length, 0);
    } finally {
      store.close();
    }
  });

  it("isolates inbox listing and clearing", () => {
    const { store } = openInboxStore(":memory:");

    try {
      const inboxA = store.forInbox("inbox-a");
      const inboxB = store.forInbox("inbox-b");

      const makeMessage = (subject: string) => ({
        type: "email" as const,
        source: "smtp" as const,
        sender: "sender@example.test",
        recipient: "recipient@example.test",
        subject,
        textBody: subject,
        htmlBody: "",
        rawData: subject,
        detections: [],
        createdAt: Date.now(),
      });

      inboxA.insert(makeMessage("Inbox A private"));
      inboxB.insert(makeMessage("Inbox B private"));

      assert.deepEqual(
        inboxA.list().map((message) => message.subject),
        ["Inbox A private"],
      );
      assert.deepEqual(
        inboxB.list().map((message) => message.subject),
        ["Inbox B private"],
      );

      assert.equal(inboxB.clear(), 1);
      assert.equal(inboxB.count(), 0);
      assert.equal(inboxA.count(), 1);
      assert.equal(inboxA.list()[0]?.subject, "Inbox A private");
    } finally {
      store.close();
    }
  });

  it("does not expose Inbox A messages through Inbox B", () => {
    const { store } = openInboxStore(":memory:");

    try {
      const inboxA = store.forInbox("inbox-a");
      const inboxB = store.forInbox("inbox-b");

      const message = inboxA.insert({
        type: "email",
        source: "smtp",
        sender: "sender@example.test",
        recipient: "a@example.test",
        subject: "Private message",
        textBody: "Inbox A secret",
        htmlBody: "",
        rawData: "Private raw MIME",
        detections: [],
        createdAt: Date.now(),
      });

      assert.equal(inboxA.get(message.id)?.subject, "Private message");
      assert.equal(inboxB.get(message.id), null);
      assert.equal(inboxB.getRaw(message.id), null);
      assert.equal(inboxB.delete(message.id), false);
      assert.equal(inboxA.count(), 1);
      assert.equal(inboxB.count(), 0);
    } finally {
      store.close();
    }
  });
});
