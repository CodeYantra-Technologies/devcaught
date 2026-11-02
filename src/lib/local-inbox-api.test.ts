import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkLocalInboxHealth,
  fetchLocalInboxMessage,
  fetchLocalInboxPage,
  LocalInboxApiError,
} from "./local-inbox-api.ts";

test("local inbox client uses only same-origin GET endpoints", async t => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; credentials: RequestCredentials | undefined; cache: RequestCache | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", credentials: init?.credentials, cache: init?.cache });
    if (url.endsWith("/health")) return Response.json({ ok: true, mode: "local-capture" });
    if (url.includes("?")) {
      return Response.json({
        ok: true,
        items: [{ id: "smtp-1", type: "email", source: "smtp", sender: "sender@example.test", recipient: "dev@example.test", subject: "Receipt", createdAt: 1000, hasHtml: true, hasText: true }],
        hasMore: true,
        nextCursor: "next-cursor",
      });
    }
    return Response.json({
      ok: true,
      message: { id: "smtp/1", type: "email", source: "smtp", sender: "sender@example.test", recipient: "dev@example.test", subject: "Receipt", createdAt: 1000, hasHtml: true, hasText: true, textBody: "Plain text only" },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await checkLocalInboxHealth();
  const page = await fetchLocalInboxPage({ limit: 20, query: "receipt & code" });
  const message = await fetchLocalInboxMessage("smtp/1");

  assert.equal(page.items[0]?.id, "smtp-1");
  assert.equal(page.hasMore, true);
  assert.equal(message.textBody, "Plain text only");
  assert.equal(requests.length, 3);
  assert.ok(requests[0]?.url.endsWith("/__devcaught/local-inbox/health"));
  assert.ok(requests[1]?.url.startsWith("/__devcaught/local-inbox/messages?"));
  assert.ok(requests[1]?.url.includes("query=receipt+%26+code"));
  assert.ok(requests[2]?.url.endsWith("/__devcaught/local-inbox/messages/smtp%2F1"));
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.credentials, "same-origin");
    assert.equal(request.cache, "no-store");
    assert.ok(request.url.startsWith("/__devcaught/local-inbox/"));
    assert.ok(!request.url.startsWith("/api/messages"));
  }
});

test("local inbox client reports unavailable and missing responses without exposing server details", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "database secret" }), { status: 503 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(checkLocalInboxHealth(), error => {
    assert.ok(error instanceof LocalInboxApiError);
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /database secret/);
    return true;
  });
});
