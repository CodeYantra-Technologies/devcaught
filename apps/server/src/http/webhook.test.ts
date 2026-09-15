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

test("webhooks capture, inspect, search, persist, and delete through real HTTP", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devcaught-webhook-"));
  const db = path.join(dir, "inbox.db");
  let { store } = openInboxStore(db);
  const runtime = { store, inbox: new InboxService(store) } as DevCaughtRuntime;
  const server = createServer(createApiApp(runtime));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: string, endpoint = "/webhooks/checkout?mode=test") =>
    fetch(base + endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-signature": "signature" },
      body,
    });
  try {
    const body = '{ "type": "order.created", "data": {"order_id":"ord_42"} }';
    const response = await post(body);
    assert.equal(response.status, 201);
    const { id } = (await response.json()) as { id: string };
    const detail = store.get(id)!;
    assert.equal(detail.type, "webhook");
    assert.equal(detail.webhook?.body, body);
    assert.equal(detail.webhook?.url, "/webhooks/checkout?mode=test");
    assert.equal(detail.webhook?.headers["x-test-signature"], "signature");
    assert.ok(detail.detections.some((d) => d.type === "order" && d.value === "ord_42"));
    assert.equal(store.list("ord_42").length, 1);
    assert.ok(!("webhook" in store.list()[0]));
    assert.ok(!("rawData" in store.list()[0]));
    assert.equal((await post("{invalid", "/webhooks")).status, 201);
    assert.equal((await post("")).status, 201);
    const before = store.count();
    assert.equal((await post("x".repeat(1024 * 1024 + 1))).status, 413);
    assert.equal(store.count(), before);
    const raw = await fetch(base + `/messages/${id}/raw`);
    assert.equal(JSON.parse(await raw.text()).body, body);
    store.close();
    store = openInboxStore(db).store;
    runtime.store = store;
    assert.equal(store.get(id)?.webhook?.body, body);
    assert.equal((await fetch(base + `/messages/${id}`, { method: "DELETE" })).status, 200);
    assert.equal(store.get(id), null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
