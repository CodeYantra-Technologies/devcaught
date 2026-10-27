import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { SMTPServer, type SMTPServerSession, type SMTPServerDataStream } from "smtp-server";
import { InboxService } from "../ingest/inboxService.ts";
import { openInboxStore } from "../store/sqlite.ts";
import { collectRaw, startSmtpReceiver, type SmtpRecipientResolver, type SmtpInboxFactory } from "./receiver.ts";

// Raw SMTP distinguishes RCPT failures from DATA failures and deliberately
// omits MAIL SIZE, exercising actual DATA size enforcement.
class Client {
  private buffer = "";
  private replies: string[] = [];
  private pending?: { resolve(value: string): void; reject(error: Error): void };
  private failure?: Error;
  readonly socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setTimeout(8_000, () => socket.destroy(new Error("SMTP test client timeout")));
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\r\n")) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (!/^\d{3} /.test(line)) continue;
        if (this.pending) {
          const { resolve } = this.pending;
          this.pending = undefined;
          resolve(line);
        } else this.replies.push(line);
      }
    });
    const fail = (error: Error) => {
      this.failure = error;
      this.pending?.reject(error);
      this.pending = undefined;
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("SMTP connection closed")));
  }
  reply(): Promise<string> {
    const line = this.replies.shift();
    if (line) return Promise.resolve(line);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  async command(command: string, code: number) {
    this.socket.write(command + "\r\n");
    const reply = await this.reply();
    assert.equal(Number(reply.slice(0, 3)), code, reply);
    assert.doesNotMatch(reply, /private lookup detail|private storage detail/);
  }
  async envelope(recipients = ["b@example.test"]) {
    await this.command("MAIL FROM:<sender@example.test>", 250);
    for (const address of recipients) await this.command(`RCPT TO:<${address}>`, 250);
  }
  async data(code = 250, text = "Your verification code is 482913.") {
    await this.command("DATA", 354);
    await this.command(
      `From: sender@example.test\r\nTo: a@example.test\r\nCc: attacker@example.test\r\nSubject: Scoped OTP\r\n\r\n${text}\r\n.`,
      code,
    );
  }
}

const resolver: SmtpRecipientResolver = async address => {
  if (address === "a@example.test") return "inbox-a";
  if (["b@example.test", "alias@example.test"].includes(address)) return "inbox-b";
  return null;
};

async function fixture(t: TestContext, options: {
  resolve?: SmtpRecipientResolver | null;
  factory?: SmtpInboxFactory | null;
  limit?: number;
} = {}) {
  const { store } = openInboxStore(":memory:");
  const sockets: Socket[] = [];
  const smtp = await startSmtpReceiver({
    host: "127.0.0.1", smtpPort: 0, httpPort: 0, dbPath: ":memory:",
    smtpSizeLimit: options.limit ?? 4096, retentionDays: 0, maxMessages: 0,
  }, new InboxService(store.forInbox("inbox-a")),
  options.resolve === null ? undefined : options.resolve ?? resolver,
  options.factory === null ? undefined : options.factory ?? (id => new InboxService(store.forInbox(id))));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await smtp.close();
    store.close();
  });
  assert.equal(smtp.status.running, true, smtp.status.error ?? "SMTP startup failed");
  const client = new Client(connect({ host: "127.0.0.1", port: smtp.status.port }));
  sockets.push(client.socket);
  assert.match(await client.reply(), /^220 /);
  await client.command("EHLO test.example", 250);
  return { client, store };
}

async function recovery(client: Client, store: ReturnType<typeof openInboxStore>["store"]) {
  assert.equal(store.count(), 0);
  await client.command("RSET", 250);
  await client.envelope();
  await client.data();
  assert.equal(store.forInbox("inbox-b").count(), 1);
  assert.equal(store.forInbox("inbox-a").count(), 0);
}

describe("SMTP receiver", { timeout: 15_000 }, () => {
  it("routes by envelope despite spoofed headers and detects the OTP", async t => {
    const { client, store } = await fixture(t);
    await client.envelope();
    await client.data();
    assert.equal(store.forInbox("inbox-a").count(), 0);
    const messages = store.forInbox("inbox-b").list();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.source, "smtp");
    assert.equal(messages[0]?.detections[0]?.value, "482913");
    assert.ok(!("rawData" in messages[0]!));
    assert.match(store.forInbox("inbox-b").getRaw(messages[0]!.id)!, /482913/);
  });

  it("delivers multiple recipients assigned to one inbox exactly once", async t => {
    const { client, store } = await fixture(t);
    await client.envelope(["b@example.test", "alias@example.test"]);
    await client.data();
    assert.equal(store.count(), 1);
    assert.equal(store.forInbox("inbox-b").count(), 1);
  });

  it("rejects an unknown RCPT with exact 550 and permits recovery", async t => {
    const { client, store } = await fixture(t);
    await client.command("MAIL FROM:<sender@example.test>", 250);
    await client.command("RCPT TO:<unknown@example.test>", 550);
    // No accepted recipient: DATA would be a protocol error, not a DATA validation test.
    await recovery(client, store);
  });

  it("rejects missing registry at RCPT with exact 451", async t => {
    const { client, store } = await fixture(t, { resolve: null });
    await client.command("MAIL FROM:<sender@example.test>", 250);
    await client.command("RCPT TO:<b@example.test>", 451);
    assert.equal(store.count(), 0);
  });

  it("rejects mixed inbox IDs at DATA with exact 550, drains, and recovers", async t => {
    const { client, store } = await fixture(t);
    await client.envelope(["a@example.test", "b@example.test"]);
    await client.data(550, "x".repeat(60_000));
    await recovery(client, store);
  });

  for (const phase of ["RCPT", "DATA"] as const) {
    for (const failure of ["exception", "timeout"] as const) {
      it(`returns 451 for ${phase} lookup ${failure}, ignores late results, and recovers`, async t => {
        let calls = 0;
        let late: ((id: string) => void) | undefined;
        const { client, store } = await fixture(t, { resolve: async address => {
          calls++;
          if (calls === (phase === "RCPT" ? 1 : 2)) {
            if (failure === "exception") throw new Error("private lookup detail");
            return new Promise<string>(resolve => { late = resolve; });
          }
          return resolver(address);
        } });
        if (phase === "RCPT") {
          await client.command("MAIL FROM:<sender@example.test>", 250);
          await client.command("RCPT TO:<b@example.test>", 451);
        } else {
          await client.envelope();
          await client.data(451);
        }
        late?.("inbox-a");
        await recovery(client, store);
      });
    }
  }

  for (const next of ["inbox-a", null]) {
    it(`rejects DATA ownership ${next === null ? "removal with 550" : "change with 451"}`, async t => {
      let calls = 0;
      const { client, store } = await fixture(t, { resolve: async address =>
        ++calls === 2 ? next : resolver(address),
      });
      await client.envelope();
      await client.data(next === null ? 550 : 451);
      await recovery(client, store);
    });
  }

  for (const missing of [true, false]) {
    it(`returns 451 for ${missing ? "missing" : "throwing"} scoped factory with no fallback`, async t => {
      const { client, store } = await fixture(t, { factory: missing ? null : () => {
        throw new Error("private storage detail");
      } });
      await client.envelope();
      await client.data(451);
      assert.equal(store.count(), 0);
      await client.command("NOOP", 250);
    });
  }

  it("returns 451 for a storage insertion failure without leaking details", async t => {
    const { client, store } = await fixture(t, { factory: () => ({
      ingest() { throw new Error("private storage detail"); },
    }) as unknown as InboxService });
    await client.envelope();
    await client.data(451);
    assert.equal(store.count(), 0);
  });

  it("rejects oversized DATA without declared SIZE with exact 552 and recovers", async t => {
    const { client, store } = await fixture(t);
    await client.envelope();
    await client.data(552, "x".repeat(60_000));
    await recovery(client, store);
  });
});

describe("bounded SMTP DATA collector", { timeout: 2_000 }, () => {
  it("accepts exactly the limit and removes listeners", async () => {
    const stream = new PassThrough();
    const collected = collectRaw(stream, 32, new AbortController());
    stream.end(Buffer.alloc(32));
    const result = await collected.promise;
    assert.equal(result.raw.length, 32);
    assert.equal(result.error, undefined);
    for (const event of ["data", "end", "error", "close", "aborted"]) assert.equal(stream.listenerCount(event), 0);
  });

  it("discards overflow without concatenating an oversized buffer and drains", async t => {
    const stream = new PassThrough();
    const concat = t.mock.method(Buffer, "concat");
    const collected = collectRaw(stream, 32, new AbortController());
    stream.write(Buffer.alloc(32));
    for (let i = 0; i < 100; i++) stream.write(Buffer.alloc(1024));
    stream.end();
    const result = await collected.promise;
    assert.equal((result.error as Error & { responseCode: number }).responseCode, 552);
    assert.equal(result.raw.length, 0);
    assert.equal(concat.mock.callCount(), 0);
    assert.equal(stream.readableEnded, true);
  });

  it("drains discarded input without retaining it", async () => {
    const stream = new PassThrough();
    const collected = collectRaw(stream, 32, new AbortController());
    collected.discard();
    stream.end(Buffer.alloc(1024));
    assert.equal((await collected.promise).raw.length, 0);
    assert.equal(stream.readableEnded, true);
  });

  for (const event of ["error", "close", "aborted"]) {
    it(`settles once on premature ${event}, cancels lookups, and removes listeners`, async () => {
      const stream = new PassThrough();
      const controller = new AbortController();
      const collected = collectRaw(stream, 32, controller);
      stream.emit(event, new Error("private storage detail"));
      const result = await collected.promise;
      assert.equal((result.error as Error & { responseCode: number }).responseCode, 451);
      assert.equal(controller.signal.aborted, true);
      assert.equal(result.raw.length, 0);
      for (const name of ["data", "end", "error", "close", "aborted"]) assert.equal(stream.listenerCount(name), 0);
      stream.destroy();
    });
  }

  it("bounds idle DATA and clears its timer", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stream = new PassThrough();
    const controller = new AbortController();
    const collected = collectRaw(stream, 32, controller);
    t.mock.timers.tick(30_000);
    assert.equal((await collected.promise).error?.message, "SMTP service temporarily unavailable");
    assert.equal(controller.signal.aborted, true);
    assert.equal(stream.listenerCount("data"), 0);
    stream.destroy();
  });
});

// Exercise the actual hooks without sockets as well. Only accepted RCPTs are
// added to the envelope, matching SMTPServer's protocol lifecycle.
async function handlers(t: TestContext, resolve: SmtpRecipientResolver = resolver,
  factory?: SmtpInboxFactory | null) {
  const { store } = openInboxStore(":memory:");
  t.after(() => store.close());
  let server!: SMTPServer;
  const listen = t.mock.method(SMTPServer.prototype, "listen", function(this: SMTPServer, ...args: unknown[]) {
    server = this;
    queueMicrotask(args.at(-1) as () => void);
    return this.server;
  });
  try {
    await startSmtpReceiver({
      host: "127.0.0.1", smtpPort: 0, httpPort: 0, dbPath: ":memory:",
      smtpSizeLimit: 4096, retentionDays: 0, maxMessages: 0,
    }, new InboxService(store.forInbox("inbox-a")), resolve,
    factory === null ? undefined : factory ?? (id => new InboxService(store.forInbox(id))));
  } finally { listen.mock.restore(); }
  const session = { envelope: { mailFrom: { address: "sender@example.test", args: {} }, rcptTo: [] } } as unknown as SMTPServerSession;
  const rcpt = (address = "b@example.test") => new Promise<Error | null | undefined>(resolve => {
    const recipient = { address, args: {} };
    server.onRcptTo(recipient, session, error => {
      if (!error) session.envelope.rcptTo.push(recipient);
      resolve(error);
    });
  });
  const data = () => {
    assert.ok(session.envelope.rcptTo.length > 0, "DATA needs an accepted RCPT");
    const stream = new PassThrough() as SMTPServerDataStream;
    let callbacks = 0;
    const result = new Promise<Error | null | undefined>(resolve => {
      server.onData(stream, session, error => { callbacks++; resolve(error); });
    });
    stream.end("From: sender@example.test\r\nTo: a@example.test\r\n\r\nCode: 482913");
    return { result, stream, callbacks: () => callbacks };
  };
  return { server, session, store, rcpt, data };
}

const responseCode = (error: Error | null | undefined) =>
  (error as (Error & { responseCode?: number }) | undefined)?.responseCode;

describe("SMTP hooks without network listeners", { timeout: 2_000 }, () => {
  it("persists through the resolved scoped factory only", async t => {
    const h = await handlers(t);
    assert.equal(await h.rcpt(), undefined);
    const delivery = h.data();
    assert.equal(await delivery.result, undefined);
    assert.equal(delivery.callbacks(), 1);
    assert.equal(h.store.forInbox("inbox-a").count(), 0);
    assert.equal(h.store.forInbox("inbox-b").count(), 1);
  });

  it("rejects mixed accepted recipients at DATA and consumes the stream", async t => {
    const h = await handlers(t);
    assert.equal(await h.rcpt("a@example.test"), undefined);
    assert.equal(await h.rcpt(), undefined);
    const delivery = h.data();
    assert.equal(responseCode(await delivery.result), 550);
    assert.equal(delivery.stream.readableEnded, true);
    assert.equal(delivery.callbacks(), 1);
    assert.equal(h.store.count(), 0);
  });

  it("rejects ownership changes without rerouting", async t => {
    let calls = 0;
    const h = await handlers(t, async () => ++calls === 1 ? "inbox-b" : "inbox-a");
    await h.rcpt();
    assert.equal(responseCode(await h.data().result), 451);
    assert.equal(h.store.count(), 0);
  });

  it("returns exact 550 for an unknown RCPT without accepting it", async t => {
    const h = await handlers(t, async () => null);
    assert.equal(responseCode(await h.rcpt()), 550);
    assert.equal(h.session.envelope.rcptTo.length, 0);
    assert.equal(h.store.count(), 0);
  });

  it("sanitizes resolver exceptions", async t => {
    const h = await handlers(t, async () => { throw new Error("private lookup detail"); });
    const error = await h.rcpt();
    assert.equal(responseCode(error), 451);
    assert.doesNotMatch(error!.message, /private lookup detail/);
  });

  for (const phase of ["RCPT", "DATA"]) {
    it(`expires ${phase} lookups once and ignores late resolutions`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let calls = 0;
      let late!: (id: string) => void;
      const h = await handlers(t, async () => {
        if (++calls === (phase === "RCPT" ? 1 : 2)) return new Promise<string>(resolve => { late = resolve; });
        return "inbox-b";
      });
      let result: Promise<Error | null | undefined>;
      let delivery: ReturnType<typeof h.data> | undefined;
      if (phase === "RCPT") result = h.rcpt();
      else { await h.rcpt(); delivery = h.data(); result = delivery.result; }
      await Promise.resolve();
      t.mock.timers.tick(5_000);
      assert.equal(responseCode(await result), 451);
      late("inbox-a");
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(h.store.count(), 0);
      if (delivery) assert.equal(delivery.callbacks(), 1);
    });
  }

  it("requires scoped storage and never falls back to the supplied inbox", async t => {
    const h = await handlers(t, resolver, null);
    await h.rcpt();
    assert.equal(responseCode(await h.data().result), 451);
    assert.equal(h.store.count(), 0);
  });
});
