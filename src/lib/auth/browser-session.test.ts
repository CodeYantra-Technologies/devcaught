import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserAccessError, readBrowserSession, submitBrowserAuth } from "./browser-session.ts";
import { privateInboxKey, privateRequest } from "../inbox/browser-access.ts";
import { PRIVATE_ACCESS_EVENT } from "../inbox/browser-access.ts";
import { QueryClient } from "@tanstack/react-query";
import { fetchStatus } from "../api.ts";

const user = { id: "fixture-user", name: "Fixture", email: "fixture@example.test" };
const fixtureResponse = () => Response.json({ user, session: { id: "fixture-session" } });

test("browser session verification uses same-origin cookies, fresh server verification and abort signals", async () => {
  const signal = new AbortController().signal;
  const request: typeof fetch = async (path, options) => {
    assert.equal(path, "/api/auth/get-session?disableCookieCache=true");
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.cache, "no-store");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, signal.aborted);
    return fixtureResponse();
  };
  assert.deepEqual(await readBrowserSession(signal, request), user);
});

test("missing/invalid browser sessions never produce a dev user; forbidden and unavailable remain distinct", async () => {
  for (const result of [Response.json(null), new Response(null, { status: 401 })]) {
    assert.equal(await readBrowserSession(undefined, async () => result), null);
  }
  for (const status of [403, 503]) {
    await assert.rejects(readBrowserSession(undefined, async () => new Response(null, { status })),
      error => error instanceof BrowserAccessError && error.status === status);
  }
  await assert.rejects(readBrowserSession(undefined, async () => Response.json({ user })),
    error => error instanceof BrowserAccessError && error.status === 503);
});

test("login success requires a subsequent verified browser cookie, not just a successful POST", async () => {
  const calls: string[] = [];
  await submitBrowserAuth(false, { email: user.email, password: "isolated-test-input" }, async (path, options) => {
    calls.push(String(path));
    assert.equal(options?.credentials, "same-origin");
    return options?.method === "POST" ? Response.json({}) : fixtureResponse();
  });
  assert.deepEqual(calls, ["/api/auth/sign-in/email", "/api/auth/get-session?disableCookieCache=true"]);
  await assert.rejects(submitBrowserAuth(false, {}, async (_path, options) =>
    options?.method === "POST" ? Response.json({}) : Response.json(null)),
    error => error instanceof BrowserAccessError && error.status === 401);
});

test("invitation registration keeps its dedicated endpoint and does not assume a session was issued", async () => {
  let calls = 0;
  await submitBrowserAuth(true, { invitationToken: "isolated-fixture-token" }, async (path, options) => {
    calls++;
    assert.equal(path, "/api/auth/register-invitation");
    assert.equal(options?.method, "POST");
    return Response.json({ ok: true });
  });
  assert.equal(calls, 1);
});

test("private query caches are isolated by verified user", () => {
  const client = new QueryClient();
  try {
    client.setQueryData(privateInboxKey("a", "messages"), ["A private message"]);
    client.setQueryData(privateInboxKey("b", "messages"), ["B private message"]);
    assert.deepEqual(client.getQueryData(privateInboxKey("b", "messages")), ["B private message"]);
    client.removeQueries({ queryKey: ["private-inbox"] });
    assert.equal(client.getQueryData(privateInboxKey("a", "messages")), undefined);
    assert.equal(client.getQueryData(privateInboxKey("b", "messages")), undefined);
  } finally { client.clear(); }
});

test("cancelled private requests cannot restore cached data after logout clearing", async () => {
  const client = new QueryClient();
  let release!: (value: string[]) => void;
  const query = client.fetchQuery({ queryKey: privateInboxKey("a", "messages"),
    queryFn: () => new Promise<string[]>(resolve => { release = resolve; }),
  });
  const settled = query.catch(() => {});
  await client.cancelQueries({ queryKey: ["private-inbox"] });
  client.removeQueries({ queryKey: ["private-inbox"] });
  release(["late A private message"]);
  await settled;
  assert.equal(client.getQueryData(privateInboxKey("a", "messages")), undefined);
  client.clear();
});

test("private transport preserves status, suppresses response secrets, and sends no client identity", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const status of [401, 403, 404, 503]) {
    globalThis.fetch = async (path, options) => {
      assert.equal(path, "/api/messages");
      assert.equal(options?.credentials, "same-origin");
      assert.equal(options?.cache, "no-store");
      assert.equal(options?.headers, undefined);
      return Response.json({ error: "fixture-secret-must-not-escape" }, { status });
    };
    await assert.rejects(privateRequest("/api/messages"), error => {
      assert.ok(error instanceof BrowserAccessError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
});

test("private access failures notify the UI once, while ordinary cancellation does not", async t => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { value: target, configurable: true });
  const statuses: number[] = [];
  target.addEventListener(PRIVATE_ACCESS_EVENT, event => statuses.push((event as CustomEvent<number>).detail));
  for (const status of [401, 403, 503]) {
    globalThis.fetch = async () => new Response(null, { status });
    await assert.rejects(privateRequest("/api/messages"));
  }
  assert.deepEqual(statuses, [401, 403, 503]);
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => { throw new DOMException("Aborted", "AbortError"); };
  await assert.rejects(privateRequest("/api/messages", { signal: controller.signal }));
  assert.deepEqual(statuses, [401, 403, 503]);
});

test("malformed session/status responses and network failures remain unavailable", async t => {
  await assert.rejects(readBrowserSession(undefined, async () => new Response("invalid-json")),
    error => error instanceof BrowserAccessError && error.status === 503);
  await assert.rejects(submitBrowserAuth(false, {}, async () => { throw new TypeError("fixture-network-detail"); }),
    error => error instanceof BrowserAccessError && error.status === 503 && !error.message.includes("fixture-network"));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ product: "DevCaught", messageCount: -1 });
  await assert.rejects(fetchStatus(), error => error instanceof BrowserAccessError && error.status === 503);
});
