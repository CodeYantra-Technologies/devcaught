import { createPrivateInboxApi, inboxUnavailable, type PrivateInboxOperation } from "./private-inbox-api.ts";
import { PRIVATE_INBOX_POSTGRES_VERIFIED } from "./private-inbox-release.ts";
import type { InboxStore } from "../../../apps/server/src/store/sqlite.ts";
import { privateInboxTargetReady } from "./private-inbox-readiness.ts";

// Independent of the ingestion runtime: never starts listeners or global retention.
const globalStore = globalThis as typeof globalThis & { __devcaughtPrivateApiStore__?: InboxStore };

async function openPrivateApiStore(): Promise<InboxStore> {
  if (globalStore.__devcaughtPrivateApiStore__) return globalStore.__devcaughtPrivateApiStore__;
  const { loadConfig } = await import("../../../apps/server/src/config.ts");
  const { openInboxStore } = await import("../../../apps/server/src/store/sqlite.ts");
  if (globalStore.__devcaughtPrivateApiStore__) return globalStore.__devcaughtPrivateApiStore__;
  const config = loadConfig();
  if (config.dbPath === ":memory:") throw new Error("Persistent inbox storage required");
  const opened = openInboxStore(config.dbPath);
  if (opened.mode !== "file") {
    opened.store.close();
    throw new Error("Persistent inbox storage unavailable");
  }
  globalStore.__devcaughtPrivateApiStore__ = opened.store;
  return opened.store;
}

export async function handlePrivateInboxRequest(request: Request, operation: PrivateInboxOperation, id?: string) {
  // Check before importing the auth singleton or opening any runtime database.
  if (!PRIVATE_INBOX_POSTGRES_VERIFIED) return inboxUnavailable();
  return createPrivateInboxApi({
    postgresVerified: PRIVATE_INBOX_POSTGRES_VERIFIED,
    resolveInbox: async () => {
      const { authDatabase } = await import("../auth/server");
      if (!await privateInboxTargetReady(authDatabase)) {
        throw new Error("Private inbox target migration unavailable");
      }
      const { requirePrivateInbox } = await import("../auth/private-inbox.server");
      try { return await requirePrivateInbox(); }
      catch (error) {
        if (error instanceof Error && error.name === "UnauthorizedError") return null;
        throw error;
      }
    },
    openStore: openPrivateApiStore,
  })(request, operation, id);
}
