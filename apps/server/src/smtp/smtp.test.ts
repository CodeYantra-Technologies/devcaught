import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nodemailer from "nodemailer";
import { InboxService } from "../ingest/inboxService.ts";
import { openInboxStore } from "../store/sqlite.ts";
import { startSmtpReceiver } from "./receiver.ts";

describe("SMTP receiver", () => {
  it("captures a Nodemailer message and detects the OTP", async () => {
    const { store } = openInboxStore(":memory:");
    const inbox = new InboxService(store);
    const smtp = await startSmtpReceiver(
      {
        host: "127.0.0.1",
        smtpPort: 0,
        httpPort: 0,
        dbPath: ":memory:",
        smtpSizeLimit: 1024 * 1024,
      },
      inbox,
    );

    assert.equal(smtp.status.running, true);
    assert.ok(smtp.status.port > 0);

    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: smtp.status.port,
      secure: false,
      tls: { rejectUnauthorized: false },
    });

    await transport.sendMail({
      from: "Veltrix <noreply@example.test>",
      to: "developer@example.test",
      subject: "Verify your account",
      text: "Your verification code is 482913.\nThis code expires in 10 minutes.",
    });

    const messages = store.list();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.source, "smtp");
    assert.equal(messages[0]?.subject, "Verify your account");
    assert.equal(messages[0]?.detections[0]?.type, "otp");
    assert.equal(messages[0]?.detections[0]?.value, "482913");
    assert.ok(!("rawData" in messages[0]!));

    const raw = store.getRaw(messages[0]!.id);
    assert.ok(raw && raw.includes("482913"));

    await smtp.close();
    store.close();
  });

  it("rejects messages over the size limit", async () => {
    const { store } = openInboxStore(":memory:");
    const inbox = new InboxService(store);
    const smtp = await startSmtpReceiver(
      {
        host: "127.0.0.1",
        smtpPort: 0,
        httpPort: 0,
        dbPath: ":memory:",
        smtpSizeLimit: 2048,
      },
      inbox,
    );

    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: smtp.status.port,
      secure: false,
      tls: { rejectUnauthorized: false },
    });

    await assert.rejects(
      () =>
        transport.sendMail({
          from: "a@example.test",
          to: "b@example.test",
          subject: "too big",
          text: "x".repeat(8000),
        }),
      /552|size/i,
    );
    assert.equal(store.count(), 0);

    await smtp.close();
    store.close();
  });
});
