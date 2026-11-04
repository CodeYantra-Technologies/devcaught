import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import type { DevCaughtRuntime } from "../runtime.ts";
import { openInboxStore, type InboxStore } from "../store/sqlite.ts";
import { createLocalInboxMiddleware } from "./local-inbox.ts";

const path = "/__devcaught/local-inbox/health";

function encodedLayers(value: string, layers: number): string {
  let encoded = value;
  for (let i = 0; i < layers; i++) encoded = encodeURIComponent(encoded);
  return encoded;
}

function fixture(options: {
  address?: string;
  port?: number;
  mode?: "local" | "private";
  smtpRunning?: boolean;
  smtpHost?: string;
  livePreview?: boolean;
  runtimeFailure?: boolean;
  getRuntime?: () => Promise<DevCaughtRuntime>;
  store?: InboxStore;
} = {}) {
  const address = options.address ?? "127.0.0.1";
  const port = options.port ?? 8080;
  const server = {
    httpServer: { address: () => ({ address, port, family: address.includes(":") ? "IPv6" : "IPv4" }) },
  } as unknown as ViteDevServer;
  const runtime = {
    config: { smtpRoutingMode: options.mode ?? "local", host: options.smtpHost ?? "127.0.0.1" },
    smtp: { status: { running: options.smtpRunning ?? true, host: options.smtpHost ?? "127.0.0.1" } },
    store: options.store,
  } as unknown as DevCaughtRuntime;
  const middleware = createLocalInboxMiddleware(
    server,
    options.getRuntime ?? (async () => {
      if (options.runtimeFailure) throw new Error("startup failed");
      return runtime;
    }),
    options.livePreview ?? false,
  );
  return { middleware, port, runtime };
}

function startRequest(
  middleware: ReturnType<typeof createLocalInboxMiddleware>,
  options: {
    url?: string;
    method?: string;
    host?: string;
    rawHeaders?: string[];
    origin?: string;
    fetchSite?: string;
    forwardedHost?: string;
    forwardedProto?: string;
    forwardedFor?: string;
    contentType?: string;
    contentLength?: string;
    contentEncoding?: string;
    body?: string | Uint8Array[];
    extraHeaders?: Record<string, string>;
    remoteAddress?: string;
  } = {},
): {
  result: Promise<{ status: number; body: string; headers: Record<string, string>; fellThrough: boolean }>;
  disconnect(): void;
  writes(): number;
} {
  const headers: Record<string, string> = {};
  let status = 200;
  let body = "";
  let fellThrough = false;
  const responseState = { statusCode: 200, headersSent: false, destroyed: false };
  let writes = 0;
  let finish!: () => void;
  const complete = new Promise<void>(resolve => { finish = resolve; });
  const req = {
    url: options.url ?? path,
    method: options.method ?? "GET",
    headers: {
      host: options.host ?? "127.0.0.1:8080",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.fetchSite === undefined ? {} : { "sec-fetch-site": options.fetchSite }),
      ...(options.forwardedHost === undefined ? {} : { "x-forwarded-host": options.forwardedHost }),
      ...(options.forwardedProto === undefined ? {} : { "x-forwarded-proto": options.forwardedProto }),
      ...(options.forwardedFor === undefined ? {} : { "x-forwarded-for": options.forwardedFor }),
      ...(options.contentType === undefined ? {} : { "content-type": options.contentType }),
      ...(options.contentLength === undefined ? {} : { "content-length": options.contentLength }),
      ...(options.contentEncoding === undefined ? {} : { "content-encoding": options.contentEncoding }),
      ...options.extraHeaders,
    },
    rawHeaders: options.rawHeaders ?? [
      "Host", options.host ?? "127.0.0.1:8080",
      ...(options.origin === undefined ? [] : ["Origin", options.origin]),
      ...(options.fetchSite === undefined ? [] : ["Sec-Fetch-Site", options.fetchSite]),
      ...(options.forwardedHost === undefined ? [] : ["X-Forwarded-Host", options.forwardedHost]),
      ...(options.forwardedProto === undefined ? [] : ["X-Forwarded-Proto", options.forwardedProto]),
      ...(options.forwardedFor === undefined ? [] : ["X-Forwarded-For", options.forwardedFor]),
      ...(options.contentType === undefined ? [] : ["Content-Type", options.contentType]),
      ...(options.contentLength === undefined ? [] : ["Content-Length", options.contentLength]),
      ...(options.contentEncoding === undefined ? [] : ["Content-Encoding", options.contentEncoding]),
      ...Object.entries(options.extraHeaders ?? {}).flatMap(([key, value]) => [key, value]),
    ],
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1", encrypted: false },
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (Array.isArray(options.body)) {
        for (const chunk of options.body) yield Buffer.from(chunk);
      } else if (typeof options.body === "string") {
        yield Buffer.from(options.body);
      }
    },
  } as unknown as IncomingMessage;
  const res = {
    ...responseState,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    end(this: typeof responseState, value = "") {
      writes++;
      status = this.statusCode;
      body = value;
      this.headersSent = true;
      finish();
    },
  } as unknown as ServerResponse & { statusCode: number; headersSent: boolean; destroyed: boolean };
  middleware.handler(req, res, () => { fellThrough = true; finish(); });
  return {
    result: complete.then(() => ({ status, body, headers, fellThrough })),
    disconnect() { res.destroyed = true; },
    writes() { return writes; },
  };
}

async function request(
  middleware: ReturnType<typeof createLocalInboxMiddleware>,
  options: Parameters<typeof startRequest>[1] = {},
) {
  return startRequest(middleware, options).result;
}

test("allows only a fixed health response on an eligible IPv4 loopback listener", async () => {
  const { middleware } = fixture();
  const response = await request(middleware);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, mode: "local-capture" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("redirects the root to the local dashboard only when the health capability is available", async () => {
  const local = await request(fixture().middleware, { url: "/" });
  assert.equal(local.status, 302);
  assert.equal(local.headers.location, "/local-inbox");
  assert.equal(local.headers["cache-control"], "no-store");
  assert.equal(local.fellThrough, false);

  for (const options of [
    { mode: "private" as const },
    { smtpRunning: false },
    { smtpHost: "0.0.0.0" },
    { address: "0.0.0.0" },
    { livePreview: true },
    { runtimeFailure: true },
  ]) {
    const response = await request(fixture(options).middleware, { url: "/" });
    assert.equal(response.status, 200, JSON.stringify(options));
    assert.equal(response.fellThrough, true, JSON.stringify(options));
  }
});

test("accepts IPv6 loopback only with its bracketed Host authority", async () => {
  const { middleware } = fixture({ address: "::1" });
  const response = await request(middleware, { host: "[::1]:8080" });
  assert.equal(response.status, 200);
});

test("denies wildcard and non-loopback Vite listeners", async () => {
  for (const address of ["0.0.0.0", "192.0.2.12", "::"]) {
    const { middleware } = fixture({ address });
    assert.equal((await request(middleware)).status, 403, address);
  }
  assert.equal((await request(fixture().middleware, { remoteAddress: "203.0.113.4" })).status, 403);
});

test("denies explicit live-preview mode and unavailable or private SMTP", async () => {
  assert.equal((await request(fixture({ livePreview: true }).middleware)).status, 503);
  assert.equal((await request(fixture({ smtpRunning: false }).middleware)).status, 503);
  assert.equal((await request(fixture({ mode: "private" }).middleware)).status, 503);
  assert.equal((await request(fixture({ smtpHost: "0.0.0.0" }).middleware)).status, 503);
});

test("rejects Host mismatch, duplicate or malformed Host, forwarding and rebinding names", async () => {
  const { middleware } = fixture();
  for (const options of [
    { host: "127.0.0.1:8081" },
    { host: "localhost:8080" },
    { host: "127.0.0.1:08080" },
    { host: "127.0.0.1:99999" },
    { host: "attacker.example:8080" },
    { forwardedHost: "127.0.0.1:8080" },
    { host: "127.0.0.1:8080", rawHeaders: ["Host", "127.0.0.1:8080", "Host", "127.0.0.1:8080"] },
  ]) {
    assert.equal((await request(middleware, options)).status, 403, JSON.stringify(options));
  }
});

test("validates supplied Origin and requires exact Origin for mutations", async () => {
  const { middleware } = fixture();
  assert.equal((await request(middleware, { origin: "http://localhost:8080" })).status, 403);
  assert.equal((await request(middleware, { origin: "null" })).status, 403);
  assert.equal((await request(middleware, { origin: "not an origin" })).status, 403);
  assert.equal((await request(middleware, { method: "POST" })).status, 403);
  assert.equal((await request(middleware, { method: "POST", origin: "http://127.0.0.1:8081" })).status, 403);
  const allowedOrigin = await request(middleware, { method: "POST", origin: "http://127.0.0.1:8080" });
  assert.equal(allowedOrigin.status, 405, "a valid same-origin mutation still has no endpoint");
});

test("rejects cross-site Fetch Metadata and never falls through reserved paths", async () => {
  const { middleware } = fixture();
  assert.equal((await request(middleware, { fetchSite: "cross-site" })).status, 403);
  for (const url of [
    "/__devcaught/local-inbox/unknown",
    "/__devcaught/local-inbox/%ZZ",
    "/__devcaught/local-inbox%ZZ",
    "/__devcaught%2flocal-inbox/health",
    "/__devcaught%2Flocal-inbox%2Fhealth",
    "/__devcaught%5clocal-inbox%5chealth",
    "/%255f%5fdevcaught%2Flocal-inbox%252fhealth",
    "/%5f%5fdevcaught%2flocal-inbox/%FF",
    "/%5f%5fdevcaught%2flocal-inbox/%ZZ",
    "/%5f%5fdevcaught%2flocal-inbox/%E0%ZZ",
    "/some/../__devcaught/local-inbox/health",
    "/__devcaught/local-inbox/health?mode=1",
    "/__devcaught/local-inbox/health#fragment",
    "//__devcaught/local-inbox/health",
    encodeURIComponent(encodeURIComponent(path)),
    `/%255f%255fdevcaught%252flocal-inbox%252fhealth/%ZZ`,
  ]) {
    const response = await request(middleware, { url });
    assert.equal(response.status, 404, url);
    assert.equal(response.fellThrough, false, url);
  }
  assert.equal((await request(middleware, { url: "/not-local-inbox" })).fellThrough, true);
  assert.equal((await request(middleware, { url: "//ordinary/path" })).fellThrough, true);
  assert.equal((await request(middleware, { url: "//ordinary/__devcaught/local-inbox/health" })).fellThrough, true);
  assert.equal((await request(middleware, { url: "/unrelated?next=/__devcaught/local-inbox/health" })).fellThrough, true);
  assert.equal((await request(middleware, { url: "/unrelated/%FF%2Fpath" })).fellThrough, true);
  assert.equal((await request(middleware, { url: "/unrelated/%ZZ%2Fpath" })).fellThrough, true);
  assert.equal((await request(middleware, { url: encodeURIComponent(encodeURIComponent("/unrelated/path")) })).fellThrough, true);
  assert.equal((await request(middleware, { url: encodedLayers("/unrelated/path", 18) })).fellThrough, true);
});

test("deeply encoded reserved aliases are consumed within and beyond the decode bound", async () => {
  const { middleware } = fixture();
  for (const layers of [17, 18, 32, 33]) {
    const alias = encodedLayers(path, layers);
    const response = await request(middleware, { url: alias });
    assert.equal(response.status, 404, `${layers}-layer alias cannot access health`);
    assert.equal(response.fellThrough, false, `${layers}-layer alias is consumed`);
  }
});

test("startup rejection fails closed without an unhandled rejection", async () => {
  const response = await request(fixture({ runtimeFailure: true }).middleware);
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "Unavailable" });
});

test("revoked middleware denies requests and never writes after async runtime resolution", async () => {
  let resolveRuntime!: (runtime: DevCaughtRuntime) => void;
  let runtimeStarted!: () => void;
  const started = new Promise<void>(resolve => { runtimeStarted = resolve; });
  const pendingRuntime = new Promise<DevCaughtRuntime>(resolve => { resolveRuntime = resolve; });
  const { middleware, runtime } = fixture({
    getRuntime() {
      runtimeStarted();
      return pendingRuntime;
    },
  });
  const inFlight = startRequest(middleware, { url: "/__devcaught/local-inbox/messages" });
  await started;
  inFlight.disconnect();
  resolveRuntime(runtime);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inFlight.writes(), 0, "destroyed client response is never written");

  middleware.revoke();
  assert.equal((await request(middleware)).status, 503);
});

test("revocation while runtime initialization is pending prevents later access", async () => {
  let resolveRuntime!: (runtime: DevCaughtRuntime) => void;
  let runtimeStarted!: () => void;
  const started = new Promise<void>(resolve => { runtimeStarted = resolve; });
  const pendingRuntime = new Promise<DevCaughtRuntime>(resolve => { resolveRuntime = resolve; });
  const { middleware, runtime } = fixture({
    getRuntime() {
      runtimeStarted();
      return pendingRuntime;
    },
  });
  const inFlight = startRequest(middleware);
  await started;
  middleware.revoke();
  resolveRuntime(runtime);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inFlight.writes(), 0, "revoked in-flight requests cannot write a response");
  assert.equal((await request(middleware)).status, 503, "later requests remain denied");
});

test("OPTIONS is denied without API CORS headers (Vite may answer preflight first)", async () => {
  const response = await request(fixture().middleware, { method: "OPTIONS" });
  assert.equal(response.status, 403, "preflight without same-origin Origin is rejected by the API gate");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["access-control-allow-methods"], undefined);
  const sameOrigin = await request(fixture().middleware, {
    method: "OPTIONS",
    origin: "http://127.0.0.1:8080",
  });
  assert.equal(sameOrigin.status, 405, "the namespace has no OPTIONS endpoint");
});

test("encoded namespace variants are consumed even when their route is invalid", async () => {
  const response = await request(fixture().middleware, { url: "/%5f%5fdevcaught/local-inbox/health" });
  assert.equal(response.status, 404);
  assert.equal(response.fellThrough, false);
});

function email(id: string, subject: string, createdAt: number) {
  return {
    id,
    type: "email" as const,
    source: "smtp" as const,
    sender: "sender@example.test",
    recipient: "developer@example.test",
    subject,
    textBody: `Plain OTP body ${subject}`,
    htmlBody: `<html><body>HTML SECRET ${subject}</body></html>`,
    rawData: `RAW MIME SECRET ATTACHMENT SECRET ${subject}`,
    detections: [{
      type: "otp" as const,
      value: "482913",
      confidence: 0.99,
      label: "One-time code",
      metadata: { secret: "must-not-serialize" },
    }],
    createdAt,
  };
}

test("lists and details only trusted local SMTP records with allowlisted fields", async t => {
  const { store } = openInboxStore(":memory:");
  t.after(() => store.close());
  const trusted = store.forLocalSmtpCapture();
  const privateInbox = store.forInbox("private-inbox-a");
  trusted.insert(email("smtp-new", "trusted newest", 3_000));
  trusted.insert(email("smtp-old", "trusted older", 2_000));
  store.insert(email("root-smtp", "root smtp", 9_000));
  store.insert({ ...email("root-test", "root test email", 8_500), source: "test" } as never);
  store.insert({ ...email("root-webhook", "root webhook", 8_000), type: "webhook", source: "http" } as never);
  store.insertSms({ ...email("root-sms", "root sms", 7_000), type: "sms", source: "http", dedupeKey: null } as never);
  store.forLocalCapture().insert(email("legacy-null", "legacy untrusted", 6_000));
  const privateMessage = privateInbox.insert(email("private-smtp", "private smtp", 10_000));

  const { middleware } = fixture({ store });
  const first = await request(middleware, { url: "/__devcaught/local-inbox/messages?limit=1" });
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(first.headers["x-content-type-options"], "nosniff");
  const firstBody = JSON.parse(first.body) as { items: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: string };
  assert.deepEqual(firstBody.items.map(item => item.id), ["smtp-new"]);
  assert.equal(firstBody.hasMore, true);
  assert.ok(firstBody.nextCursor);
  assert.deepEqual(Object.keys(firstBody.items[0]!).sort(), [
    "createdAt", "hasHtml", "hasText", "id", "recipient", "sender", "source", "subject", "type",
  ]);
  assert.equal("detections" in firstBody.items[0]!, false);
  assert.ok(!first.body.includes("482913"));
  assert.ok(!first.body.includes("HTML SECRET"));
  assert.ok(!first.body.includes("RAW MIME SECRET"));
  assert.ok(!first.body.includes("ATTACHMENT SECRET"));
  assert.ok(!first.body.includes("must-not-serialize"));
  assert.ok(!first.body.includes("private smtp"));

  const second = await request(middleware, {
    url: `/__devcaught/local-inbox/messages?limit=1&cursor=${firstBody.nextCursor}`,
  });
  assert.deepEqual((JSON.parse(second.body) as { items: Array<{ id: string }> }).items.map(item => item.id), ["smtp-old"]);
  const search = await request(middleware, { url: "/__devcaught/local-inbox/messages?query=older" });
  assert.deepEqual((JSON.parse(search.body) as { items: Array<{ id: string }> }).items.map(item => item.id), ["smtp-old"]);

  const detail = await request(middleware, { url: "/__devcaught/local-inbox/messages/smtp-new" });
  assert.equal(detail.status, 200);
  const detailMessage = (JSON.parse(detail.body) as { message: Record<string, unknown> }).message;
  assert.equal(detailMessage.textBody, "Plain OTP body trusted newest");
  assert.equal(detailMessage.id, "smtp-new");
  assert.deepEqual(Object.keys(detailMessage).sort(), [
    "createdAt", "hasHtml", "hasText", "id", "recipient", "sender", "source", "subject", "textBody", "type",
  ]);
  assert.equal("detections" in detailMessage, false);
  assert.ok(!detail.body.includes("482913"));
  assert.ok(!detail.body.includes("HTML SECRET"));
  assert.ok(!detail.body.includes("RAW MIME SECRET"));
  assert.ok(!detail.body.includes("ATTACHMENT SECRET"));
  assert.ok(!detail.body.includes("must-not-serialize"));

  for (const id of ["root-smtp", "root-test", "root-webhook", "root-sms", "legacy-null", privateMessage.id]) {
    const response = await request(middleware, { url: `/__devcaught/local-inbox/messages/${id}` });
    assert.equal(response.status, 404, `${id} is outside trusted local SMTP provenance`);
    assert.equal(response.fellThrough, false);
  }
});

test("captures bounded JSON webhooks and exposes only trusted normalized fields", async t => {
  const { store } = openInboxStore(":memory:");
  t.after(() => store.close());
  const trustedSmtp = store.forLocalSmtpCapture();
  trustedSmtp.insert({
    type: "email", source: "smtp", sender: "mail@example.test", recipient: "dev@example.test",
    subject: "trusted smtp", textBody: "mail body", htmlBody: "", rawData: "smtp raw",
    detections: [], createdAt: 1_000,
  });
  store.insert({
    type: "webhook", source: "http", sender: "untrusted", recipient: "/root", subject: "root webhook",
    textBody: "root body", htmlBody: "", rawData: "root raw", detections: [], createdAt: 9_000,
  });
  store.forInbox("private-a").insert({
    type: "webhook", source: "http", sender: "private", recipient: "/private", subject: "private webhook",
    textBody: "private body", htmlBody: "", rawData: "private raw", detections: [], createdAt: 10_000,
  });
  const { middleware } = fixture({ store });
  const payload = JSON.stringify({ event: "synthetic.created", html: "<script>must remain text</script>" });
  const payloadBytes = Buffer.from(payload);
  const accepted = await request(middleware, {
    url: "/__devcaught/local-inbox/webhooks",
    method: "POST",
    origin: "http://127.0.0.1:8080",
    fetchSite: "same-origin",
    contentType: "application/json; charset=utf-8",
    body: [payloadBytes.subarray(0, 7), payloadBytes.subarray(7, 23), payloadBytes.subarray(23)],
    extraHeaders: { Authorization: "Bearer header-secret", "X-Api-Key": "key-secret", "User-Agent": "Synthetic-Agent" },
  });
  assert.equal(accepted.status, 201);
  const id = (JSON.parse(accepted.body) as { id: string }).id;
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(accepted.headers["x-content-type-options"], "nosniff");

  const list = await request(middleware, { url: "/__devcaught/local-inbox/messages?limit=10" });
  const items = (JSON.parse(list.body) as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(items.map(item => item.id).sort(), [id, ...store.forLocalSmtpCapture().list().map(item => item.id)].sort());
  const webhookSummary = items.find(item => item.id === id)!;
  assert.equal(webhookSummary.method, "POST");
  assert.equal(webhookSummary.subject, "synthetic.created");
  assert.equal("recipient" in webhookSummary, false, "webhook URL and query data are not exposed");
  assert.ok(!list.body.includes("header-secret"));
  assert.ok(!list.body.includes("key-secret"));
  assert.ok(!list.body.includes("root webhook"));
  assert.ok(!list.body.includes("private webhook"));

  const search = await request(middleware, { url: "/__devcaught/local-inbox/messages?query=synthetic.created" });
  assert.deepEqual((JSON.parse(search.body) as { items: Array<{ id: string }> }).items.map(item => item.id), [id]);
  const detailResponse = await request(middleware, { url: `/__devcaught/local-inbox/messages/${id}` });
  assert.equal(detailResponse.status, 200);
  const detail = (JSON.parse(detailResponse.body) as { message: Record<string, unknown> }).message;
  assert.equal(detail.method, "POST");
  assert.equal(detail.textBody, JSON.stringify(JSON.parse(payload), null, 2));
  assert.deepEqual(Object.keys(detail).sort(), [
    "createdAt", "hasHtml", "hasText", "id", "method", "source", "subject", "textBody", "type",
  ]);
  assert.ok(!detailResponse.body.includes("header-secret"));
  assert.ok(!detailResponse.body.includes("key-secret"));
  assert.ok(!detailResponse.body.includes("Authorization"));
  assert.equal(JSON.parse(store.getRaw(id)!).headers.authorization, "[REDACTED]");
  assert.equal(JSON.parse(store.getRaw(id)!).headers["x-api-key"], "[REDACTED]");
  assert.equal(store.forLocalCapture().getLocalSmtp(id), null);
  assert.equal(store.forLocalCapture().getLocalCapture(id)?.type, "webhook");
});

test("captures only validated local synthetic SMS and returns allowlisted trusted data", async t => {
  const { store } = openInboxStore(":memory:");
  t.after(() => store.close());
  store.insertSms({
    type: "sms", source: "http", sender: "+14155550000", recipient: "+14155559999",
    subject: "untrusted SMS", textBody: "untrusted", htmlBody: "", rawData: "{}", detections: [],
    createdAt: 3_000, dedupeKey: null,
  });
  store.forInbox("private-a").insertSms({
    type: "sms", source: "http", sender: "+14155550001", recipient: "+14155559998",
    subject: "private SMS", textBody: "private", htmlBody: "", rawData: "{}", detections: [],
    createdAt: 4_000, dedupeKey: null,
  });
  const { middleware } = fixture({ store });
  const accepted = await request(middleware, {
    url: "/__devcaught/local-inbox/sms", method: "POST",
    origin: "http://127.0.0.1:8080", fetchSite: "same-origin",
    contentType: "application/json",
    body: JSON.stringify({ sender: "+14155550123", recipient: "+14155550199", text: "<script>inert SMS text</script>" }),
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(accepted.headers["x-content-type-options"], "nosniff");
  const id = (JSON.parse(accepted.body) as { id: string }).id;
  const all = await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=all" });
  const allItems = (JSON.parse(all.body) as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(allItems.map(item => item.id), [id]);
  const summary = allItems[0]!;
  assert.equal(summary.type, "sms");
  assert.equal(summary.source, "simulated");
  assert.equal(summary.provider, "simulated");
  assert.equal(summary.verification, "local");
  assert.equal(summary.sender, "+*******0123");
  assert.equal(summary.recipient, "+*******0199");
  assert.equal(summary.body, "<script>inert SMS text</script>");
  assert.deepEqual(Object.keys(summary).sort(), [
    "body", "createdAt", "hasHtml", "hasText", "id", "provider", "recipient", "sender", "source", "subject", "type", "verification",
  ]);
  assert.ok(!all.body.includes("+14155550123"));
  assert.ok(!all.body.includes("private SMS"));
  assert.ok(!all.body.includes("untrusted SMS"));

  const filtered = await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=sms&query=inert" });
  assert.deepEqual((JSON.parse(filtered.body) as { items: Array<{ id: string }> }).items.map(item => item.id), [id]);
  const detailResponse = await request(middleware, { url: `/__devcaught/local-inbox/messages/${id}` });
  assert.equal(detailResponse.status, 200);
  const detail = (JSON.parse(detailResponse.body) as { message: Record<string, unknown> }).message;
  assert.equal(detail.body, "<script>inert SMS text</script>");
  assert.equal(detail.textBody, undefined);
  assert.equal(detail.status, undefined);
  assert.equal(detail.messageSid, undefined);
  assert.deepEqual(Object.keys(detail).sort(), Object.keys(summary).sort());
  assert.equal(store.forLocalCapture().getLocalCapture(id)?.sms?.verification, "local");
});

test("rejects invalid and hostile synthetic SMS requests without writes", async t => {
  const { store } = openInboxStore(":memory:");
  t.after(() => store.close());
  const { middleware } = fixture({ store });
  const path = "/__devcaught/local-inbox/sms";
  const valid = {
    url: path, method: "POST", origin: "http://127.0.0.1:8080", fetchSite: "same-origin",
    contentType: "application/json", body: JSON.stringify({ sender: "+14155550123", recipient: "+14155550199", text: "hello" }),
  };
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal((await request(middleware, { ...valid, method })).status, 405, method);
  }
  for (const invalid of [
    { ...valid, body: "{" },
    { ...valid, contentType: "text/plain" },
    { ...valid, body: JSON.stringify({ sender: "", recipient: "+14155550199", text: "hello" }) },
    { ...valid, body: JSON.stringify({ sender: "+14155550123", text: "hello" }) },
    { ...valid, body: JSON.stringify({ sender: "555-0123", recipient: "+14155550199", text: "hello" }) },
    { ...valid, body: JSON.stringify({ sender: "+14155550123", recipient: "+14155550199", text: "  " }) },
    { ...valid, body: JSON.stringify({ sender: "+14155550123", recipient: "+14155550199", text: "x".repeat(1025) }) },
    { ...valid, body: JSON.stringify({ sender: "+14155550123", recipient: "+14155550199", text: "hello", verification: "valid" }) },
  ]) assert.ok([400, 415].includes((await request(middleware, invalid)).status));
  assert.equal((await request(middleware, { ...valid, body: [new Uint8Array(16_385)] })).status, 413);
  assert.equal((await request(middleware, { ...valid, contentLength: "16385", body: "{}" })).status, 413);
  for (const hostile of [
    { host: "attacker.example:8080" },
    { origin: "http://localhost:8080" },
    { forwardedHost: "127.0.0.1:8080" },
    { forwardedProto: "https" },
    { forwardedFor: "127.0.0.1" },
    { remoteAddress: "203.0.113.9" },
    { fetchSite: "cross-site" },
  ]) assert.equal((await request(middleware, { ...valid, ...hostile })).status, 403, JSON.stringify(hostile));
  assert.equal(store.count(), 0);
});

test("filters trusted channels before search pagination and preserves descending order", async t => {
  const { store } = openInboxStore(":memory:");
  t.after(() => store.close());
  const email = (id: string, createdAt: number) => ({
    id, type: "email" as const, source: "smtp" as const, sender: "s", recipient: "r", subject: id,
    textBody: id, htmlBody: "", rawData: "", detections: [], createdAt,
  });
  const webhook = (id: string, createdAt: number) => ({
    id, type: "webhook" as const, source: "http" as const, sender: "agent", recipient: "/hook", subject: id,
    textBody: id, htmlBody: "", rawData: "{\"headers\":{}}", detections: [], createdAt,
  });
  const sms = (id: string, createdAt: number) => ({
    id, type: "sms" as const, source: "simulated" as const, sender: "+*******0123", recipient: "+*******0199",
    subject: "Synthetic SMS", textBody: id, htmlBody: "",
    rawData: JSON.stringify({ sms: {
      provider: "simulated", kind: "inbound", messageSid: null, from: "+*******0123", to: "+*******0199",
      body: id, status: null, errorCode: null, numSegments: null, numMedia: null, mediaUrls: [],
      receivedAt: createdAt, verification: "local",
    } }), detections: [], createdAt, dedupeKey: null,
  });
  store.forLocalSmtpCapture().insert(email("email-new", 5_000));
  store.forLocalSmsCapture().insertSms(sms("sms-new", 4_500));
  store.forLocalWebhookCapture().insert(webhook("webhook-new", 4_000));
  store.forLocalSmtpCapture().insert(email("email-old", 3_000));
  store.forLocalSmsCapture().insertSms(sms("sms-old", 2_500));
  store.forLocalWebhookCapture().insert(webhook("webhook-old", 2_000));
  const { middleware } = fixture({ store });

  const emailPage = await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=email&limit=1" });
  const emailBody = JSON.parse(emailPage.body) as { items: Array<{ id: string }>; hasMore: boolean };
  assert.deepEqual(emailBody.items.map(item => item.id), ["email-new"]);
  assert.equal(emailBody.hasMore, true);

  const firstWebhook = await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=webhook&limit=1" });
  const webhookBody = JSON.parse(firstWebhook.body) as { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string };
  assert.deepEqual(webhookBody.items.map(item => item.id), ["webhook-new"]);
  assert.equal(webhookBody.hasMore, true);
  const secondWebhook = await request(middleware, { url: `/__devcaught/local-inbox/messages?channel=webhook&limit=1&cursor=${webhookBody.nextCursor}` });
  assert.deepEqual((JSON.parse(secondWebhook.body) as { items: Array<{ id: string }> }).items.map(item => item.id), ["webhook-old"]);

  const firstSms = await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=sms&limit=1" });
  const smsBody = JSON.parse(firstSms.body) as { items: Array<{ id: string; body: string }>; hasMore: boolean; nextCursor: string };
  assert.deepEqual(smsBody.items.map(item => item.id), ["sms-new"]);
  assert.equal(smsBody.items[0]?.body, "sms-new");
  assert.equal(smsBody.hasMore, true);
  const secondSms = await request(middleware, { url: `/__devcaught/local-inbox/messages?channel=sms&limit=1&cursor=${smsBody.nextCursor}` });
  assert.deepEqual((JSON.parse(secondSms.body) as { items: Array<{ id: string }> }).items.map(item => item.id), ["sms-old"]);
  const searchedSms = await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=sms&query=sms-old" });
  assert.deepEqual((JSON.parse(searchedSms.body) as { items: Array<{ id: string }> }).items.map(item => item.id), ["sms-old"]);

  const searched = await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=webhook&query=webhook-old" });
  assert.deepEqual((JSON.parse(searched.body) as { items: Array<{ id: string }> }).items.map(item => item.id), ["webhook-old"]);
  const hiddenMetadataSearch = await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=webhook&query=%2Fhook" });
  assert.deepEqual((JSON.parse(hiddenMetadataSearch.body) as { items: Array<{ id: string }> }).items, []);
  assert.equal((await request(middleware, { url: "/__devcaught/local-inbox/messages?channel=private" })).status, 400);
});

test("rejects invalid webhook bodies, methods, Host/Origin and forwarded headers", async t => {
  const { store } = openInboxStore(":memory:");
  t.after(() => store.close());
  const { middleware } = fixture({ store });
  const path = "/__devcaught/local-inbox/webhooks";
  const valid = {
    url: path, method: "POST", origin: "http://127.0.0.1:8080", fetchSite: "same-origin",
    contentType: "application/json", body: "{}",
  };
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal((await request(middleware, { ...valid, method })).status, 405, method);
  }
  for (const options of [
    { ...valid, body: "{" },
    { ...valid, contentType: "text/plain" },
    { ...valid, contentType: "application/json; charset=iso-8859-1" },
    { ...valid, contentEncoding: "gzip" },
    { ...valid, body: [new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])] },
  ]) assert.ok([400, 415].includes((await request(middleware, options)).status));

  const oversizeChunks = [new Uint8Array(600_000), new Uint8Array(448_577)];
  assert.equal((await request(middleware, { ...valid, body: oversizeChunks })).status, 413, "chunked body cap is enforced");
  assert.equal((await request(middleware, { ...valid, contentLength: "1048577", body: "{}" })).status, 413);
  for (const hostile of [
    { host: "attacker.example:8080" },
    { origin: "http://localhost:8080" },
    { forwardedHost: "127.0.0.1:8080" },
    { forwardedProto: "https" },
    { forwardedFor: "127.0.0.1" },
    { remoteAddress: "203.0.113.9" },
    { fetchSite: "cross-site" },
  ]) assert.equal((await request(middleware, { ...valid, ...hostile })).status, 403, JSON.stringify(hostile));
  assert.equal(store.count(), 0, "rejected requests persist nothing");
});

test("rejects malformed listing parameters, IDs, methods, and oversized requests", async t => {
  const { store } = openInboxStore(":memory:");
  t.after(() => store.close());
  const { middleware } = fixture({ store });
  for (const url of [
    "/__devcaught/local-inbox/messages?limit=0",
    "/__devcaught/local-inbox/messages?limit=01",
    "/__devcaught/local-inbox/messages?limit=51",
    "/__devcaught/local-inbox/messages?limit=1.5",
    "/__devcaught/local-inbox/messages?cursor=%ZZ",
    "/__devcaught/local-inbox/messages?query=%FF",
    "/__devcaught/local-inbox/messages?limit=1&limit=2",
    "/__devcaught/local-inbox/messages?unexpected=yes",
    `/__devcaught/local-inbox/messages?query=${"x".repeat(201)}`,
    `/__devcaught/local-inbox/messages?cursor=${"a".repeat(1_025)}`,
    "/__devcaught/local-inbox/messages/",
    "/__devcaught/local-inbox/messages/bad.id",
    "/__devcaught/local-inbox/messages/%2fprivate",
    `/__devcaught/local-inbox/messages/${"a".repeat(129)}`,
    `/__devcaught/local-inbox/messages?query=${"x".repeat(4_100)}`,
  ]) {
    const response = await request(middleware, { url });
    assert.equal(response.status, 400, url);
    assert.equal(response.fellThrough, false, url);
    assert.equal(response.headers["cache-control"], "no-store");
  }

  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "HEAD"]) {
    const response = await request(middleware, {
      url: "/__devcaught/local-inbox/messages",
      method,
      origin: "http://127.0.0.1:8080",
      fetchSite: "same-origin",
    });
    assert.equal(response.status, 405, method);
    assert.equal(response.fellThrough, false);
  }
  assert.equal((await request(middleware, { url: "/__devcaught/local-inbox/messages/no-such-id" })).status, 404);
  assert.equal((await request(middleware, { url: "/__devcaught/local-inbox/messages", method: "POST" })).status, 403);
});

test("applies the existing local listener security gate and runtime lifecycle to data routes", async () => {
  const localDataPath = "/__devcaught/local-inbox/messages";
  for (const options of [
    { host: "attacker.example:8080" },
    { origin: "http://localhost:8080" },
    { fetchSite: "cross-site" },
    { forwardedHost: "127.0.0.1:8080" },
  ]) {
    assert.equal((await request(fixture().middleware, { url: localDataPath, ...options })).status, 403);
  }
  for (const options of [
    { runtimeFailure: true },
    { livePreview: true },
    { smtpRunning: false },
    { mode: "private" as const },
    { smtpHost: "0.0.0.0" },
  ]) {
    assert.equal((await request(fixture(options).middleware, { url: localDataPath })).status, 503);
  }
  assert.equal((await request(fixture().middleware, { url: localDataPath })).status, 503, "missing storage readiness fails closed");
});
