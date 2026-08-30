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

function collectRaw(stream: NodeJS.ReadableStream): Promise<{ raw: Buffer; sizeExceeded: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    stream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      chunks.push(chunk);
    });
    stream.on("end", () => {
      const sizeExceeded = Boolean((stream as { sizeExceeded?: boolean }).sizeExceeded);
      resolve({ raw: Buffer.concat(chunks, received), sizeExceeded });
    });
    stream.on("error", reject);
  });
}

export async function startSmtpReceiver(
  config: DevCaughtConfig,
  inbox: InboxService,
): Promise<SmtpRuntime> {
  const status: ListenerStatus = {
    running: false,
    host: config.host,
    port: config.smtpPort,
    error: null,
  };

  const server = new SMTPServer({
    banner: "DevCaught",
    disabledCommands: ["AUTH"],
    authOptional: true,
    hideSTARTTLS: true,
    size: config.smtpSizeLimit,
    logger: false,
    onData(stream, _session, callback) {
      void (async () => {
        try {
          const { raw, sizeExceeded } = await collectRaw(stream);
          if (sizeExceeded || raw.length > config.smtpSizeLimit) {
            const error = Object.assign(new Error("Message exceeds size limit"), {
              responseCode: 552,
            });
            callback(error);
            return;
          }
          const parsed = await simpleParser(raw);
          inbox.ingest(normalizeParsedMail(parsed, raw.toString("utf8"), "smtp"));
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error("Failed to capture message"));
        }
      })();
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
