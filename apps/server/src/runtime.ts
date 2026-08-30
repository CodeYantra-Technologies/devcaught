import type { ListenerStatus } from "../../../packages/shared/src/types.ts";
import { assertSupportedNode, loadConfig, type DevCaughtConfig } from "./config.ts";
import { InboxService } from "./ingest/inboxService.ts";
import { normalizeTestEmail } from "./ingest/normalizeEmail.ts";
import { startSmtpReceiver, type SmtpRuntime } from "./smtp/receiver.ts";
import type { InboxStore } from "./store/sqlite.ts";

export interface DevCaughtRuntime {
  config: DevCaughtConfig;
  store: InboxStore;
  inbox: InboxService;
  smtp: SmtpRuntime;
  http: ListenerStatus;
  dbMode: "file" | "memory";
  normalizeTestEmail: typeof normalizeTestEmail;
  setHttpStatus(status: Partial<ListenerStatus>): void;
}

type GlobalSlot = {
  runtime?: DevCaughtRuntime;
  starting?: Promise<DevCaughtRuntime>;
};

const globalKey = "__devcaughtRuntime" as const;

function slot(): GlobalSlot {
  const g = globalThis as typeof globalThis & { [globalKey]?: GlobalSlot };
  if (!g[globalKey]) g[globalKey] = {};
  return g[globalKey];
}

export async function ensureRuntime(): Promise<DevCaughtRuntime> {
  const current = slot();
  if (current.runtime) return current.runtime;
  if (current.starting) return current.starting;
  current.starting = startRuntime();
  try {
    current.runtime = await current.starting;
    return current.runtime;
  } finally {
    current.starting = undefined;
  }
}

async function startRuntime(): Promise<DevCaughtRuntime> {
  assertSupportedNode();
  const config = loadConfig();
  const { openInboxStore } = await import("./store/sqlite.ts");
  const { store, mode } = openInboxStore(config.dbPath);
  const inbox = new InboxService(store);
  const smtp = await startSmtpReceiver(config, inbox);

  const runtime: DevCaughtRuntime = {
    config,
    store,
    inbox,
    smtp,
    dbMode: mode,
    normalizeTestEmail,
    http: {
      running: false,
      host: config.host,
      port: config.httpPort,
      error: null,
    },
    setHttpStatus(status) {
      runtime.http = { ...runtime.http, ...status };
    },
  };

  return runtime;
}
