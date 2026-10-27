import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeWebhook } from "./normalizeWebhook.ts";

describe("normalizeWebhook sensitive header redaction", () => {
  it("redacts multiple sensitive header names case-insensitively", () => {
    const headers = {
      Authorization: "synthetic-auth-secret",
      "cOoKiE": "synthetic-cookie-secret",
      "Set-Cookie": "synthetic-set-cookie-secret",
      "pRoXy-AuThOrIzAtIoN": "synthetic-proxy-secret",
      "X-API-KEY": "synthetic-api-key-secret",
      "x-Api-Token": "synthetic-api-token-secret",
      "X-Client-Token": "synthetic-client-token-secret",
      "X-Auth-Token": "synthetic-auth-token-secret",
      "X-Access-Token": "synthetic-access-token-secret",
      "X-CSRF-TOKEN": "synthetic-csrf-token-secret",
      "X-CsRfToKeN": "synthetic-csrftoken-secret",
      "Frontend-Token": "synthetic-frontend-token-secret",
    };

    const normalized = normalizeWebhook({
      method: "POST",
      url: "/hooks/example?event=test",
      headers,
      body: "{}",
    });
    const stored = JSON.parse(normalized.rawData) as {
      headers: Record<string, string>;
    };

    for (const key of Object.keys(headers)) {
      assert.equal(stored.headers[key], "[REDACTED]", `${key} should be redacted`);
    }
  });

  it("preserves harmless headers", () => {
    const normalized = normalizeWebhook({
      method: "POST",
      url: "/hooks/example",
      headers: {
        "content-type": "application/json",
        "x-request-id": "synthetic-request-123",
        "user-agent": "SyntheticWebhookTester/1.0",
      },
      body: "{}",
    });
    const stored = JSON.parse(normalized.rawData) as {
      headers: Record<string, string>;
    };

    assert.equal(stored.headers["content-type"], "application/json");
    assert.equal(stored.headers["x-request-id"], "synthetic-request-123");
    assert.equal(stored.headers["user-agent"], "SyntheticWebhookTester/1.0");
  });

  it("does not mutate the caller's headers object", () => {
    const headers = {
      authorization: "synthetic-auth-secret",
      "x-request-id": "synthetic-request-456",
    };
    const original = { ...headers };

    normalizeWebhook({
      method: "POST",
      url: "/hooks/example",
      headers,
      body: "{}",
    });

    assert.deepEqual(headers, original);
  });

  it("does not serialize sensitive header values", () => {
    const secrets = [
      "synthetic-auth-secret",
      "synthetic-cookie-secret",
      "synthetic-api-key-secret",
    ];
    const normalized = normalizeWebhook({
      method: "POST",
      url: "/hooks/example",
      headers: {
        authorization: secrets[0],
        cookie: secrets[1],
        "x-api-key": secrets[2],
        "x-request-id": "synthetic-request-789",
      },
      body: "{}",
    });
    const serialized = JSON.stringify(normalized);

    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
    assert.match(serialized, /\[REDACTED\]/);
  });
});
