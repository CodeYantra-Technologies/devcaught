import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmsEvent } from "../../../../../packages/shared/src/types.ts";
import { smsDedupeKey } from "./dedupe.ts";

function event(overrides: Partial<SmsEvent> = {}): SmsEvent {
  return {
    provider: "twilio",
    kind: "inbound",
    messageSid: "SM00000000000000000000000000000001",
    from: "+14155550123",
    to: "+14155550199",
    body: "Your code is 482913",
    receivedAt: 1_700_000_000_000,
    verification: "valid",
    ...overrides,
  };
}

describe("smsDedupeKey", () => {
  it("is stable for a repeated inbound event with the same provider id", () => {
    assert.equal(
      smsDedupeKey(event()),
      smsDedupeKey(event({ receivedAt: 1_700_000_999_000 })),
    );
    assert.equal(smsDedupeKey(event()), "sms:twilio:in:SM00000000000000000000000000000001");
  });

  it("separates different provider message ids", () => {
    assert.notEqual(
      smsDedupeKey(event()),
      smsDedupeKey(event({ messageSid: "SM00000000000000000000000000000002" })),
    );
  });

  it("keeps distinct delivery-status transitions for the same message id", () => {
    const delivered = smsDedupeKey(event({ kind: "delivery_status", status: "delivered" }));
    const failed = smsDedupeKey(event({ kind: "delivery_status", status: "failed" }));
    assert.notEqual(delivered, failed);
    assert.match(delivered!, /^sms:twilio:dlr:delivered:/);
    assert.match(failed!, /^sms:twilio:dlr:failed:/);
  });

  it("collapses a repeated (retried) delivery-status transition", () => {
    const first = smsDedupeKey(event({ kind: "delivery_status", status: "delivered" }));
    const retry = smsDedupeKey(
      event({ kind: "delivery_status", status: "delivered", receivedAt: 1_700_000_500_000 }),
    );
    assert.equal(first, retry);
  });

  it("falls back to a payload fingerprint when the provider omits the id", () => {
    const a = smsDedupeKey(event({ provider: "msg91", messageSid: null }));
    const retry = smsDedupeKey(
      event({ provider: "msg91", messageSid: null, receivedAt: 1_700_000_500_000 }),
    );
    const different = smsDedupeKey(
      event({ provider: "msg91", messageSid: null, body: "Your code is 111111" }),
    );
    assert.equal(a, retry);
    assert.notEqual(a, different);
    assert.match(a!, /^sms:msg91:in:fp:/);
  });

  it("scopes the fallback fingerprint by delivery status too", () => {
    assert.notEqual(
      smsDedupeKey(event({ provider: "msg91", messageSid: null, kind: "delivery_status", status: "delivered" })),
      smsDedupeKey(event({ provider: "msg91", messageSid: null, kind: "delivery_status", status: "failed" })),
    );
  });

  it("never deduplicates simulated events", () => {
    assert.equal(smsDedupeKey(event({ provider: "simulated", verification: "local" })), null);
  });
});
