import type { ListenerStatus } from "../../../packages/shared/src/types.ts";
import { assertSupportedNode, loadConfig, type DevCaughtConfig } from "./config.ts";
import { InboxService } from "./ingest/inboxService.ts";
import { normalizeTestEmail } from "./ingest/normalizeEmail.ts";
import { startSmtpReceiver, type SmtpRuntime } from "./smtp/receiver.ts";
import type { InboxStore } from "./store/sqlite.ts";
import type { PrivateSmsIngest } from "./ingest/sms/private-routing.ts";

export interface DevCaughtRuntime {
  config: DevCaughtConfig;
  store: InboxStore;
  inbox: InboxService;
  privateSmsIngest?: PrivateSmsIngest;
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
  const { store, mode } = openInboxStore(config.dbPath, {requirePersistent:config.smsRoutingMode === 'private'});
  if (config.smtpRoutingMode === 'private' && mode !== 'file') {
    store.close();
    throw new Error('Private SMTP requires persistent SQLite storage');
  }
  let smsRouting: {ingest:PrivateSmsIngest; close:() => Promise<void>} | undefined;
  try {
    if (config.smsRoutingMode === 'private') {
      const {configuredPrivateSmsDependencies} = await import('./ingest/sms/private-routing.ts');
      smsRouting = configuredPrivateSmsDependencies(store, config);
    }
    // Any private ingestion disables root/global retention. Scoped services may
    // prune their own inbox; root email/webhook activity must never prune SMS.
    const privateIngestion = config.smtpRoutingMode === 'private' || config.smsRoutingMode === 'private';
    if (!privateIngestion) {
      store.pruneExpired(Date.now(), config.retentionDays);
      store.pruneOverMax(config.maxMessages);
    }
    const inbox = new InboxService(store, privateIngestion ? {} : {
      retentionDays: config.retentionDays, maxMessages: config.maxMessages,
    });
    let smtp: SmtpRuntime;
    if (config.smtpRoutingMode === 'private') {
      const { configuredPrivateSmtpDependencies } = await import('./smtp/private-routing.ts');
      const routing = configuredPrivateSmtpDependencies(store, config);
      try {
        const receiver = await startSmtpReceiver(config, inbox, routing.resolveRecipient, routing.inboxForId);
        smtp = {status: receiver.status, async close() { try { await receiver.close(); } finally { await routing.close(); } }};
        if (!receiver.status.running) await routing.close();
      } catch (error) { await routing.close(); throw error; }
    } else {
      smtp = await startSmtpReceiver(config, inbox);
    }
    if (smsRouting) {
      const receiver = smtp, sms = smsRouting;
      smtp = {status:receiver.status, async close() {try {await receiver.close();} finally {await sms.close();}}};
    }
    const runtime: DevCaughtRuntime = {
      config, store, inbox, smtp, privateSmsIngest:smsRouting?.ingest,
      dbMode: mode, normalizeTestEmail,
      http: {running:false, host:config.host, port:config.httpPort, error:null},
      setHttpStatus(status) {runtime.http = {...runtime.http, ...status};},
    };
    return runtime;
  } catch(error) {
    try {await smsRouting?.close();} finally {store.close();}
    throw error;
  }
}
