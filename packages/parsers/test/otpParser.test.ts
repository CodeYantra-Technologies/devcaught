import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { otpParser } from "../src/otpParser.ts";
import { runParsers } from "../src/runParsers.ts";
import { linkParser } from "../src/linkParser.ts";

describe("otpParser", () => {
  it("detects the NexaField verification example", () => {
    const detections = otpParser.parse({
      subject: "Verify your account",
      textBody:
        "Your verification code is 482913.\nThis code expires in 10 minutes.",
    });
    assert.equal(detections.length, 1);
    assert.equal(detections[0]?.type, "otp");
    assert.equal(detections[0]?.value, "482913");
    assert.ok((detections[0]?.confidence ?? 0) >= 0.9);
    assert.equal(detections[0]?.label, "Expires in 10 minutes");
  });

  it("detects OTP: prefix and 4-digit codes", () => {
    const detections = otpParser.parse({
      textBody: "OTP: 1234",
    });
    assert.equal(detections[0]?.value, "1234");
  });

  it("detects one-time password phrasing", () => {
    const detections = otpParser.parse({
      textBody: "Your one-time password is 908172",
    });
    assert.equal(detections[0]?.value, "908172");
  });

  it("normalizes dashed 6-digit codes", () => {
    const detections = otpParser.parse({
      textBody: "Your login code is 482-913",
    });
    assert.equal(detections[0]?.value, "482913");
  });

  it("reads HTML-only bodies", () => {
    const detections = otpParser.parse({
      htmlBody:
        "<p>Your <b>security code</b> is <span>551029</span>.</p>",
    });
    assert.equal(detections[0]?.value, "551029");
  });

  it("ignores bare numbers without a cue", () => {
    const detections = otpParser.parse({
      subject: "Invoice #4412",
      textBody: "Order 8829101 total 1999 shipped to 2024 Main St. Phone 5551234.",
    });
    assert.equal(detections.length, 0);
  });

  it("does not treat years as OTPs", () => {
    const detections = otpParser.parse({
      textBody: "Your verification code for 2026 is ready.",
    });
    assert.equal(detections.length, 0);
  });

  it("composes with linkParser without dropping the OTP", () => {
    const detections = runParsers(
      {
        textBody:
          "Your verification code is 482913. Confirm at https://example.test/verify",
      },
      [otpParser, linkParser],
    );
    assert.deepEqual(
      detections.map((d) => d.type).sort(),
      ["otp", "url"],
    );
  });
});
