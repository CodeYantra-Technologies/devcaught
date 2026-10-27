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

test("unauthenticated HTTP clients cannot list inbox messages", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devcaught-security-"));
  const { store } = openInboxStore(path.join(dir, "inbox.db"));

  const runtime = {
    store,
    inbox: new InboxService(store),
  } as DevCaughtRuntime;

  const server = createServer(createApiApp(runtime));

  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/messages`,
    );

    assert.equal(
      response.status,
      401,
      "Inbox listing must reject unauthenticated requests",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unauthenticated generic webhook cannot insert a message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devcaught-webhook-security-"));
  const { store } = openInboxStore(path.join(dir, "inbox.db"));

  const runtime = {
    store,
    inbox: new InboxService(store),
  } as DevCaughtRuntime;

  const server = createServer(createApiApp(runtime));

  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const base = `http://127.0.0.1:${address.port}`;

    const webhookResponse = await fetch(`${base}/webhooks/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "must-not-be-stored" }),
    });

    assert.equal(webhookResponse.status, 401);

    const inboxResponse = await fetch(`${base}/messages`);
    assert.equal(inboxResponse.status, 401);

    const count = store.list().length;
    assert.equal(count, 0, "Rejected webhook must not persist data");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unauthenticated clients cannot access sensitive inbox operations", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devcaught-operations-security-"));
  const { store } = openInboxStore(path.join(dir, "inbox.db"));
  const runtime = {
    store,
    inbox: new InboxService(store),
  } as DevCaughtRuntime;

  const server = createServer(createApiApp(runtime));

  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const requests = [
      { path: "/status", method: "GET" },
      { path: "/messages/example-id", method: "GET" },
      { path: "/messages/example-id/raw", method: "GET" },
      { path: "/messages/example-id", method: "DELETE" },
      { path: "/messages/clear", method: "POST" },
      { path: "/messages/test", method: "POST" },
    ];

    for (const item of requests) {
      const response = await fetch(`${base}${item.path}`, {
        method: item.method,
      });
      assert.equal(
        response.status,
        401,
        `${item.method} ${item.path} must reject unauthenticated access`,
      );
    }

    assert.equal(store.list().length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
