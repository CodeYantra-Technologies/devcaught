import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InboxService } from "../ingest/inboxService.ts";
import { openInboxStore } from "./sqlite.ts";

describe("InboxStore", () => {
  it("inserts, lists without raw MIME, and returns raw only on demand", () => {
    const { store } = openInboxStore(":memory:");
    const inbox = new InboxService(store);
    const stored = inbox.ingest({
      type: "email",
      source: "test",
      sender: "NexaField <noreply@example.test>",
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
