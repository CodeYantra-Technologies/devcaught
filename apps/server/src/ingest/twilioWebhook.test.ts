import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildSignedUrl } from "./twilioWebhook.ts";
import { openInboxStore } from "../store/sqlite.ts";
import { InboxService } from "./inboxService.ts";
import type { DevCaughtRuntime } from "../runtime.ts";
import { createApiApp } from "../http/app.ts";
import { twilioSignature } from "../../../../packages/shared/src/sms/adapters.ts";

function makeRuntime(config: { twilioAuthToken?: string; twilioPublicUrl?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "devcaught-twilio-"));
  const db = path.join(dir, "inbox.db");
  const { store } = openInboxStore(db);
  const inbox = new InboxService(store);
  const runtime = {
    config: {
      host: "127.0.0.1",
      smtpPort: 1025,
      httpPort: 0,
      dbPath: db,
      smtpSizeLimit: 1024 * 1024,
      retentionDays: 0,
      maxMessages: 0,
      twilioAuthToken: config.twilioAuthToken ?? undefined,
      twilioPublicUrl: config.twilioPublicUrl ?? undefined,
    },
    store,
    inbox,
    smtp: {} as any,
    http: { running: false, host: "127.0.0.1", port: 0, error: null },
    dbMode: "memory" as const,
    normalizeTestEmail: () => ({ id: "", ok: true }) as never,
    setHttpStatus() {},
  } as DevCaughtRuntime;
  return { runtime, dir, db, store };
}



async function startServer(runtime: DevCaughtRuntime): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer(createApiApp(runtime));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("Twilio webhook endpoint — form", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const authToken = "sk_test_123";
    const body = "From=123&To=456&Body=hello&MessageSid=SM123";
    const params = { From: "123", To: "456", Body: "hello", MessageSid: "SM123" };
    const signature = twilioSignature(authToken, "https://mycompany.com/webhooks/twilio", params);
    const response = await fetch(base + "/webhooks/twilio", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body,
    });
    assert.equal(response.status, 200);
    const { id } = (await response.json()) as { id: string };
    assert.equal(store.get(id)?.type, "sms");
    assert.equal(store.get(id)?.sms?.provider, "twilio");
    assert.equal(store.get(id)?.sms?.kind, "inbound");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — valid JSON (bodySHA256 + URL signature)", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = JSON.stringify({ From: "123", To: "456", Body: "hello", MessageSid: "SM789" });
    const bodyHash = sha256Hex(body);
    const url = "https://mycompany.com/webhooks/twilio?bodySHA256=" + bodyHash;
    const signature = twilioSignature("sk_test_123", url, {});
    const response = await fetch(base + "/webhooks/twilio?bodySHA256=" + bodyHash, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": signature,
      },
      body,
    });
    assert.equal(response.status, 200);
    const { id } = (await response.json()) as { id: string };
    assert.equal(store.get(id)?.type, "sms");
    assert.equal(store.get(id)?.sms?.provider, "twilio");
    assert.equal(store.get(id)?.sms?.kind, "inbound");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — tampered JSON (signature still invalid)", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = JSON.stringify({ From: "123", To: "456", Body: "hello", MessageSid: "SM001" });
    const bodyHash = sha256Hex(body);
    const url = "https://mycompany.com/webhooks/twilio?bodySHA256=" + bodyHash;
    const signature = twilioSignature("sk_test_123", url, {});
    const tampered = JSON.stringify({ From: "999", To: "456", Body: "hello", MessageSid: "SM001" });
    const response = await fetch(base + `/webhooks/twilio?bodySHA256=${bodyHash}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": signature,
      },
      body: tampered,
    });
    assert.equal(response.status, 403);
    assert.equal(store.count(), 0, "no persistence on body tampering");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — changed public URL changes signature result", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = JSON.stringify({ From: "123", To: "456", Body: "hello", MessageSid: "SM002" });
    const bodyHash = sha256Hex(body);
    const url = "https://mycompany.com/webhooks/twilio?bodySHA256=" + bodyHash;
    const signature = twilioSignature("sk_test_123", url, {});
    const response = await fetch(base + `/webhooks/twilio?bodySHA256=${bodyHash}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": signature,
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(store.count(), 1);

    // Retry with a mismatch between configured URL and request URL.
    const wrongUrl = "https://evil.example.org/webhooks/twilio?bodySHA256=" + bodyHash;
    const wrongSig = twilioSignature("sk_test_123", wrongUrl, {});
    const response2 = await fetch(base + `/webhooks/twilio?bodySHA256=${bodyHash}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": wrongSig,
      },
      body,
    });
    assert.equal(response2.status, 403);
    assert.equal(store.count(), 1, "no duplicate on public URL mismatch");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — missing signature rejected", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = "From=123&To=456&Body=hello&MessageSid=SM999";
    const response = await fetch(base + "/webhooks/twilio", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    assert.equal(response.status, 403);
    assert.equal(store.count(), 0, "no persistence without signature");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — invalid signature rejected", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = "From=123&To=456&Body=hello&MessageSid=SM004";
    const response = await fetch(base + "/webhooks/twilio", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "wrongsignature",
      },
      body,
    });
    assert.equal(response.status, 403);
    assert.equal(store.count(), 0, "no persistence on invalid signature");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — missing credentials fail-closed", async () => {
  const { runtime, dir, store } = makeRuntime({});
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = "From=123&To=456&Body=hello&MessageSid=SM005";
    const response = await fetch(base + "/webhooks/twilio", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "signature",
      },
      body,
    });
    assert.equal(response.status, 403, "no route when no configured credential");
    assert.equal(store.count(), 0, "no persistence without credentials");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — partial config fail-closed (token only)", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: undefined,
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = "From=123&To=456&Body=hello&MessageSid=SM006";
    const response = await fetch(base + "/webhooks/twilio", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "signature",
      },
      body,
    });
    assert.equal(response.status, 403, "no route when no public URL");
    assert.equal(store.count(), 0, "no persistence without public URL");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — malformed JSON rejected", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = "not json";
    const response = await fetch(base + "/webhooks/twilio", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": "signature",
      },
      body,
    });
    assert.equal(response.status, 403, "malformed JSON must be rejected");
    assert.equal(store.count(), 0, "no persistence on malformed payload");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — body tampering rejected", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = JSON.stringify({ From: "123", To: "456", Body: "original", MessageSid: "SM008" });
    const bodyHash = sha256Hex(body);
    const url = "https://mycompany.com/webhooks/twilio?bodySHA256=" + bodyHash;
    const signature = twilioSignature("sk_test_123", url, {});
    const tampered = JSON.stringify({ From: "123", To: "456", Body: "tampered", MessageSid: "SM008" });
    const response = await fetch(base + `/webhooks/twilio?bodySHA256=${bodyHash}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": signature,
      },
      body: tampered,
    });
    assert.equal(response.status, 403);
    assert.equal(store.count(), 0, "no persistence on body tampering");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Twilio webhook endpoint — duplicate event collapses via dedupeKey", async () => {
  const { runtime, dir, store } = makeRuntime({
    twilioAuthToken: "sk_test_123",
    twilioPublicUrl: "https://mycompany.com/webhooks/twilio",
  });
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const event = { From: "123", To: "456", Body: "dup", MessageSid: "SM009" };
    const body = JSON.stringify(event);
    const bodyHash = sha256Hex(body);
    const url = "https://mycompany.com/webhooks/twilio?bodySHA256=" + bodyHash;
    const signature = twilioSignature("sk_test_123", url, {});
    const response = await fetch(base + `/webhooks/twilio?bodySHA256=${bodyHash}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": signature,
      },
      body,
    });
    assert.equal(response.status, 200);
    const { id } = (await response.json()) as { id: string };
    const firstEventId = id;
    assert.equal(store.get(id)?.sms?.messageSid, "SM009");
    assert.equal(store.count(), 1);

    // Same messageSid with a different body — collapses.
    const body2 = JSON.stringify({ From: "123", To: "456", Body: "dup again", MessageSid: "SM009" });
    const bodyHash2 = sha256Hex(body2);
    const url2 = "https://mycompany.com/webhooks/twilio?bodySHA256=" + bodyHash2;
    const signature2 = twilioSignature("sk_test_123", url2, {});
    const response2 = await fetch(base + `/webhooks/twilio?bodySHA256=${bodyHash2}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-signature": signature2,
      },
      body: body2,
    });
    assert.equal(response2.status, 200);
    const { id: id2 } = (await response2.json()) as { id: string };
    assert.equal(id2, firstEventId, "duplicate collapsed via dedupeKey");
    assert.equal(store.count(), 1, "deduped to a single row");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generic /webhooks rejects unauthenticated requests", async () => {
  const { runtime, dir, store } = makeRuntime({});
  const { server, port } = await startServer(runtime);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = '{"type":"order.created","data":{"order_id":"ord_77"}}';
    const response = await fetch(base + "/webhooks/checkout?mode=test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-signature": "signature",
      },
      body,
    });
    assert.equal(response.status, 401);
    assert.equal(store.count(), 0, "Unauthorized webhook must not be stored");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildSignedUrl — query contract", () => {
  it("returns the configured URL unchanged when the request has no query", () => {
    assert.equal(buildSignedUrl("https://mycompany.com/webhooks/twilio", ""), "https://mycompany.com/webhooks/twilio");
  });

  it("joins the configured URL with the incoming query exactly once", () => {
    assert.equal(
      buildSignedUrl("https://mycompany.com/webhooks/twilio", "bodySHA256=abc123"),
      "https://mycompany.com/webhooks/twilio?bodySHA256=abc123",
    );
  });

  it("does not duplicate static query parameters that the incoming query already carries", () => {
    const merged = buildSignedUrl(
      "https://mycompany.com/webhooks/twilio?bodySHA256=statichash",
      "bodySHA256=statichash",
    );
    assert.equal(merged, "https://mycompany.com/webhooks/twilio?bodySHA256=statichash");
    assert.equal((merged as string).split("bodySHA256=").length - 1, 1);
  });

  it("never re-encodes, reorders, or decodes query parameters", () => {
    const url = buildSignedUrl("https://mycompany.com/webhooks/twilio", "foo=bar&baz=qux%20!");
    // buildSignedUrl passes the query through verbatim: no re-encoding,
    // no reordering, no decoding.
    assert.equal(url, "https://mycompany.com/webhooks/twilio?foo=bar&baz=qux%20!");
  });
});

describe("Twilio webhook — delivery-status (Message Status) payload", () => {
  function dlrBody(status: string, errorCode: string): string {
    return JSON.stringify({ MessageSid: "SM456", MessageStatus: status, From: "123", To: "456", Body: "hello", ErrorCode: errorCode });
  }

  test("accepts a delivery-status payload and persists a delivery_status event", async () => {
    const { runtime, dir, store } = makeRuntime({ twilioAuthToken: "sk_test_123", twilioPublicUrl: "https://mycompany.com/webhooks/twilio" });
    const { server, port } = await startServer(runtime);
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = dlrBody("delivered", "0");
      const bodyHash = sha256Hex(body);
      const url = `https://mycompany.com/webhooks/twilio?bodySHA256=${bodyHash}`;
      const signature = twilioSignature("sk_test_123", url, {});
      const response = await fetch(base + "/webhooks/twilio?bodySHA256=" + bodyHash, {
        method: "POST",
        headers: { "content-type": "application/json", "x-twilio-signature": signature },
        body,
      });
      assert.equal(response.status, 200);
      const { id } = (await response.json()) as { id: string };
      assert.equal(store.get(id)?.type, "sms");
      assert.equal(store.get(id)?.sms?.provider, "twilio");
      assert.equal(store.get(id)?.sms?.kind, "delivery_status");
      assert.equal(store.get(id)?.sms?.messageSid, "SM456");
      assert.equal(store.get(id)?.sms?.status, "delivered");
      assert.equal(store.get(id)?.sms?.errorCode, "0");
      assert.equal(store.get(id)?.sms?.body, "hello");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a delivery-status payload with a non-zero error code", async () => {
    const { runtime, dir, store } = makeRuntime({ twilioAuthToken: "sk_test_123", twilioPublicUrl: "https://mycompany.com/webhooks/twilio" });
    const { server, port } = await startServer(runtime);
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = dlrBody("failed", "22");
      const bodyHash = sha256Hex(body);
      const url = `https://mycompany.com/webhooks/twilio?bodySHA256=${bodyHash}`;
      const signature = twilioSignature("sk_test_123", url, {});
      const response = await fetch(base + "/webhooks/twilio?bodySHA256=" + bodyHash, {
        method: "POST",
        headers: { "content-type": "application/json", "x-twilio-signature": signature },
        body,
      });
      assert.equal(response.status, 200);
      const { id } = (await response.json()) as { id: string };
      assert.equal(store.get(id)?.sms?.kind, "delivery_status");
      assert.equal(store.get(id)?.sms?.status, "failed");
      assert.equal(store.get(id)?.sms?.errorCode, "22");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("received status callback without Body is parsed as delivery_status", async () => {
    const { runtime, dir, store } = makeRuntime({ twilioAuthToken: "sk_test_123", twilioPublicUrl: "https://mycompany.com/webhooks/twilio" });
    const { server, port } = await startServer(runtime);
    const base = `http://127.0.0.1:${port}`;
    try {
      // A "received" carrier callback without a body is a delivery-status
      // update, not an inbox message: it must not be forced through
      // parseTwilioInbound (which requires From/To/Body).
      const body = JSON.stringify({ MessageSid: "SM999", MessageStatus: "received", From: "123", To: "456" });
      const bodyHash = sha256Hex(body);
      const url = `https://mycompany.com/webhooks/twilio?bodySHA256=${bodyHash}`;
      const signature = twilioSignature("sk_test_123", url, {});
      const response = await fetch(base + "/webhooks/twilio?bodySHA256=" + bodyHash, {
        method: "POST",
        headers: { "content-type": "application/json", "x-twilio-signature": signature },
        body,
      });
      assert.equal(response.status, 200, "received status without body must be accepted");
      const { id } = (await response.json()) as { id: string };
      assert.equal(store.get(id)?.type, "sms");
      assert.equal(store.get(id)?.sms?.kind, "delivery_status");
      assert.equal(store.get(id)?.sms?.messageSid, "SM999");
      assert.equal(store.get(id)?.sms?.status, "received");
      assert.equal(store.get(id)?.sms?.body, "");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("normal inbound payload with Body is still parsed as inbound", async () => {
    const { runtime, dir, store } = makeRuntime({ twilioAuthToken: "sk_test_123", twilioPublicUrl: "https://mycompany.com/webhooks/twilio" });
    const { server, port } = await startServer(runtime);
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = JSON.stringify({ From: "123", To: "456", Body: "hello", MessageSid: "SM789" });
      const bodyHash = sha256Hex(body);
      const url = `https://mycompany.com/webhooks/twilio?bodySHA256=${bodyHash}`;
      const signature = twilioSignature("sk_test_123", url, {});
      const response = await fetch(base + "/webhooks/twilio?bodySHA256=" + bodyHash, {
        method: "POST",
        headers: { "content-type": "application/json", "x-twilio-signature": signature },
        body,
      });
      assert.equal(response.status, 200);
      const { id } = (await response.json()) as { id: string };
      assert.equal(store.get(id)?.type, "sms");
      assert.equal(store.get(id)?.sms?.kind, "inbound");
      assert.equal(store.get(id)?.sms?.messageSid, "SM789");
      assert.equal(store.get(id)?.sms?.body, "hello");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Twilio webhook — malformed JSON with a valid signature", () => {
  test("returns 400 and persists nothing", async () => {
    const { runtime, dir, store } = makeRuntime({ twilioAuthToken: "sk_test_123", twilioPublicUrl: "https://mycompany.com/webhooks/twilio" });
    const { server, port } = await startServer(runtime);
    const base = `http://127.0.0.1:${port}`;
    try {
      // Authenticated: bodySHA256 and URL signature are both valid for "not json".
      const body = "not json";
      const bodyHash = sha256Hex(body);
      const url = `https://mycompany.com/webhooks/twilio?bodySHA256=${bodyHash}`;
      const signature = twilioSignature("sk_test_123", url, {});
      const response = await fetch(base + "/webhooks/twilio?bodySHA256=" + bodyHash, {
        method: "POST",
        headers: { "content-type": "application/json", "x-twilio-signature": signature },
        body,
      });
      assert.equal(response.status, 400, "malformed JSON must be rejected with 400");
      assert.equal(store.count(), 0, "no persistence on malformed payload");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Twilio webhook — rejected requests persist nothing", () => {
  test("missing/partial configuration (fail-closed)", async () => {
    const { runtime, dir, store } = makeRuntime({ twilioAuthToken: "sk_test_123", twilioPublicUrl: undefined });
    const { server, port } = await startServer(runtime);
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = "From=123&To=456&Body=hello&MessageSid=SM007";
      const response = await fetch(base + "/webhooks/twilio", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      assert.equal(response.status, 403);
      assert.equal(store.count(), 0, "no persistence without public URL");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bad authentication (invalid signature) persists nothing", async () => {
    const { runtime, dir, store } = makeRuntime({ twilioAuthToken: "sk_test_123", twilioPublicUrl: "https://mycompany.com/webhooks/twilio" });
    const { server, port } = await startServer(runtime);
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = "From=123&To=456&Body=hello&MessageSid=SM004";
      const response = await fetch(base + "/webhooks/twilio", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "wrongsignature" },
        body,
      });
      assert.equal(response.status, 403);
      assert.equal(store.count(), 0, "no persistence on invalid signature");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON (even with a valid signature) persists nothing", async () => {
    const { runtime, dir, store } = makeRuntime({ twilioAuthToken: "sk_test_123", twilioPublicUrl: "https://mycompany.com/webhooks/twilio" });
    const { server, port } = await startServer(runtime);
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = "not json";
      const bodyHash = sha256Hex(body);
      const url = `https://mycompany.com/webhooks/twilio?bodySHA256=${bodyHash}`;
      const signature = twilioSignature("sk_test_123", url, {});
      const response = await fetch(base + "/webhooks/twilio?bodySHA256=" + bodyHash, {
        method: "POST",
        headers: { "content-type": "application/json", "x-twilio-signature": signature },
        body,
      });
      assert.equal(response.status, 400, "malformed JSON must be rejected with 400");
      assert.equal(store.count(), 0, "no persistence on malformed payload");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
