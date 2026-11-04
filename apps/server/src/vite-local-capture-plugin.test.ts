import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createServer as createTcpServer, connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { devcaughtLocalCapturePlugin } from "./vite-local-capture-plugin.ts";

type RuntimeSlot = {
  runtime?: { http: { running: boolean }; store: { count(): number } };
  starting?: Promise<unknown>;
};
type RuntimeGlobal = typeof globalThis & { __devcaughtRuntime?: RuntimeSlot };

function setEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function assertPortClosed(port: number): Promise<void> {
  const socket = connect({ host: "127.0.0.1", port });
  const result = await Promise.race([
    once(socket, "connect").then(() => "open" as const, () => "closed" as const),
    once(socket, "error").then(() => "closed" as const),
    new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 1_000)),
  ]);
  socket.destroy();
  assert.equal(result, "closed", `port ${port} should be closed`);
}

async function smtpReply(readLine: () => Promise<string>): Promise<number> {
  let line: string;
  do {
    line = await readLine();
  } while (/^\d{3}-/.test(line));
  return Number(line.slice(0, 3));
}

async function sendSyntheticEmail(port: number, marker: string): Promise<void> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  let buffer = "";
  let failure: Error | undefined;
  const queuedLines: string[] = [];
  const lineWaiters: Array<{ resolve(line: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> = [];
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    while (true) {
      const end = buffer.indexOf("\r\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const waiter = lineWaiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else queuedLines.push(line);
    }
  });
  socket.on("error", error => {
    failure = error;
    for (const waiter of lineWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  const readLine = () => {
    if (queuedLines.length) return Promise.resolve(queuedLines.shift()!);
    if (failure) return Promise.reject(failure);
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = lineWaiters.indexOf(waiter);
          if (index >= 0) lineWaiters.splice(index, 1);
          reject(new Error("SMTP reply timed out"));
        }, 5_000),
      };
      lineWaiters.push(waiter);
    });
  };
  const reply = () => smtpReply(readLine);
  const write = (value: string) => new Promise<void>((resolve, reject) => {
    socket.write(value, error => error ? reject(error) : resolve());
  });
  const expect = async (code: number) => assert.equal(await reply(), code);

  try {
    await once(socket, "connect");
    await expect(220);
    await write("EHLO local-plugin.example.test\r\n");
    await expect(250);
    await write("MAIL FROM:<sender@example.test>\r\n");
    await expect(250);
    await write("RCPT TO:<recipient@example.test>\r\n");
    await expect(250);
    await write("DATA\r\n");
    await expect(354);
    await write([
      "From: sender@example.test",
      "To: recipient@example.test",
      `Subject: isolated local SMTP ${marker}`,
      `Message-ID: <${marker}@example.test>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Synthetic body ${marker}`,
      ".",
      "",
    ].join("\r\n"));
    await expect(250);
    await write("QUIT\r\n");
    await expect(221);
  } finally {
    socket.destroy();
  }
}

async function waitForHealth(origin: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/__devcaught/local-inbox/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return;
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Local Inbox did not become ready: ${String(lastError)}`);
}

async function postWithExplicitHost(url: string, host: string, origin: string, body: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(target.port),
      path: target.pathname,
      method: "POST",
      headers: { host, origin, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("isolated local plugin captures all three channels and shuts down without HTTP listener", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "devcaught-local-plugin-"));
  const dbPath = path.join(root, "inbox.sqlite");
  const smtpPort = await freePort();
  const httpPort = await freePort();
  const restoreEnvironment = setEnvironment({
    DEVCAUGHT_HOST: "127.0.0.1",
    DEVCAUGHT_SMTP_ROUTING_MODE: "local",
    DEVCAUGHT_SMS_ROUTING_MODE: undefined,
    DEVCAUGHT_SMTP_PORT: String(smtpPort),
    DEVCAUGHT_HTTP_PORT: String(httpPort),
    DEVCAUGHT_DB_PATH: dbPath,
    DEVCAUGHT_RETENTION_DAYS: "0",
    DEVCAUGHT_MAX_MESSAGES: "0",
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_PUBLIC_URL: undefined,
    TWILIO_ACCOUNT_SID: undefined,
  });
  let vite: ViteDevServer | undefined;

  t.after(async () => {
    try {
      await vite?.close();
    } finally {
      restoreEnvironment();
      rmSync(root, { recursive: true, force: true });
    }
  });

  vite = await createViteServer({
    configFile: false,
    root,
    appType: "custom",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [devcaughtLocalCapturePlugin()],
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  await waitForHealth(origin);

  const runtime = (globalThis as RuntimeGlobal).__devcaughtRuntime?.runtime;
  assert.ok(runtime, "real local runtime should be initialized");
  assert.equal(runtime.http.running, false, "isolated plugin does not start the HTTP listener");
  await assert.rejects(fetch(`http://127.0.0.1:${httpPort}/api/health`, { signal: AbortSignal.timeout(500) }));

  const marker = `local-plugin-${randomUUID()}`;
  const smsUrl = `${origin}/__devcaught/local-inbox/sms`;
  const smsBody = JSON.stringify({
    sender: "+14155550123",
    recipient: "+14155550199",
    text: `Synthetic SMS ${marker}`,
  });
  const smsHeaders = { origin, "content-type": "application/json" };

  const invalidOrigin = await fetch(smsUrl, {
    method: "POST",
    headers: { ...smsHeaders, origin: "http://attacker.example" },
    body: smsBody,
  });
  assert.equal(invalidOrigin.status, 403);

  const invalidHostStatus = await postWithExplicitHost(
    smsUrl,
    `attacker.example:${address.port}`,
    origin,
    smsBody,
  );
  assert.equal(invalidHostStatus, 403);

  const forwarded = await fetch(smsUrl, {
    method: "POST",
    headers: { ...smsHeaders, "x-forwarded-for": "127.0.0.1" },
    body: smsBody,
  });
  assert.equal(forwarded.status, 403);

  const smsResponse = await fetch(smsUrl, { method: "POST", headers: smsHeaders, body: smsBody });
  assert.equal(smsResponse.status, 201);
  const smsList = await fetch(`${origin}/__devcaught/local-inbox/messages?channel=sms&query=${marker}`);
  assert.equal(smsList.status, 200);
  const smsResult = await smsList.json() as { items: Array<{ sender: string; recipient: string; body: string }> };
  assert.equal(smsResult.items.length, 1);
  assert.equal(smsResult.items[0]?.sender, "+*******0123");
  assert.equal(smsResult.items[0]?.recipient, "+*******0199");

  const webhookResponse = await fetch(`${origin}/__devcaught/local-inbox/webhooks`, {
    method: "POST",
    headers: { ...smsHeaders, "user-agent": "local-plugin-test" },
    body: JSON.stringify({ event: "isolated.created", marker }),
  });
  assert.equal(webhookResponse.status, 201);
  const webhookList = await fetch(`${origin}/__devcaught/local-inbox/messages?channel=webhook&query=${marker}`);
  assert.equal(webhookList.status, 200);
  const webhookResult = await webhookList.json() as { items: Array<{ subject: string }> };
  assert.equal(webhookResult.items.length, 1);
  assert.equal(webhookResult.items[0]?.subject, "isolated.created");

  await sendSyntheticEmail(smtpPort, marker);
  const emailList = await fetch(`${origin}/__devcaught/local-inbox/messages?channel=email&query=${marker}`);
  assert.equal(emailList.status, 200);
  const emailResult = await emailList.json() as { items: Array<{ subject: string }> };
  assert.equal(emailResult.items.length, 1);
  assert.equal(emailResult.items[0]?.subject, `isolated local SMTP ${marker}`);

  await vite.close();
  vite = undefined;
  assert.equal((globalThis as RuntimeGlobal).__devcaughtRuntime, undefined, "closed runtime slot is released");
  assert.throws(() => runtime.store.count(), "SQLite connection should be closed");
  await assertPortClosed(smtpPort);
  await assert.rejects(fetch(`${origin}/__devcaught/local-inbox/health`, { signal: AbortSignal.timeout(500) }));
});
