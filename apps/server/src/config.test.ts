import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  assertSupportedNode,
  isSupportedNode,
  loadConfig,
  portInUseMessage,
} from "./config.ts";

describe("node version policy", () => {
  it("accepts current Node 22 LTS and newer majors", () => {
    assert.equal(isSupportedNode("22.13.0"), true);
    assert.equal(isSupportedNode("22.23.2"), true);
    assert.equal(isSupportedNode("24.1.0"), true);
  });

  it("rejects Node 20 and early 22", () => {
    assert.equal(isSupportedNode("20.19.0"), false);
    assert.equal(isSupportedNode("22.12.0"), false);
    assert.throws(() => assertSupportedNode("20.19.0"), /22\.13\.0/);
  });
});

describe("portInUseMessage", () => {
  it("names the occupied service and how to change it", () => {
    const message = portInUseMessage("SMTP", "127.0.0.1", 1025, "DEVCAUGHT_SMTP_PORT");
    assert.match(message, /SMTP server on 127.0.0.1:1025/);
    assert.match(message, /DEVCAUGHT_SMTP_PORT=1026 npm run dev/);
  });
});

describe("retention config", () => {
  afterEach(() => {
    delete process.env.DEVCAUGHT_RETENTION_DAYS;
    delete process.env.DEVCAUGHT_MAX_MESSAGES;
  });

  it("defaults to disabled — existing data is never pruned unasked", () => {
    const config = loadConfig();
    assert.equal(config.retentionDays, 0);
    assert.equal(config.maxMessages, 0);
  });

  it("reads opted-in values", () => {
    process.env.DEVCAUGHT_RETENTION_DAYS = "7";
    process.env.DEVCAUGHT_MAX_MESSAGES = "500";
    const config = loadConfig();
    assert.equal(config.retentionDays, 7);
    assert.equal(config.maxMessages, 500);
  });

  it("treats an empty value as unset", () => {
    process.env.DEVCAUGHT_RETENTION_DAYS = "";
    process.env.DEVCAUGHT_MAX_MESSAGES = "";
    const config = loadConfig();
    assert.equal(config.retentionDays, 0);
    assert.equal(config.maxMessages, 0);
  });

  it("rejects invalid values with the variable named", () => {
    process.env.DEVCAUGHT_RETENTION_DAYS = "-1";
    assert.throws(() => loadConfig(), /DEVCAUGHT_RETENTION_DAYS/);
    delete process.env.DEVCAUGHT_RETENTION_DAYS;
    process.env.DEVCAUGHT_MAX_MESSAGES = "abc";
    assert.throws(() => loadConfig(), /DEVCAUGHT_MAX_MESSAGES/);
    delete process.env.DEVCAUGHT_MAX_MESSAGES;
    process.env.DEVCAUGHT_MAX_MESSAGES = "1.5";
    assert.throws(() => loadConfig(), /DEVCAUGHT_MAX_MESSAGES/);
  });
});

describe("Twilio config", () => {
  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PUBLIC_URL;
  });

  it("has no Twilio values when neither env var is set", () => {
    const config = loadConfig();
    assert.equal(config.twilioAuthToken, undefined);
    assert.equal(config.twilioPublicUrl, undefined);
  });

  it("reads both Twilio values when both are set", () => {
    process.env.TWILIO_AUTH_TOKEN = "sk_test_123";
    process.env.TWILIO_PUBLIC_URL = "https://mycompany.com/webhooks/twilio";
    const config = loadConfig();
    assert.equal(config.twilioAuthToken, "sk_test_123");
    assert.equal(config.twilioPublicUrl, "https://mycompany.com/webhooks/twilio");
  });

  it("preserves the configured path and query of the public URL", () => {
    process.env.TWILIO_PUBLIC_URL =
      "https://mycompany.com/webhooks/twilio?bodySHA256=abcdef&foo=bar";
    const config = loadConfig();
    assert.equal(
      config.twilioPublicUrl,
      "https://mycompany.com/webhooks/twilio?bodySHA256=abcdef&foo=bar",
    );
  });

  it("omits the public URL when it carries embedded credentials", () => {
    process.env.TWILIO_PUBLIC_URL = "https://user:pass@example.com";
    const config = loadConfig();
    assert.equal(config.twilioPublicUrl, undefined);
    assert.equal(config.twilioAuthToken, undefined);
  });

  it("omits the public URL when it is not HTTPS", () => {
    process.env.TWILIO_PUBLIC_URL = "http://mycompany.com/webhooks/twilio";
    const config = loadConfig();
    assert.equal(config.twilioPublicUrl, undefined);
  });

  it("omits the public URL when it has a fragment", () => {
    process.env.TWILIO_PUBLIC_URL = "https://mycompany.com/webhooks/twilio?q=1#frag";
    const config = loadConfig();
    assert.equal(config.twilioPublicUrl, undefined);
  });

  it("partial configuration: only Twilio auth token is set", () => {
    process.env.TWILIO_AUTH_TOKEN = "sk_test_123";
    const config = loadConfig();
    assert.equal(config.twilioAuthToken, "sk_test_123");
    assert.equal(config.twilioPublicUrl, undefined);
  });

  it("partial configuration: only Twilio public URL is set", () => {
    process.env.TWILIO_PUBLIC_URL = "https://mycompany.com/webhooks/twilio";
    const config = loadConfig();
    assert.equal(config.twilioAuthToken, undefined);
    assert.equal(config.twilioPublicUrl, "https://mycompany.com/webhooks/twilio");
  });
});
