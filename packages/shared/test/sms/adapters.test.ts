import assert from "node:assert/strict";
import type { SmsProvider } from "../../src/types.ts";
import { describe, it } from "node:test";
import { detectProvider, parseTwilioInbound, parseTwilioDeliveryStatus, parseMsg91DeliveryReport, parseMsg91Inbound } from "../../src/sms/adapters.ts";
import { maskPhone } from "../../src/sms/phone.ts";
import { smsDedupeKey } from "../../../../apps/server/src/ingest/sms/dedupe.ts";

// Focused provider-detection tests for Phase S1.
// Explicit selection wins; payload-based guessing is only used when a single
// documented provider signal is unambiguous.

function payload(...args: unknown[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) o[String(args[i])] = args[i + 1];
  return o;
}

describe("detectProvider() — explicit selection preferred over guessing", () => {
  it("honours an explicit supported hint", () => {
    assert.equal(detectProvider("twilio" as SmsProvider, null), "twilio");
    assert.equal(detectProvider("msg91" as SmsProvider, null), "msg91");
  });

  it("rejects an unsupported explicit hint", () => {
    assert.equal(detectProvider("grok" as SmsProvider, null), null);
    assert.equal(detectProvider(null, null), null);
  });

  it("guesses Twilio from a documented inbound payload", () => {
    const raw = payload(
      "From", "+12349013030",
      "To", "+18005551212",
      "Body", "Your code is 123456",
    );
    assert.equal(detectProvider(null, raw), "twilio");
  });

  it("guesses MSG91 from a documented delivery-report payload", () => {
    const raw = payload(
      "requestId", "33666c73574c303830353738",
      "status", "1",
      "telNum", "919999999999",
    );
    assert.equal(detectProvider(null, raw), "msg91");
  });

  it("returns null when neither provider matches", () => {
    assert.equal(detectProvider(null, { foo: "bar" }), null);
  });

  it("returns null on payload ambiguity (both providers present)", () => {
    const raw = payload(
      "From", "+123",
      "To", "+456",
      "Body", "hi",
      "requestId", "33666c73574c303830353738",
    );
    assert.equal(detectProvider(null, raw), null);
  });

  it("returns null on a non-object payload", () => {
    assert.equal(detectProvider(null, "just a string"), null);
  });
});

describe("parseTwilioInbound() — validation edge cases", () => {
  const now = 1700000000000;

  it("returns null when a required field is missing", () => {
    assert.equal(parseTwilioInbound(payload("From", "+1415550123"), now), null);
    assert.equal(parseTwilioInbound(payload("To", "+16175550100"), now), null);
    assert.equal(parseTwilioInbound(payload("Body", "hello"), now), null);
  });

  it("handles an invalid (non-string) Body field without inventing a value", () => {
    const raw = payload(
      "From", "+1415550123",
      "To", "+16175550100",
      "Body", 123456,
    );
    const event = parseTwilioInbound(raw, now);
    assert.ok(event);
    assert.equal(event.body, ""); // non-string cannot be text; left empty
  });

  it("accepts an empty SMS body (supported shape)", () => {
    const raw = payload(
      "From", "+1415550123",
      "To", "+16175550100",
      "Body", "",
    );
    const event = parseTwilioInbound(raw, now);
    assert.ok(event);
    assert.equal(event.body, "");
  });

  it("reads optional NumSegments and NumMedia", () => {
    const raw = payload(
      "From", "+1415550123",
      "To", "+16175550100",
      "Body", "hello",
      "MessageSid", "SM000000000000000000000001",
      "NumSegments", "2",
      "NumMedia", 1,
    );
    const event = parseTwilioInbound(raw, now);
    assert.ok(event);
    assert.equal(event.numSegments, 2);
    assert.equal(event.numMedia, 1);
  });

  it("leaves mediaUrls empty (no media URLs are parsed or invented)", () => {
    const raw = payload(
      "From", "+1415550123",
      "To", "+16175550100",
      "Body", "hello",
      "MessageSid", "SM000000000000000000000002",
    );
    const event = parseTwilioInbound(raw, now);
    assert.ok(event);
    assert.ok(Array.isArray(event.mediaUrls));
    assert.equal(event.mediaUrls!.length, 0);
  });
});

describe("parseTwilioDeliveryStatus() — S0 deduplication compatibility", () => {
  const now = 1700000000000;
  const sid = "SM000000000000000000000003";

  it("parses delivered / failed / sent statuses", () => {
    for (const status of ["delivered", "failed", "sent"] as const) {
      const event = parseTwilioDeliveryStatus(
        payload("MessageSid", sid, "MessageStatus", status, "From", "+1415550123", "To", "+16175550100"),
        now,
      )!;
      assert.equal(event.provider, "twilio");
      assert.equal(event.kind, "delivery_status");
      assert.equal(event.messageSid, sid);
      assert.equal(event.status, status);
      assert.equal(event.verification, "unverified");
    }
  });

  it("returns null when MessageSid is missing", () => {
    assert.equal(
      parseTwilioDeliveryStatus(payload("MessageStatus", "delivered", "From", "+1415550123", "To", "+16175550100"), now),
      null,
    );
  });

  it("leaves status null when no status field is supplied", () => {
    const event = parseTwilioDeliveryStatus(
      payload("MessageSid", sid, "From", "+1415550123", "To", "+16175550100"),
      now,
    )!;
    assert.equal(event.status, null);
  });

  it("reads optional ErrorCode on a failed message", () => {
    const event = parseTwilioDeliveryStatus(
      payload(
        "MessageSid", sid,
        "MessageStatus", "failed",
        "ErrorCode", "21614",
        "From", "+1415550123",
        "To", "+16175550100",
      ),
      now,
    )!;
    assert.equal(event.status, "failed");
    assert.equal(event.errorCode, "21614");
  });

  it("keeps distinct delivery-status transitions distinct per S0 dedupe key", () => {
    const delivered = smsDedupeKey(
      parseTwilioDeliveryStatus(
        payload("MessageSid", sid, "MessageStatus", "delivered", "From", "+1415550123", "To", "+16175550100"),
        now,
      )!,
    )!;
    const failed = smsDedupeKey(
      parseTwilioDeliveryStatus(
        payload("MessageSid", sid, "MessageStatus", "failed", "From", "+1415550123", "To", "+16175550100"),
        now,
      )!,
    )!;
    const retry = smsDedupeKey(
      parseTwilioDeliveryStatus(
        payload("MessageSid", sid, "MessageStatus", "delivered", "From", "+1415550123", "To", "+16175550100"),
        now,
      )!,
    )!;
    assert.notEqual(delivered, failed);
    assert.match(delivered, /^sms:twilio:dlr:delivered:/);
    assert.match(failed, /^sms:twilio:dlr:failed:/);
    assert.equal(delivered, retry);
  });
});

describe("parseTwilioInbound() — valid Twilio inbound parsing", () => {
  const now = 1700000000000;

  it("parses a valid Twilio inbound form payload into an SmsEvent", () => {
    const raw = payload(
      "From", "+1415550123",
      "To", "+16175550100",
      "Body", "Your code is 123456",
      "MessageSid", "SM00000000000000000000000",
    );
    const event = parseTwilioInbound(raw, now);

    assert.ok(event);
    assert.equal(event.provider, "twilio");
    assert.equal(event.kind, "inbound");
    assert.equal(event.messageSid, "SM00000000000000000000000");
    assert.equal(event.from, "+******0123");
    assert.equal(event.to, "+*******0100");
    assert.equal(event.body, "Your code is 123456");
    assert.equal(event.verification, "unverified");
    assert.equal(event.status, null);
    assert.equal(event.errorCode, null);
    assert.equal(event.numSegments, null);
    assert.equal(event.numMedia, null);
    assert.ok(Array.isArray(event.mediaUrls));
    assert.equal(event.mediaUrls!.length, 0);
    assert.equal(event.receivedAt, now);
  });
});

// ---- MSG91 delivery-report / inbound edge cases ----

describe("parseMsg91DeliveryReport() — malformed new-webhook must be rejected", () => {
  const now = 1700000000000;

  it("rejects a malformed new-webhook delivery report with no requestId", () => {
    // Malformed: looks like a new-webhook (eventName/status) but lacks the
    // required identity fields (requestId, recipient). Must NOT be accepted as
    // a delivery_status event.
    assert.equal(parseMsg91DeliveryReport({ eventName: "DELIVERED", status: "1" }, now), null);
  });
});

describe("parseMsg91Inbound() — empty or whitespace-only messageId must be unknown", () => {
  const now = 1700000000000;

  it("returns kind='unknown' when messageId is empty or whitespace-only", () => {
    const raw = { messageId: "   ", sender: "+123****7890", recipient: "+0987654321", message: "hi" };
    const result = parseMsg91Inbound(raw, now);
    assert.equal(result.kind, "unknown");
    assert.ok(result.rawData);
  });
});

describe("MSG91 payload compatibility — delivery reports and inbound", () => {
  const now = 1700000000000;

  // 1. Valid MSG91 new-webhook delivery report.
  it("accepts a valid MSG91 new-webhook delivery report", () => {
    const raw = {
      requestId: "33666c73574c303830353738",
      telNum: "919999999999",
      senderId: "12345",
      eventName: "DELIVERED",
      status: "1",
    };
    const event = parseMsg91DeliveryReport(raw, now)!;

    assert.equal(event.provider, "msg91");
    assert.equal(event.kind, "delivery_status");
    assert.equal(event.messageSid, "33666c73574c303830353738");
    assert.equal(event.from, maskPhone("12345"));
    assert.equal(event.to, maskPhone("919999999999"));
    assert.equal(event.body, "");
    assert.equal(event.status, "delivered");
    assert.equal(event.verification, "unverified");
  });

  // 2. Valid legacy v3 JSON delivery report.
  it("accepts a valid MSG91 legacy v3 delivery report", () => {
    const raw = {
      requestId: "33666c73574c303830353738",
      number: "+19999999999",
      senderId: "12345",
      status: "delivered",
      desc: "Delivered",
    };
    const event = parseMsg91DeliveryReport(raw, now)!;

    assert.equal(event.provider, "msg91");
    assert.equal(event.kind, "delivery_status");
    assert.equal(event.messageSid, "33666c73574c303830353738");
    assert.equal(event.from, maskPhone("12345"));
    assert.equal(event.to, maskPhone("+19999999999"));
    assert.equal(event.body, "");
    assert.equal(event.status, "delivered");
    assert.equal(event.verification, "unverified");
  });

  // 3. Valid legacy v2 form-urlencoded delivery report (JSON array in `data`).
  it("accepts a valid MSG91 legacy v2 form-urlencoded delivery report", () => {
    const data = JSON.stringify([
      {
        requestId: "33666c73574c303830353738",
        telNum: "919999999999",
        senderId: "12345",
        status: "1",
        eventName: "DELIVERED",
      },
    ]);
    const raw = `data=${encodeURIComponent(data)}`;
    const event = parseMsg91DeliveryReport(raw, now)!;

    assert.equal(event.provider, "msg91");
    assert.equal(event.kind, "delivery_status");
    assert.equal(event.messageSid, "33666c73574c303830353738");
    assert.equal(event.from, maskPhone("12345"));
    assert.equal(event.to, maskPhone("919999999999"));
    assert.equal(event.status, "delivered");
    assert.equal(event.verification, "unverified");
  });

  // 4. Unknown or malformed delivery payload returns null.
  it("returns null for an unknown or malformed MSG91 delivery payload", () => {
    assert.equal(parseMsg91DeliveryReport({ foo: "bar" }, now), null);
    assert.equal(parseMsg91DeliveryReport({ eventName: "DELIVERED", status: "1" }, now), null);
  });

  // 5. Valid MSG91 inbound JSON normalizes expected fields and masks phones.
  it("accepts a valid MSG91 inbound JSON and masks phone fields", () => {
    const raw = {
      messageId: "mg91-abc123",
      sender: "+1234567890",
      recipient: "+0987654321",
      message: "Hello",
    };
    const result = parseMsg91Inbound(raw, now);

    assert.equal(result.kind, "accepted");
    const event = result.event;
    assert.equal(event.provider, "msg91");
    assert.equal(event.kind, "inbound");
    assert.equal(event.messageSid, "mg91-abc123");
    assert.equal(event.from, maskPhone("+1234567890"));
    assert.equal(event.to, maskPhone("+0987654321"));
    assert.equal(event.body, "Hello");
    assert.equal(event.verification, "unverified");
  });

  // 6. Unsupported inbound payload returns kind="unknown".
  it("returns kind='unknown' for an unsupported MSG91 inbound payload", () => {
    const result = parseMsg91Inbound({ requestId: "33666c73574c303830353738", status: "1" }, now);
    assert.equal(result.kind, "unknown");
    assert.ok(result.rawData);
  });
});
