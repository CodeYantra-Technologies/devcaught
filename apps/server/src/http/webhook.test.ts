import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiApp } from "./app.ts";
import { openInboxStore } from "../store/sqlite.ts";
import { InboxService } from "../ingest/inboxService.ts";
import type { DevCaughtRuntime } from "../runtime.ts";
import { captureWebhook } from "./webhookRequest.ts";
import { normalizeWebhook, redactHeaders } from "../ingest/normalizeWebhook.ts";
import type { WebhookRequest } from "../../../../packages/shared/src/types.ts";

test("unauthenticated webhook and inbox operations are denied through real HTTP", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devcaught-webhook-denied-"));
  const { store } = openInboxStore(path.join(dir, "inbox.db"));
  const runtime = { store, inbox: new InboxService(store) } as DevCaughtRuntime;
  const server = createServer(createApiApp(runtime));

  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const body = JSON.stringify({
      type: "order.created",
      data: { order_id: "ord_42" },
    });

    for (const endpoint of ["/webhooks", "/webhooks/checkout?mode=test"]) {
      const response = await fetch(base + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 401);
    }

    const inbox = await fetch(base + "/messages");
    assert.equal(inbox.status, 401);

    const raw = await fetch(base + "/messages/example-id/raw");
    assert.equal(raw.status, 401);

    const deletion = await fetch(base + "/messages/example-id", {
      method: "DELETE",
    });
    assert.equal(deletion.status, 401);

    assert.equal(store.count(), 0, "Unauthorized operations must not persist data");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const syntheticSecretHeaders = {
  Cookie: "session=synth_cookie_value",
  Authorization: "Bearer synth_auth_value",
  "Proxy-Authorization": "Bearer synth_proxy_value",
  "X-Api-Key": "synth_api_key_value",
  "X-Api-Token": "synth_api_token_value",
  "X-Csrf-Token": "synth_csrf_value",
};

const ordinaryHeaders = {
  "User-Agent": "DevCaught-Test-Agent",
  "content-type": "application/json",
};

function assertHeaderRedacted(headers: Record<string, string>, name: string): void {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  assert.ok(key !== undefined, `secret header "${name}" not found in stored headers`);
  assert.equal(headers[key!], "[REDACTED]", `header "${name}" was not redacted`);
}

async function postWithSecrets(base: string, endpoint: string, body: string): Promise<Response> {
  const headers = { ...syntheticSecretHeaders, "User-Agent": "DevCaught-Test-Agent" };
  return fetch(base + endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

test("redactHeaders redacts mixed-case sensitive header names without mutating the caller's input", () => {
  const input = {
    Cookie: "session=synth_cookie_value",
    AUTHORIZATION: "Bearer synth_auth_value",
    "Proxy-Authorization": "Bearer synth_proxy_value",
    "X-Api-Key": "synth_api_key_value",
    "X-Api-Token": "synth_api_token_value",
    "X-Csrf-Token": "synth_csrf_value",
    "User-Agent": "DevCaught-Test-Agent",
    "content-type": "application/json",
  };
  const actual = redactHeaders(input);
  assert.equal(actual["Cookie"], "[REDACTED]");
  assert.equal(actual["AUTHORIZATION"], "[REDACTED]");
  assert.equal(actual["Proxy-Authorization"], "[REDACTED]");
  assert.equal(actual["X-Api-Key"], "[REDACTED]");
  assert.equal(actual["X-Api-Token"], "[REDACTED]");
  assert.equal(actual["X-Csrf-Token"], "[REDACTED]");
  assert.equal(actual["User-Agent"], "DevCaught-Test-Agent");
  assert.equal(actual["content-type"], "application/json");
  // Caller's object must be unchanged.
  assert.equal(input["Cookie"], "session=synth_cookie_value");
  assert.equal(input["User-Agent"], "DevCaught-Test-Agent");
});

test("normalizeWebhook redacts sensitive headers before serialization and storage", () => {
  const request: WebhookRequest = {
    method: "POST",
    url: "/api/webhooks/demo",
    headers: { ...syntheticSecretHeaders, ...ordinaryHeaders },
    body: JSON.stringify({ type: "order.created", data: { order_id: "ord_s4" } }),
  };
  const normalized = normalizeWebhook(request);
  const record = JSON.parse(normalized.rawData) as {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  for (const name of Object.keys(syntheticSecretHeaders)) {
    assertHeaderRedacted(record.headers, name);
  }
  // Ordinary headers and body untouched.
  assert.equal(record.headers["User-Agent"], "DevCaught-Test-Agent");
  assert.equal(record.headers["content-type"], "application/json");
  assert.equal(record.body, JSON.stringify({ type: "order.created", data: { order_id: "ord_s4" } }));
});

//
test("Express rejects unauthenticated webhooks containing sensitive headers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devcaught-webhook-denied-"));
  const { store } = openInboxStore(path.join(dir, "inbox.db"));
  const runtime = { store, inbox: new InboxService(store) } as DevCaughtRuntime;
  const server = createServer(createApiApp(runtime));

  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const base = `http://127.0.0.1:${address.port}`;
    const body = JSON.stringify({ type: "order.created" });

    const response = await postWithSecrets(
      base,
      "/webhooks/checkout?mode=test",
      body,
    );

    assert.equal(response.status, 401);
    assert.equal(store.count(), 0, "Rejected webhook must not be stored");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("sensitive headers are redacted before storage through the dashboard capture path", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devcaught-webhook-s4-dash-"));
  const db = path.join(dir, "inbox.db");
  const { store } = openInboxStore(db);
  const runtime = { store, inbox: new InboxService(store) } as DevCaughtRuntime;
  const previousSlot = (globalThis as Record<string, unknown>).__devcaughtRuntime;
  try {
    (globalThis as Record<string, unknown>).__devcaughtRuntime = { runtime };
    const request = new Request("http://127.0.0.1:8025/api/webhooks/demo", {
      method: "POST",
      headers: {
        ...syntheticSecretHeaders,
        "user-agent": "DevCaught-Test-Agent",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "order.created", data: { order_id: "ord_s4" } }),
    });
    const response = await captureWebhook(request);
    const responseBody = await response.json();
    assert.equal(response.status, 201);
    const { id } = responseBody as { id: string };
    const detail = store.get(id);
    assert.ok(detail, "stored webhook not found");
    for (const name of Object.keys(syntheticSecretHeaders)) {
      assertHeaderRedacted(detail.webhook?.headers ?? {}, name);
    }
    const rawText = store.getRaw(id) ?? "";
    for (const value of Object.values(syntheticSecretHeaders)) {
      assert.ok(!rawText.includes(value), `rawData still exposes a secret header value`);
    }
    assert.ok(rawText.includes("[REDACTED]"));
    assert.ok(detail.webhook, "stored webhook payload not found");
    assert.equal(detail.webhook.headers["user-agent"], "DevCaught-Test-Agent");
    assert.equal(detail.webhook.headers["content-type"], "application/json");
  } finally {
    (globalThis as Record<string, unknown>).__devcaughtRuntime = previousSlot;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
