import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { test } from "node:test";
import { InboxService } from "./ingest/inboxService.ts";
import { openInboxStore } from "./store/sqlite.ts";
import { ensureRuntime, type DevCaughtRuntime } from "./runtime.ts";

function setEnvironment(values: Record<string, string | undefined>) {
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

const row = (subject: string, createdAt: number) => ({
  type: "email" as const,
  source: "smtp" as const,
  sender: "sender@example.test",
  recipient: "developer@example.test",
  subject,
  textBody: "Your code is 482913",
  htmlBody: "",
  rawData: `raw ${subject}`,
  detections: [],
  createdAt,
});

test("local runtime routes SMTP and startup retention through the local capture scope", async t => {
  type RuntimeSlot = { runtime?: DevCaughtRuntime; starting?: Promise<DevCaughtRuntime> };
  const runtimeGlobal = globalThis as typeof globalThis & { __devcaughtRuntime?: RuntimeSlot };
  const hadRuntimeSlot = Object.hasOwn(runtimeGlobal, "__devcaughtRuntime");
  const previousRuntimeSlot = runtimeGlobal.__devcaughtRuntime;
  // Isolate ensureRuntime from an application or other test's cached instance.
  runtimeGlobal.__devcaughtRuntime = {};

  let directory: string | undefined;
  let seedStoreForCleanup: ReturnType<typeof openInboxStore>["store"] | undefined;
  let restoreEnvironment = () => {};
  const restoreSmtpMocks: Array<() => void> = [];
  let runtime: DevCaughtRuntime | undefined;
  t.after(async () => {
    const cleanupErrors: unknown[] = [];
    try { await runtime?.smtp.close(); } catch (error) { cleanupErrors.push(error); }
    try { runtime?.store.close(); } catch (error) { cleanupErrors.push(error); }
    try { seedStoreForCleanup?.close(); } catch (error) { cleanupErrors.push(error); }
    for (const restore of restoreSmtpMocks.reverse()) {
      try { restore(); } catch (error) { cleanupErrors.push(error); }
    }
    try { restoreEnvironment(); } catch (error) { cleanupErrors.push(error); }
    try {
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
    if (hadRuntimeSlot) runtimeGlobal.__devcaughtRuntime = previousRuntimeSlot;
    else delete runtimeGlobal.__devcaughtRuntime;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Runtime test cleanup failed");
  });

  const testDirectory = mkdtempSync(join(tmpdir(), "devcaught-local-runtime-"));
  directory = testDirectory;
  const dbPath = join(testDirectory, "inbox.db");
  restoreEnvironment = setEnvironment({
    DEVCAUGHT_HOST: "127.0.0.1",
    DEVCAUGHT_SMTP_ROUTING_MODE: "local",
    DEVCAUGHT_SMS_ROUTING_MODE: undefined,
    DEVCAUGHT_DB_PATH: dbPath,
    DEVCAUGHT_RETENTION_DAYS: "1",
    DEVCAUGHT_MAX_MESSAGES: "0",
    DEVCAUGHT_REQUIRE_PERSISTENT_DB: undefined,
  });

  const { store: seedStore } = openInboxStore(dbPath);
  seedStoreForCleanup = seedStore;
  seedStore.forLocalSmtpCapture().insert(row("expired local SMTP capture", 1));
  const privateInbox = seedStore.forInbox("private-inbox-a");
  const privateMessage = privateInbox.insert(row("expired private message", 1));
  seedStore.close();
  seedStoreForCleanup = undefined;

  let smtpServer: SMTPServer | undefined;
  const listen = t.mock.method(SMTPServer.prototype, "listen", function(this: SMTPServer, ...args: unknown[]) {
    smtpServer = this;
    queueMicrotask(args.at(-1) as () => void);
    return this.server;
  });
  restoreSmtpMocks.push(() => listen.mock.restore());
  const close = t.mock.method(SMTPServer.prototype, "close", function(this: SMTPServer, callback: () => void) {
    callback();
    return this;
  });
  restoreSmtpMocks.push(() => close.mock.restore());

  runtime = await ensureRuntime();
  assert.ok(smtpServer);
  assert.equal(runtime.config.smtpRoutingMode, "local");

  const localStore = runtime.store.forLocalCapture();
  const privateStore = runtime.store.forInbox("private-inbox-a");
  assert.equal(localStore.count(), 0, "startup retention prunes the expired local row");
  assert.equal(privateStore.get(privateMessage.id)?.subject, "expired private message");
  assert.equal(privateStore.count(), 1, "local startup pruning leaves expired private rows untouched");
  assert.equal(runtime.store.count(), 1);

  // runtime.inbox remains the root service used by existing HTTP/webhook/SMS
  // consumers; only the SMTP receiver receives the local-scoped service.
  // Root records intentionally have no automatic retention in local SMTP
  // mode, preventing them from pruning either trusted SMTP or private rows.
  assert.ok(runtime.inbox instanceof InboxService);
  assert.equal((runtime.inbox as unknown as { store: unknown }).store, runtime.store);

  const trustedExpired = runtime.store.forLocalSmtpCapture().insert(row("expired trusted after startup", 1));
  const rootTestEmail = runtime.inbox.ingest({ ...row("root test email", 2), source: "test" });
  const rootWebhook = runtime.inbox.ingest({
    type: "webhook",
    source: "http",
    sender: "provider@example.test",
    recipient: "developer@example.test",
    subject: "root webhook",
    textBody: "payload",
    htmlBody: "",
    rawData: "{\"event\":\"local-test\"}",
    createdAt: 3,
  });
  assert.ok(runtime.store.get(rootTestEmail.id));
  assert.ok(runtime.store.get(rootWebhook.id));
  assert.ok(runtime.store.forLocalSmtpCapture().get(trustedExpired.id));
  assert.ok(privateStore.get(privateMessage.id));
  assert.equal(runtime.store.count(), 4, "root post-ingest retention is disabled in local SMTP mode");

  const session = {
    envelope: {
      mailFrom: { address: "sender@example.test", args: {} },
      rcptTo: [],
    },
  } as unknown as SMTPServerSession;
  const recipient = { address: "arbitrary@example.test", args: {} };
  await new Promise<void>((resolve, reject) => {
    smtpServer!.onRcptTo(recipient, session, error => {
      if (error) reject(error);
      else {
        session.envelope.rcptTo.push(recipient);
        resolve();
      }
    });
  });

  const stream = new PassThrough() as SMTPServerDataStream;
  const delivered = new Promise<Error | null | undefined>(resolve => {
    smtpServer!.onData(stream, session, resolve);
  });
  stream.end("From: sender@example.test\r\nTo: arbitrary@example.test\r\nSubject: Local SMTP\r\n\r\nCode 482913");
  assert.equal(await delivered, undefined);

  const captured = localStore.listPage({ limit: 10 }).items;
  assert.equal(captured.length, 1, "subsequent local SMTP retention removes the expired trusted row");
  assert.ok(captured.some(message => message.subject === "Local SMTP"));
  const smtpMessage = captured.find(message => message.subject === "Local SMTP");
  assert.equal(localStore.getLocalSmtp(smtpMessage!.id)?.subject, "Local SMTP");
  assert.equal(runtime.store.count(), 4);
  assert.equal(privateStore.count(), 1);
  assert.equal(localStore.get(privateMessage.id), null);
  assert.equal(privateStore.get(privateMessage.id)?.subject, "expired private message");
});
