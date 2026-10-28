import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { SMTPConnection } from "smtp-server/lib/smtp-connection.js";
import type { NormalizedMessage } from "../../../../packages/shared/src/types.ts";
import type { InboxService } from "../ingest/inboxService.ts";
import {
  startSmtpReceiver,
  type SmtpInboxFactory,
  type SmtpRecipientResolver,
} from "./receiver.ts";

const SMTP_ERROR = "SMTP service temporarily unavailable";
const SENSITIVE_TEST_DETAIL = "SYNTHETIC_PRIVATE_DETAIL";

type Delivery = { inboxId: string; message: NormalizedMessage };
type HarnessOptions = {
  limit?: number;
  resolveRecipient?: SmtpRecipientResolver;
  inboxForId?: SmtpInboxFactory;
};

function responseCode(error: Error | null | undefined): number | undefined {
  return (error as (Error & { responseCode?: number }) | null | undefined)?.responseCode;
}

async function createHarness(t: TestContext, options: HarnessOptions = {}) {
  const deliveries: Delivery[] = [];
  let fallbackIngestions = 0;
  let factoryCalls = 0;
  let server: SMTPServer | undefined;

  const fallbackInbox = {
    ingest() {
      fallbackIngestions++;
    },
  } as unknown as InboxService;

  const resolveRecipient = options.resolveRecipient ?? (async (address: string) =>
    address.toLowerCase() === "registered@synthetic.invalid" ? "inbox-synthetic" : null);

  const inboxForId = options.inboxForId ?? ((inboxId: string) => {
    factoryCalls++;
    return {
      ingest(message: NormalizedMessage) {
        deliveries.push({ inboxId, message });
      },
    } as unknown as InboxService;
  });

  // The listener mock is restored before any assertions or callback driving.
  // The mock callback makes startSmtpReceiver finish without binding a socket.
  const listenMock = t.mock.method(
    SMTPServer.prototype,
    "listen",
    function (this: SMTPServer, ...args: unknown[]) {
      server = this;
      queueMicrotask(args.at(-1) as () => void);
      return this.server;
    },
  );
  const logMock = t.mock.method(console, "log", () => {});
  try {
    await startSmtpReceiver(
      {
        host: "127.0.0.1",
        smtpPort: 0,
        httpPort: 0,
        dbPath: ":memory:",
        smtpSizeLimit: options.limit ?? 4096,
        retentionDays: 0,
        maxMessages: 0,
      },
      fallbackInbox,
      resolveRecipient,
      inboxForId,
    );
  } finally {
    listenMock.mock.restore();
    logMock.mock.restore();
  }

  assert.ok(server, "SMTPServer instance should be captured by the listener mock");
  return {
    server,
    deliveries,
    fallbackInbox,
    fallbackIngestions: () => fallbackIngestions,
    factoryCalls: () => factoryCalls,
  };
}

function createSession(): SMTPServerSession {
  return {
    envelope: {
      mailFrom: { address: "sender@synthetic.invalid", args: {} },
      rcptTo: [],
    },
  } as unknown as SMTPServerSession;
}

function acceptRecipient(
  server: SMTPServer,
  session: SMTPServerSession,
  address: string,
): Promise<Error | null | undefined> {
  return new Promise((resolve) => {
    const recipient = { address, args: {} };
    server.onRcptTo(recipient, session, (error) => {
      if (!error) session.envelope.rcptTo.push(recipient);
      resolve(error);
    });
  });
}

function sendData(
  server: SMTPServer,
  session: SMTPServerSession,
  rawMessage: string,
  failStream = false,
): Promise<Error | null | undefined> {
  assert.ok(session.envelope.rcptTo.length > 0, "DATA requires an accepted synthetic recipient");
  const stream = new PassThrough() as SMTPServerDataStream;
  const result = new Promise<Error | null | undefined>((resolve) => {
    server.onData(stream, session, resolve);
  });
  if (failStream) stream.destroy(new Error("SYNTHETIC_STREAM_FAILURE"));
  else stream.end(rawMessage);
  return result;
}

function syntheticEmail(to: string, body = "Synthetic verification code: 482913.") {
  return [
    "From: sender@synthetic.invalid",
    `To: ${to}`,
    "Subject: Synthetic SMTP regression",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].join("\r\n");
}

function createProtocolHarness(server: SMTPServer) {
  const replies: Array<{ code: number; message: string }> = [];
  const connection = Object.create(SMTPConnection.prototype) as SMTPConnection;
  Object.assign(connection, {
    _server: server,
    _ready: true,
    _closing: false,
    _closed: false,
    _upgrading: false,
    _nextHandler: false,
    _handlerPending: false,
    _unrecognizedCommands: 0,
    _unauthenticatedCommands: 0,
    _maxAllowedUnauthenticatedCommands: false,
    session: { user: false },
    name: "synthetic-client.invalid",
    clientHostname: "synthetic-client.invalid",
    hostNameAppearsAs: false,
    secure: false,
    _resetSession() {},
    _proxyCommandAllowed() { return false; },
    _whenWritable(next: () => void) { next(); },
    send(code: number, data?: string | string[] | null) {
      replies.push({ code, message: Array.isArray(data) ? data.join("\n") : data ?? "" });
    },
  });
  return { connection, replies };
}

function issueCommand(connection: SMTPConnection, command: string): Promise<void> {
  return new Promise((resolve) => connection._onCommand(Buffer.from(command), resolve));
}

describe("SMTP receiver offline callbacks", { concurrency: false }, () => {
  it("does not advertise STARTTLS in the EHLO response", async (t) => {
    const h = await createHarness(t);
    const protocol = createProtocolHarness(h.server);

    protocol.connection.handler_EHLO(Buffer.from("EHLO synthetic-client.invalid"), () => {});

    assert.equal(protocol.replies[0]?.code, 250);
    assert.doesNotMatch(protocol.replies[0]?.message ?? "", /STARTTLS/i);
    assert.equal(h.server.options.hideSTARTTLS, true);
  });

  it("rejects direct STARTTLS and AUTH commands", async (t) => {
    const h = await createHarness(t);
    const protocol = createProtocolHarness(h.server);

    await issueCommand(protocol.connection, "STARTTLS");
    assert.equal(protocol.replies[0]?.code, 500);
    assert.match(protocol.replies[0]?.message ?? "", /command not recognized/i);

    await issueCommand(protocol.connection, "AUTH PLAIN synthetic-auth-data");
    assert.equal(protocol.replies[1]?.code, 500);
    assert.match(protocol.replies[1]?.message ?? "", /command not recognized/i);
    assert.deepEqual(h.server.options.disabledCommands, ["AUTH", "STARTTLS"]);
  });

  it("parses, normalizes, and ingests a synthetic email", async (t) => {
    const h = await createHarness(t);
    const session = createSession();
    assert.equal(await acceptRecipient(h.server, session, "registered@synthetic.invalid"), undefined);

    assert.equal(await sendData(h.server, session, syntheticEmail("registered@synthetic.invalid")), undefined);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0]?.inboxId, "inbox-synthetic");
    assert.equal(h.deliveries[0]?.message.type, "email");
    assert.equal(h.deliveries[0]?.message.source, "smtp");
    assert.equal(h.deliveries[0]?.message.sender, "sender@synthetic.invalid");
    assert.equal(h.deliveries[0]?.message.recipient, "registered@synthetic.invalid");
    assert.equal(h.deliveries[0]?.message.subject, "Synthetic SMTP regression");
    assert.equal(h.deliveries[0]?.message.textBody, "Synthetic verification code: 482913.");
    assert.equal(h.fallbackIngestions(), 0);
  });

  it("routes by envelope recipient rather than the MIME To header", async (t) => {
    const h = await createHarness(t);
    const session = createSession();
    assert.equal(await acceptRecipient(h.server, session, "registered@synthetic.invalid"), undefined);

    assert.equal(await sendData(h.server, session, syntheticEmail("spoofed@synthetic.invalid")), undefined);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0]?.inboxId, "inbox-synthetic");
    assert.equal(h.deliveries[0]?.message.recipient, "spoofed@synthetic.invalid");
    assert.equal(h.fallbackIngestions(), 0);
  });

  it("rejects an unknown envelope recipient with SMTP 550 and no ingestion", async (t) => {
    const h = await createHarness(t);
    const session = createSession();

    const error = await acceptRecipient(h.server, session, "unknown@synthetic.invalid");

    assert.equal(responseCode(error), 550);
    assert.equal(session.envelope.rcptTo.length, 0);
    assert.equal(h.factoryCalls(), 0);
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.fallbackIngestions(), 0);
  });

  it("rejects oversized DATA with SMTP 552 and no ingestion", async (t) => {
    const h = await createHarness(t, { limit: 1024 });
    const session = createSession();
    assert.equal(await acceptRecipient(h.server, session, "registered@synthetic.invalid"), undefined);

    const error = await sendData(
      h.server,
      session,
      syntheticEmail("registered@synthetic.invalid", "x".repeat(2048)),
    );

    assert.equal(responseCode(error), 552);
    assert.equal(h.factoryCalls(), 0);
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.fallbackIngestions(), 0);
  });

  it("rejects an errored DATA stream with sanitized SMTP 451 and no ingestion", async (t) => {
    const h = await createHarness(t);
    const session = createSession();
    assert.equal(await acceptRecipient(h.server, session, "registered@synthetic.invalid"), undefined);

    const error = await sendData(h.server, session, "", true);

    assert.equal(responseCode(error), 451);
    assert.equal(error?.message, SMTP_ERROR);
    assert.doesNotMatch(error?.message ?? "", /SYNTHETIC_STREAM_FAILURE/);
    assert.equal(h.factoryCalls(), 0);
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.fallbackIngestions(), 0);
  });

  it("sanitizes recipient resolver failures without fallback delivery", async (t) => {
    const h = await createHarness(t, {
      resolveRecipient: async () => {
        throw new Error(SENSITIVE_TEST_DETAIL);
      },
    });
    const session = createSession();

    const error = await acceptRecipient(h.server, session, "registered@synthetic.invalid");

    assert.equal(responseCode(error), 451);
    assert.equal(error?.message, SMTP_ERROR);
    assert.doesNotMatch(error?.message ?? "", /SYNTHETIC_PRIVATE_DETAIL/);
    assert.equal(session.envelope.rcptTo.length, 0);
    assert.equal(h.factoryCalls(), 0);
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.fallbackIngestions(), 0);
  });

  it("sanitizes inbox sink failures without fallback delivery", async (t) => {
    const h = await createHarness(t, {
      inboxForId: () => ({
        ingest() {
          throw new Error(SENSITIVE_TEST_DETAIL);
        },
      } as unknown as InboxService),
    });
    const session = createSession();
    assert.equal(await acceptRecipient(h.server, session, "registered@synthetic.invalid"), undefined);

    const error = await sendData(h.server, session, syntheticEmail("registered@synthetic.invalid"));

    assert.equal(responseCode(error), 451);
    assert.equal(error?.message, SMTP_ERROR);
    assert.doesNotMatch(error?.message ?? "", /SYNTHETIC_PRIVATE_DETAIL/);
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.fallbackIngestions(), 0);
  });
});
