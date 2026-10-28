import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import type { ListenerStatus } from "../../../../packages/shared/src/types.ts";
import type { DevCaughtConfig } from "../config.ts";
import { portInUseMessage } from "../config.ts";
import type { InboxService } from "../ingest/inboxService.ts";
import { normalizeParsedMail } from "../ingest/normalizeEmail.ts";

export interface SmtpRuntime {
  status: ListenerStatus;
  close(): Promise<void>;
}

/**
 * Resolve an SMTP envelope recipient using a trusted registration source.
 * null means the recipient is unknown; thrown errors mean lookup failed.
 * Never derive inbox ownership from message headers.
 */
export type SmtpRecipientResolver = (
  recipientAddress: string,
) => Promise<string | null>;

/**
 * Return an inbox service bound to the verified inbox ID.
 * Implementations must use tenant-scoped storage, never the global inbox.
 */
export type SmtpInboxFactory = (
  inboxId: string,
) => InboxService;

// Bound registry latency without adding deployment configuration. Resolver work
// cannot be forcibly cancelled, but late results never enter transaction state.
const LOOKUP_TIMEOUT_MS = 5_000;
const DATA_IDLE_TIMEOUT_MS = 30_000;
const temporaryFailure = () => smtpError(451, "SMTP service temporarily unavailable");
function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

function lookup(resolver: SmtpRecipientResolver, address: string, signal: AbortSignal) {
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, id: string | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(id);
    };
    const abort = () => finish(temporaryFailure());
    const timer = setTimeout(abort, LOOKUP_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(() => resolver(address)).then(
      id => finish(null, id),
      () => finish(temporaryFailure()),
    );
  });
}

// Exported for focused stream lifecycle tests without opening a listener.
export function collectRaw(stream: NodeJS.ReadableStream, limit: number, controller: AbortController) {
  let chunks: Buffer[] = [];
  let received = 0;
  let exceeded = false;
  let discard = false;
  let cancel = () => {};
  const promise = new Promise<{ raw: Buffer; error?: Error }>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream.off("data", data);
      stream.off("end", end);
      stream.off("error", fail);
      stream.off("close", close);
      stream.off("aborted", fail);
      if (error && (error as Error & { responseCode?: number }).responseCode !== 552) controller.abort();
      const raw = error || discard ? Buffer.alloc(0) : Buffer.concat(chunks, received);
      chunks = [];
      resolve({ raw, error });
    };
    const fail = () => finish(temporaryFailure());
    cancel = fail;
    const close = () => fail();
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { fail(); stream.resume(); }, DATA_IDLE_TIMEOUT_MS);
    };
    const data = (chunk: Buffer) => {
      arm();
      if (discard || exceeded) return;
      if (chunk.length > limit - received) {
        exceeded = true;
        chunks = [];
        return;
      }
      // Copy so small views cannot retain a larger underlying allocation.
      chunks.push(Buffer.from(chunk));
      received += chunk.length;
    };
    const end = () => finish(
      exceeded || Boolean((stream as { sizeExceeded?: boolean }).sizeExceeded)
        ? smtpError(552, "Message exceeds size limit") : undefined,
    );
    stream.on("error", fail);
    stream.on("close", close);
    stream.on("aborted", fail);
    stream.on("end", end);
    stream.on("data", data);
    arm();
  });
  return { promise, cancel: () => cancel(), discard() { discard = true; chunks = []; } };
}

export async function startSmtpReceiver(
  config: DevCaughtConfig,
  _inbox: InboxService,
  resolveRecipient?: SmtpRecipientResolver,
  inboxForId?: SmtpInboxFactory,
): Promise<SmtpRuntime> {
  const status: ListenerStatus = {
    running: false,
    host: config.host,
    port: config.smtpPort,
    error: null,
  };

  // SMTPServer replaces the envelope on RSET/new MAIL; weak keys isolate
  // transactions, including multiple transactions on a single connection.
  const accepted = new WeakMap<object, Map<string, string>>();
  const active = new WeakMap<object, () => void>();
  const server = new SMTPServer({
    banner: "DevCaught",
    disabledCommands: ["AUTH", "STARTTLS"],
    authOptional: true,
    hideSTARTTLS: true,
    size: config.smtpSizeLimit,
    logger: false,
    onClose(session) {
      active.get(session)?.();
      active.delete(session);
      accepted.delete(session.envelope);
    },
    onRcptTo(address, session, callback) {
      const envelope = session.envelope;
      const controller = new AbortController();
      active.set(session, () => controller.abort());
      const validate = async () => {
        if (!resolveRecipient) throw temporaryFailure();
        const id = await lookup(resolveRecipient, address.address, controller.signal);
        if (controller.signal.aborted) throw temporaryFailure();
        if (!id) throw smtpError(550, "Recipient not registered");
        const mapping = accepted.get(envelope) ?? new Map<string, string>();
        const previous = mapping.get(address.address);
        if (previous && previous !== id) throw temporaryFailure();
        mapping.set(address.address, id);
        accepted.set(envelope, mapping);
      };
      // Completion is outside the validation catch, so callback exceptions
      // cannot cause a second callback.
      void validate().then(
        () => { active.delete(session); callback(); },
        error => { active.delete(session); callback(error); },
      );
    },
    onData(stream, session, callback) {
      const controller = new AbortController();
      const collected = collectRaw(stream, config.smtpSizeLimit, controller);
      active.set(session, () => { controller.abort(); collected.cancel(); });
      const mapping = accepted.get(session.envelope);
      accepted.delete(session.envelope);
      const recipients = session.envelope.rcptTo.map(recipient => recipient.address);
      const process = async () => {
        let validationError: Error | undefined;
        let verifiedInboxId: string | undefined;
        try {
          if (!resolveRecipient || !mapping || recipients.length === 0) throw temporaryFailure();
          const ids = await Promise.all(recipients.map(address =>
            lookup(resolveRecipient, address, controller.signal),
          ));
          if (ids.some(id => !id)) throw smtpError(550, "Recipient not registered");
          if (ids.some((id, index) => id !== mapping.get(recipients[index]!))) throw temporaryFailure();
          if (new Set(ids).size !== 1) throw smtpError(550, "Multiple inbox delivery rejected");
          verifiedInboxId = ids[0]!;
          if (!inboxForId) throw temporaryFailure();
        } catch (error) {
          validationError = error instanceof Error ? error : temporaryFailure();
          collected.discard();
          controller.abort();
        }
        const { raw, error } = await collected.promise;
        if (validationError) throw validationError;
        if (error) throw error;
        if (!verifiedInboxId || !inboxForId) throw temporaryFailure();
        try {
          const parsed = await simpleParser(raw);
          if (controller.signal.aborted) throw temporaryFailure();
          // DATA may take time to arrive and parse: revalidate immediately before
          // synchronous scoped storage, not just when DATA starts.
          const finalIds = await Promise.all(recipients.map(address => lookup(resolveRecipient!, address, controller.signal)));
          if (finalIds.some(id => id !== verifiedInboxId) || controller.signal.aborted) throw temporaryFailure();
          const scopedInbox = inboxForId(verifiedInboxId);
          scopedInbox.ingest(normalizeParsedMail(parsed, raw.toString("utf8"), "smtp"));
        } catch { throw temporaryFailure(); }
      };
      void process().then(
        () => { active.delete(session); callback(); },
        error => { active.delete(session); callback(error); },
      );
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("error", onError);
        reject(error);
      };
      server.on("error", onError);
      server.listen(config.smtpPort, config.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.server.address();
    if (address && typeof address === "object") {
      status.port = address.port;
    }
    status.running = true;
    console.log(`[DevCaught] SMTP listening on ${status.host}:${status.port}`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    status.running = false;
    status.error =
      err.code === "EADDRINUSE"
        ? portInUseMessage("SMTP", config.host, config.smtpPort, "DEVCAUGHT_SMTP_PORT")
        : err.message || "Failed to start SMTP server";
    console.error(`[DevCaught] ${status.error}`);
  }

  return {
    status,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
