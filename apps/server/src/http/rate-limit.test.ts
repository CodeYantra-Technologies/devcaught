import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
// @ts-expect-error better-call does not publish types for this signer.
import { signCookieValue } from "../../../../node_modules/better-call/dist/crypto.mjs";
import { createApiApp } from "./app.ts";
import { AUTH_COOKIES } from "../../../../src/lib/auth/auth-config.ts";
import { handleAuthRequest } from "../../../../src/lib/auth/http-handler.ts";
import { handleAuthRoute } from "../../../../src/routes/api/auth/$.ts";
import { handlePrivateInboxRequest } from "../../../../src/lib/inbox/private-inbox-api.server.ts";
import {
  RequestRateLimiter, peerRateLimitKey, limitWebRequest, useWebBudgets, WebRequestBudgets,
  WEB_AGGREGATE_CEILING, WEB_REQUEST_BUDGET, controlSessionKey,
} from "./rate-limit.ts";
import { twilioSignature } from "../../../../packages/shared/src/sms/adapters.ts";
import type { DevCaughtRuntime } from "../runtime.ts";

const peer = (remoteAddress: string) => ({ socket: { remoteAddress } }) as IncomingMessage;
const SESSION_SECRET = "rate-limit-test-secret-not-a-deployed-credential";

function sessionCookie(token: string, secret = SESSION_SECRET): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return `${AUTH_COOKIES.session_token.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}

function forgedCookie(token: string): string {
  return `${AUTH_COOKIES.session_token.name}=${encodeURIComponent(`${token}.${"A".repeat(43)}=`)}`;
}

test("bounded quotas isolate peers, retain active keys, expire and report retry seconds", () => {
  let now = 1000;
  const limiter = new RequestRateLimiter({ limit: 2, maxKeys: 2, totalLimit: 4, now: () => now });
  assert.equal(limiter.check("a"), 0);
  assert.equal(limiter.check("a"), 0);
  assert.equal(limiter.check("a"), 60);
  assert.equal(limiter.check("b"), 0);
  assert.equal(limiter.check("c"), 60); // No eviction-based quota bypass.
  now += 1500;
  assert.equal(limiter.check("a"), 59);
  assert.equal(limiter.check("b"), 0);
  now += 60_000;
  assert.equal(limiter.check("c"), 0);
  assert.equal(limiter.check("a"), 0);
});

test("aggregate budget bounds rotating peers and invalid configuration fails closed", () => {
  const limiter = new RequestRateLimiter({ limit: 5, totalLimit: 2 });
  assert.equal(limiter.check("a"), 0);
  assert.equal(limiter.check("b"), 0);
  assert.ok(limiter.check("c") > 0);
  for (const limit of [0, -1, Infinity, 0.5]) assert.throws(() => new RequestRateLimiter({ limit }));
});

test("IP identities canonicalize mapped IPv4 and IPv6 /64, ignoring spoofed proxy headers", () => {
  assert.equal(peerRateLimitKey(peer("::ffff:127.0.0.1")), "127.0.0.1");
  assert.equal(peerRateLimitKey(peer("::ffff:7f00:1")), "127.0.0.1");
  assert.equal(peerRateLimitKey(peer("2001:db8:0:1::a")), peerRateLimitKey(peer("2001:0db8:0000:0001:ffff::b")));
  const forged = peer("203.0.113.1");
  forged.headers = { "x-forwarded-for": "198.51.100.2", forwarded: "for=198.51.100.3" };
  assert.equal(peerRateLimitKey(forged), "203.0.113.1");
  assert.equal(peerRateLimitKey(peer("not-an-ip")), "unknown-peer");
  assert.equal(peerRateLimitKey(peer("fe80::1%eth0")), "fe80:0:0:0::/64");
});

test("Express limits before parsing and signature verification, preserves valid SMS and guard responses", async () => {
  let now = 1000;
  let ingested = 0;
  const token = "test-token";
  const signedUrl = "https://example.test/webhooks/twilio";
  const runtime = {
    config: { twilioAuthToken: token, twilioPublicUrl: signedUrl },
    inbox: { ingestSms() { ingested++; return { duplicate: false, message: { id: "sms-1" } }; } },
  } as unknown as DevCaughtRuntime;
  const limiter = new RequestRateLimiter({ limit: 3, now: () => now });
  const server = createServer(createApiApp(runtime, limiter));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const params = { From: "+12345678901", To: "+12345678902", Body: "hello", MessageSid: "SM123" };
  try {
    const accepted = await fetch(base + "/webhooks/twilio", {
      method: "POST", body: new URLSearchParams(params),
      headers: { "x-twilio-signature": twilioSignature(token, signedUrl, params) },
    });
    assert.equal(accepted.status, 200);
    assert.equal(ingested, 1);
    assert.equal((await fetch(base + "/webhooks/demo", { method: "POST" })).status, 401);
    assert.equal((await fetch(base + "/messages")).status, 401);
    const blocked = await fetch(base + "/webhooks/twilio", {
      method: "POST", body: "not-json", headers: {
        "content-type": "application/json", "x-forwarded-for": "198.51.100.9",
        forwarded: "for=198.51.100.10",
      },
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
    assert.equal(blocked.headers.get("cache-control"), "no-store");
    assert.equal(ingested, 1);
    assert.equal((await fetch(base + "/health")).status, 200);
    now += 60_000;
    assert.equal((await fetch(base + "/webhooks/demo", { method: "POST" })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Web Request entry points use a bounded capture budget without spoofable IP headers", async () => {
  useWebBudgets(new WebRequestBudgets({
    authentication: 1, capture: 1, privateApi: 1, controlAnonymous: 1, controlSession: 1, controlSessionTotal: 1,
  }));
  try {
    assert.equal(limitWebRequest("capture", new Request("http://example.test", {
      headers: { "x-forwarded-for": "198.51.100.2", forwarded: "for=198.51.100.3" },
    })), undefined);
    const denied = limitWebRequest("capture", new Request("http://example.test", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    }))!;
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("retry-after"), "60");
    const { captureWebhook } = await import("./webhookRequest.ts");
    let read = false;
    const request = new Request("http://example.test/api/webhooks", { method: "POST",
      body: new ReadableStream({ pull() { read = true; } }, { highWaterMark: 0 }),
      duplex: "half", headers: { "x-forwarded-for": "203.0.113.9" },
    } as RequestInit);
    assert.equal((await captureWebhook(request)).status, 429);
    assert.equal(read, false);
  } finally { useWebBudgets(undefined); }
});

test("production web budgets stay isolated and do not raise the aggregate ceiling", () => {
  const ceiling = WEB_REQUEST_BUDGET.authentication + WEB_REQUEST_BUDGET.capture
    + WEB_REQUEST_BUDGET.privateApi + WEB_REQUEST_BUDGET.controlAnonymous
    + WEB_REQUEST_BUDGET.controlSessionTotal;
  assert.equal(ceiling, WEB_AGGREGATE_CEILING);
  assert.equal(WEB_AGGREGATE_CEILING, 600);
  assert.doesNotThrow(() => new WebRequestBudgets());
  assert.throws(() => new WebRequestBudgets({
    authentication: 600, capture: 600, privateApi: 600, controlAnonymous: 30, controlSession: 60, controlSessionTotal: 90,
  }));
  const token = "a".repeat(32);
  const signed = sessionCookie(token);
  assert.equal(controlSessionKey(signed, SESSION_SECRET)?.length, 32);
  assert.equal(controlSessionKey(signed, SESSION_SECRET), controlSessionKey(signed, SESSION_SECRET));
  assert.equal(controlSessionKey(forgedCookie(token), SESSION_SECRET), null);
  assert.equal(controlSessionKey(signed, null), null);
  assert.equal(controlSessionKey(signed, "different-test-secret-not-deployed"), null);
  assert.equal(controlSessionKey("better-auth.session_token=" + token, SESSION_SECRET), null);
  assert.equal(controlSessionKey(`${AUTH_COOKIES.session_token.name}=short`, SESSION_SECRET), null);
  const source = readFileSync(new URL("./rate-limit.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["'][^"']*auth\/server/);
  assert.doesNotMatch(source, /from ["']better-auth/);
});

test("signed session cookies match the auth cookie signer and ignore cookie shape", async () => {
  const token = "b".repeat(32);
  const encoded = await signCookieValue(token, SESSION_SECRET);
  const cookie = `${AUTH_COOKIES.session_token.name}=${encoded}`;
  assert.equal(controlSessionKey(cookie, SESSION_SECRET), controlSessionKey(sessionCookie(token), SESSION_SECRET));
  assert.notEqual(controlSessionKey(cookie, SESSION_SECRET), controlSessionKey(sessionCookie("c".repeat(32)), SESSION_SECRET));
});

test("unknown authentication requests cannot exhaust logout, capture, or the private-inbox fail-closed response", async () => {
  let now = 5_000;
  useWebBudgets(new WebRequestBudgets({
    authentication: 3,
    capture: 2,
    privateApi: 2,
    controlAnonymous: 1,
    controlSession: 2,
    controlSessionTotal: 4,
    controlSessionMaxKeys: 4,
    sessionSecret: SESSION_SECRET,
    now: () => now,
  }));
  const session = sessionCookie("b".repeat(24));
  const otherSession = sessionCookie("c".repeat(24));
  const forged = forgedCookie("d".repeat(32));
  let handlerCalls = 0;
  const unavailable = { async handler() { handlerCalls++; throw new Error("auth database unavailable"); } };
  const admitted = { async handler() { handlerCalls++; return new Response(null, { status: 200 }); } };
  const signIn = (forwardedFor: string) => new Request("http://127.0.0.1/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor, forwarded: "for=203.0.113.50" },
    body: JSON.stringify({ email: "unknown@example.test", password: "nope" }),
  });
  const signOut = (cookie?: string) => new Request("http://127.0.0.1/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: "{}",
  });
  try {
    for (let i = 0; i < 3; i++) {
      const response = await handleAuthRequest(signIn(`198.51.100.${i}`), unavailable);
      assert.equal(response.status, 503);
      assert.equal(await response.json().then(body => body.error), "Authentication temporarily unavailable");
    }
    const blocked = await handleAuthRequest(signIn("203.0.113.77"), unavailable);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
    assert.equal(blocked.headers.get("cache-control"), "no-store");
    const callsAfterFlood = handlerCalls;
    assert.equal((await handleAuthRequest(signOut(), admitted)).status, 200);
    assert.equal((await handleAuthRequest(signOut(), admitted)).status, 429);
    assert.equal((await handleAuthRequest(signOut(forged), admitted)).status, 429);
    assert.equal((await handleAuthRequest(signOut(session), unavailable)).status, 503);
    assert.equal((await handleAuthRequest(signOut(session), admitted)).status, 200);
    assert.equal((await handleAuthRequest(new Request("http://127.0.0.1/api/auth/get-session?disableCookieCache=true", {
      headers: { cookie: otherSession },
    }), admitted)).status, 200);
    assert.ok(handlerCalls > callsAfterFlood);
    assert.equal(limitWebRequest("capture", new Request("http://127.0.0.1/api/webhooks", {
      headers: { "x-forwarded-for": "192.0.2.9" },
    })), undefined);
    const inbox = await handlePrivateInboxRequest(new Request("http://127.0.0.1/api/messages"), "list");
    assert.equal(inbox.status, 503);
    assert.equal(inbox.headers.get("cache-control"), "private, no-store");
    now += 60_000;
    assert.equal((await handleAuthRequest(signIn("198.51.100.9"), unavailable)).status, 503);
  } finally {
    useWebBudgets(undefined);
  }
});

test("authentication unavailable stays 503 when the auth module cannot load", async () => {
  useWebBudgets(new WebRequestBudgets({
    authentication: 1, capture: 1, privateApi: 1, controlAnonymous: 1, controlSession: 1, controlSessionTotal: 1,
  }));
  try {
    const flood = await handleAuthRequest(new Request("http://127.0.0.1/api/auth/sign-in/email", { method: "POST" }), {
      async handler() { throw new Error("down"); },
    });
    assert.equal(flood.status, 503);
    assert.equal((await handleAuthRequest(new Request("http://127.0.0.1/api/auth/sign-in/email", { method: "POST" }), {
      async handler() { return new Response(null, { status: 200 }); },
    })).status, 429);
    const unavailable = await handleAuthRoute(new Request("http://127.0.0.1/api/auth/sign-in/email", { method: "POST" }));
    assert.equal(unavailable.status, 503);
    assert.equal(await unavailable.json().then(body => (body as { error: string }).error), "Authentication unavailable");
    const again = await handleAuthRoute(new Request("http://127.0.0.1/api/auth/sign-out", { method: "POST" }));
    assert.equal(again.status, 503);
  } finally {
    useWebBudgets(undefined);
  }
});

test("forged session cookies cannot exhaust a signed session or grow the key map", async () => {
  let now = 20_000;
  useWebBudgets(new WebRequestBudgets({
    authentication: 2,
    capture: 1,
    privateApi: 1,
    controlAnonymous: 2,
    controlSession: 2,
    controlSessionTotal: 3,
    controlSessionMaxKeys: 1,
    sessionSecret: SESSION_SECRET,
    now: () => now,
  }));
  let handlerCalls = 0;
  const admitted = { async handler() { handlerCalls++; return new Response(null, { status: 200 }); } };
  const unavailable = { async handler() { handlerCalls++; throw new Error("auth database unavailable"); } };
  const signOut = (cookie?: string, forwardedFor = "198.51.100.8") => new Request("http://127.0.0.1/api/auth/sign-out", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
      forwarded: "for=203.0.113.8",
      ...(cookie ? { cookie } : {}),
    },
    body: "{}",
  });
  const signed = sessionCookie("e".repeat(32));
  const second = sessionCookie("f".repeat(32));
  try {
    for (let i = 0; i < 2; i++) {
      const response = await handleAuthRequest(signOut(forgedCookie(`f${i}${"a".repeat(30)}`), `203.0.113.${i}`), unavailable);
      assert.equal(response.status, 503);
      assert.equal(await response.json().then(body => body.error), "Authentication temporarily unavailable");
    }
    const flooded = await handleAuthRequest(signOut(forgedCookie("g".repeat(32)), "192.0.2.9"), admitted);
    assert.equal(flooded.status, 429);
    assert.equal(flooded.headers.get("retry-after"), "60");
    assert.equal(flooded.headers.get("cache-control"), "no-store");
    const callsAfterFlood = handlerCalls;
    assert.equal((await handleAuthRequest(signOut(), admitted)).status, 429);
    assert.equal((await handleAuthRequest(signOut(signed), admitted)).status, 200);
    assert.equal((await handleAuthRequest(signOut(signed), admitted)).status, 200);
    assert.equal((await handleAuthRequest(signOut(signed), admitted)).status, 429);
    assert.equal((await handleAuthRequest(signOut(second), admitted)).status, 429);
    assert.ok(handlerCalls > callsAfterFlood);
    assert.equal((await handleAuthRequest(new Request("http://127.0.0.1/api/auth/sign-in/email", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.50", forwarded: "for=198.51.100.51" },
      body: "{}",
    }), unavailable)).status, 503);
    assert.equal(limitWebRequest("capture", new Request("http://127.0.0.1/api/webhooks", {
      headers: { "x-forwarded-for": "192.0.2.77" },
    })), undefined);
    now += 60_000;
    useWebBudgets(new WebRequestBudgets({
      authentication: 1, capture: 1, privateApi: 1, controlAnonymous: 1, controlSession: 2, controlSessionTotal: 2,
      sessionSecret: null, now: () => now,
    }));
    assert.equal((await handleAuthRequest(signOut(signed), admitted)).status, 200);
    assert.equal((await handleAuthRequest(signOut(signed), admitted)).status, 429);
    assert.equal((await handleAuthRequest(signOut(forgedCookie("h".repeat(32))), admitted)).status, 429);
  } finally {
    useWebBudgets(undefined);
  }
});
