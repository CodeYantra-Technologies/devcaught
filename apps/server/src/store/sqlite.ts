import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Detection,
  MessageDetail,
  MessageSummary,
  SmsEvent,
  StoredMessage,
} from "../../../../packages/shared/src/types.ts";
import { sanitizeEmailHtml } from "../ingest/sanitizePreview.ts";
import { MESSAGE_SCHEMA, MIGRATION_2026_10_15_SMS } from "./schema.ts";

/** Result of an SMS insert: either a new row or the deduplicated original. */
export type SmsInsertResult =
  | { duplicate: true; id: string }
  | { duplicate: false; message: StoredMessage };

export interface ScopedInboxStore {
  insert(message: Omit<StoredMessage, "id"> & { id?: string }): StoredMessage;
  insertSms(
    message: Omit<StoredMessage, "id"> & { dedupeKey: string | null },
  ): SmsInsertResult;
  list(query?: string): MessageSummary[];
  get(id: string): MessageDetail | null;
  getRaw(id: string): string | null;
  delete(id: string): boolean;
  clear(): number;
  count(): number;
  pruneExpired(now: number, retentionDays: number): number;
  pruneOverMax(maxMessages: number): number;
}

export interface InboxStore {
  forInbox(inboxId: string): ScopedInboxStore;
  insert(message: Omit<StoredMessage, "id"> & { id?: string }): StoredMessage;
  /**
   * Insert an SMS event, deduplicating provider retries by `dedupeKey` (a
   * stable provider event identity or payload fingerprint; null = never
   * deduplicate, e.g. simulated events). Distinct delivery-status transitions
   * carry distinct keys and are always stored.
   */
  insertSms(
    message: Omit<StoredMessage, "id"> & { dedupeKey: string | null },
  ): SmsInsertResult;
  /** Delete messages older than `retentionDays`. No-op (returns 0) when <= 0. */
  pruneExpired(now: number, retentionDays: number): number;
  /** Keep only the newest `maxMessages`. No-op (returns 0) when <= 0. */
  pruneOverMax(maxMessages: number): number;
  list(query?: string): MessageSummary[];
  get(id: string): MessageDetail | null;
  getRaw(id: string): string | null;
  delete(id: string): boolean;
  clear(): number;
  count(): number;
  close(): void;
}

function assertInboxId(inboxId: string): void {
  if (
    typeof inboxId !== "string" ||
    inboxId.length === 0 ||
    inboxId.length > 128 ||
    !/^[a-zA-Z0-9_-]+$/.test(inboxId)
  ) {
    throw new Error("Invalid inbox ID");
  }
}

interface MessageRow {
  id: string;
  type: StoredMessage["type"];
  source: StoredMessage["source"];
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  text_body: string | null;
  html_body?: string | null;
  raw_data?: string | null;
  detections: string;
  created_at: number;
  dedupe_key?: string | null;
  has_html?: number;
  has_text?: number;
}

function parseDetections(raw: string): Detection[] {
  try {
    const value = JSON.parse(raw) as Detection[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function toSummary(row: MessageRow): MessageSummary {
  const summary: MessageSummary = {
    id: row.id,
    type: row.type,
    source: row.source,
    sender: row.sender ?? "",
    recipient: row.recipient ?? "",
    subject: row.subject,
    createdAt: row.created_at,
    detections: parseDetections(row.detections),
    hasHtml: Boolean(row.has_html),
    hasText: Boolean(row.has_text),
  };
  // SMS rows keep the provider-neutral view under rawData so the list and
  // detail views can render masked status info (never raw MIME or secrets).
  if (row.type === "sms" && row.raw_data) {
    try {
      const parsed = JSON.parse(row.raw_data) as { sms?: SmsEvent } | null;
      if (parsed?.sms) summary.sms = parsed.sms;
    } catch {
      // Legacy or non-JSON payloads: no SMS view.
    }
  }
  return summary;
}

function toDetail(row: MessageRow): MessageDetail {
  const htmlBody = row.html_body ?? "";
  return {
    ...toSummary({
      ...row,
      has_html: htmlBody ? 1 : 0,
      has_text: row.text_body ? 1 : 0,
    }),
    textBody: row.text_body ?? "",
    htmlBody,
    htmlPreview: htmlBody ? sanitizeEmailHtml(htmlBody) : "",
  };
}

function escapeLike(value: string): string {
  return value.replace(/([%_\\])/g, "\\$1");
}

function isUniqueConstraintError(error: unknown): boolean {
  // node:sqlite surfaces SQLITE_CONSTRAINT_UNIQUE as errcode 2067; the message
  // check is a belt-and-braces fallback across driver versions.
  const errcode = (error as { errcode?: number } | null)?.errcode;
  if (errcode === 2067 || errcode === 1555) return true;
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * Bring an existing inbox database up to the current schema. Transactional:
 * any failure rolls every step back and rethrows, so a half-migrated database
 * fails loudly instead of being silently replaced (or extended) in place.
 * Idempotent, and safe on a fresh database (the ALTER is guarded by a
 * table_info check).
 */
export function migrateInboxStore(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database.exec(MESSAGE_SCHEMA);
    const columns = database
      .prepare("PRAGMA table_info(messages)")
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === "dedupe_key")) {
      database.exec("ALTER TABLE messages ADD COLUMN dedupe_key TEXT");
    }
    if (!columns.some((column) => column.name === "inbox_id")) {
      database.exec("ALTER TABLE messages ADD COLUMN inbox_id TEXT");
    }
    database.exec("DROP INDEX IF EXISTS idx_messages_dedupe_key");
    database.exec(MIGRATION_2026_10_15_SMS);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* no active transaction to roll back */
    }
    throw error;
  }
}

export function openInboxStore(dbPath: string, options: {requirePersistent?: boolean} = {}): { store: InboxStore; mode: "file" | "memory" } {
  let mode: "file" | "memory" = "file";
  let database: DatabaseSync;
  const requirePersistentDb = options.requirePersistent === true || process.env.DEVCAUGHT_REQUIRE_PERSISTENT_DB === "1";

  if (requirePersistentDb && dbPath === ":memory:") {
    throw new Error("[DevCaught] Persistent SQLite database is required.");
  }

  if (dbPath === ":memory:") {
    mode = "memory";
    database = new DatabaseSync(":memory:");
  } else {
    try {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      database = new DatabaseSync(dbPath);
    } catch (error) {
      if (requirePersistentDb) {
        throw new Error(
          `[DevCaught] Persistent SQLite database could not be opened at ${dbPath}.`,
          { cause: error },
        );
      }
      console.warn(
        `[DevCaught] Could not open SQLite file at ${dbPath} (${error instanceof Error ? error.message : error}). Falling back to in-memory storage.`,
      );
      mode = "memory";
      database = new DatabaseSync(":memory:");
    }
  }

  migrateInboxStore(database);

  const insertStmt = database.prepare(`
    INSERT INTO messages (
      id, type, source, sender, recipient, subject,
      text_body, html_body, raw_data, detections, created_at, dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const scopedInsertStmt = database.prepare(`
    INSERT INTO messages (
      id, type, source, sender, recipient, subject,
      text_body, html_body, raw_data, detections, created_at,
      dedupe_key, inbox_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listStmt = database.prepare(`
    SELECT
      id, type, source, sender, recipient, subject,
      detections, created_at,
      CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages
    ORDER BY created_at DESC
  `);

  const searchStmt = database.prepare(`
    SELECT
      id, type, source, sender, recipient, subject,
      detections, created_at,
      CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages
    WHERE
      COALESCE(subject, '') LIKE ? ESCAPE '\\'
      OR COALESCE(sender, '') LIKE ? ESCAPE '\\'
      OR COALESCE(recipient, '') LIKE ? ESCAPE '\\'
      OR COALESCE(text_body, '') LIKE ? ESCAPE '\\'
    ORDER BY created_at DESC
  `);

  const getStmt = database.prepare(`
    SELECT
      id, type, source, sender, recipient, subject,
      text_body, html_body, detections, created_at
    FROM messages
    WHERE id = ?
  `);

  const rawStmt = database.prepare(`SELECT raw_data FROM messages WHERE id = ?`);
  const byDedupeKeyStmt = database.prepare(
    "SELECT id FROM messages WHERE dedupe_key = ? AND inbox_id IS NULL",
  );
  const scopedByDedupeKeyStmt = database.prepare(
    "SELECT id FROM messages WHERE dedupe_key = ? AND inbox_id = ?",
  );
  const pruneExpiredStmt = database.prepare("DELETE FROM messages WHERE created_at < ?");
  const pruneOverMaxStmt = database.prepare(
    "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY created_at DESC LIMIT ?)",
  );
  const deleteStmt = database.prepare(`DELETE FROM messages WHERE id = ?`);
  const clearStmt = database.prepare(`DELETE FROM messages`);
  const countStmt = database.prepare(`SELECT COUNT(*) AS n FROM messages`);

  const scopedListStmt = database.prepare(`
    SELECT
      id, type, source, sender, recipient, subject,
      detections, created_at,
      CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages
    WHERE inbox_id = ?
    ORDER BY created_at DESC
  `);

  const scopedSearchStmt = database.prepare(`
    SELECT
      id, type, source, sender, recipient, subject,
      detections, created_at,
      CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages
    WHERE inbox_id = ?
      AND (
        COALESCE(subject, '') LIKE ? ESCAPE '\\'
        OR COALESCE(sender, '') LIKE ? ESCAPE '\\'
        OR COALESCE(recipient, '') LIKE ? ESCAPE '\\'
        OR COALESCE(text_body, '') LIKE ? ESCAPE '\\'
      )
    ORDER BY created_at DESC
  `);

  const scopedPruneExpiredStmt = database.prepare(`
    DELETE FROM messages
    WHERE inbox_id = ? AND created_at < ?
  `);

  const scopedPruneOverMaxStmt = database.prepare(`
    DELETE FROM messages
    WHERE inbox_id = ?
      AND id NOT IN (
        SELECT id FROM messages
        WHERE inbox_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
  `);

  const scopedClearStmt = database.prepare(
    "DELETE FROM messages WHERE inbox_id = ?",
  );

  const scopedGetStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject,
           text_body, html_body, detections, created_at
    FROM messages WHERE id = ? AND inbox_id = ?
  `);
  const scopedRawStmt = database.prepare(
    "SELECT raw_data FROM messages WHERE id = ? AND inbox_id = ?",
  );
  const scopedDeleteStmt = database.prepare(
    "DELETE FROM messages WHERE id = ? AND inbox_id = ?",
  );
  const scopedCountStmt = database.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?",
  );

  /** Insert a row (id minted here); `dedupeKey` is null outside SMS ingest. */
  function writeMessage(
    message: Omit<StoredMessage, "id"> & { id?: string },
    dedupeKey: string | null,
  ): StoredMessage {
    const id = message.id ?? crypto.randomUUID();
    insertStmt.run(
      id,
      message.type,
      message.source,
      message.sender,
      message.recipient,
      message.subject,
      message.textBody,
      message.htmlBody,
      message.rawData,
      JSON.stringify(message.detections),
      message.createdAt,
      dedupeKey,
    );
    const { id: _ignored, ...rest } = message;
    return { ...rest, id } as StoredMessage;
  }

  const store: InboxStore = {
    forInbox(inboxId) {
      assertInboxId(inboxId);

      const unavailable = (): never => {
        throw new Error("Scoped inbox operation not implemented");
      };

      return {
        insert(message) {
          const id = message.id ?? crypto.randomUUID();
          scopedInsertStmt.run(
            id,
            message.type,
            message.source,
            message.sender,
            message.recipient,
            message.subject,
            message.textBody,
            message.htmlBody,
            message.rawData,
            JSON.stringify(message.detections),
            message.createdAt,
            null,
            inboxId,
          );
          const { id: _ignored, ...rest } = message;
          return { ...rest, id };
        },
        insertSms(message) {
          const dedupeKey = message.dedupeKey;

          if (dedupeKey) {
            const existing = scopedByDedupeKeyStmt.get(
              dedupeKey,
              inboxId,
            ) as { id: string } | undefined;

            if (existing) {
              return { duplicate: true, id: existing.id };
            }
          }

          const id = crypto.randomUUID();

          try {
            scopedInsertStmt.run(
              id,
              message.type,
              message.source,
              message.sender,
              message.recipient,
              message.subject,
              message.textBody,
              message.htmlBody,
              message.rawData,
              JSON.stringify(message.detections),
              message.createdAt,
              dedupeKey,
              inboxId,
            );

            const { dedupeKey: _dedupeKey, ...rest } = message;

            return {
              duplicate: false,
              message: { ...rest, id },
            };
          } catch (error) {
            if (dedupeKey && isUniqueConstraintError(error)) {
              const existing = scopedByDedupeKeyStmt.get(
                dedupeKey,
                inboxId,
              ) as { id: string } | undefined;

              if (existing) {
                return { duplicate: true, id: existing.id };
              }
            }

            throw error;
          }
        },
        list(query) {
          const trimmed = query?.trim();
          const pattern = trimmed ? `%${escapeLike(trimmed)}%` : "";
          const rows = trimmed
            ? scopedSearchStmt.all(
                inboxId, pattern, pattern, pattern, pattern,
              ) as unknown as MessageRow[]
            : scopedListStmt.all(inboxId) as unknown as MessageRow[];
          return rows.map(toSummary);
        },
        get(id) {
          const row = scopedGetStmt.get(id, inboxId) as MessageRow | undefined;
          if (!row) return null;
          const detail = toDetail(row);
          if (row.type === "sms" || row.type === "webhook") {
            const raw = scopedRawStmt.get(id, inboxId) as
              | { raw_data: string | null }
              | undefined;
            try {
              const parsed = JSON.parse(raw?.raw_data ?? "null");
              if (row.type === "sms" && parsed?.sms) detail.sms = parsed.sms;
              if (row.type === "webhook" && parsed) detail.webhook = parsed;
            } catch {
              /* Legacy or malformed payload. */
            }
          }
          return detail;
        },
        getRaw(id) {
          const row = scopedRawStmt.get(id, inboxId) as
            | { raw_data: string | null }
            | undefined;
          return row?.raw_data ?? null;
        },
        delete(id) {
          const result = scopedDeleteStmt.run(id, inboxId);
          return result.changes > 0;
        },
        count() {
          const row = scopedCountStmt.get(inboxId) as { n: number };
          return row.n;
        },
        clear() {
          const result = scopedClearStmt.run(inboxId);
          return Number(result.changes);
        },
        pruneExpired(now, retentionDays) {
          if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
            return 0;
          }

          const cutoff = now - retentionDays * 86_400_000;
          const result = scopedPruneExpiredStmt.run(inboxId, cutoff);
          return Number(result.changes);
        },
        pruneOverMax(maxMessages) {
          if (!Number.isInteger(maxMessages) || maxMessages <= 0) {
            return 0;
          }

          const result = scopedPruneOverMaxStmt.run(
            inboxId,
            inboxId,
            maxMessages,
          );
          return Number(result.changes);
        },
      };
    },
    insert(message) {
      return writeMessage(message, null);
    },

    insertSms(message) {
      const dedupeKey = message.dedupeKey;
      if (dedupeKey) {
        const existing = byDedupeKeyStmt.get(dedupeKey) as { id: string } | undefined;
        if (existing) return { duplicate: true, id: existing.id };
      }
      try {
        return { duplicate: false, message: writeMessage(message, dedupeKey) };
      } catch (error) {
        // Racer backstop: another writer inserted the same dedupe key between
        // the check above and this insert. Surface the original row instead of
        // failing the callback (providers retry; a 500 would invite more).
        if (dedupeKey && isUniqueConstraintError(error)) {
          const existing = byDedupeKeyStmt.get(dedupeKey) as { id: string } | undefined;
          if (existing) return { duplicate: true, id: existing.id };
        }
        throw error;
      }
    },

    pruneExpired(now, retentionDays) {
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
      const cutoff = now - retentionDays * 86_400_000;
      const result = pruneExpiredStmt.run(cutoff) as { changes?: number };
      return result.changes ?? 0;
    },

    pruneOverMax(maxMessages) {
      if (!Number.isInteger(maxMessages) || maxMessages <= 0) return 0;
      const result = pruneOverMaxStmt.run(maxMessages) as { changes?: number };
      return result.changes ?? 0;
    },
    list(query) {
      const trimmed = query?.trim();
      const pattern = trimmed ? `%${escapeLike(trimmed)}%` : "";
      const rows = trimmed
        ? (searchStmt.all(pattern, pattern, pattern, pattern) as unknown as MessageRow[])
        : (listStmt.all() as unknown as MessageRow[]);
      return rows.map(toSummary);
    },
    get(id) {
      const row = getStmt.get(id) as MessageRow | undefined;
      if (!row) return null;
      const detail = toDetail(row);
      if (row.type === "webhook") {
        const raw = rawStmt.get(id) as { raw_data: string } | undefined;
        try {
          detail.webhook = JSON.parse(raw?.raw_data ?? "null") ?? undefined;
        } catch {
          /* Legacy data. */
        }
      }
      if (row.type === "sms") {
        // SMS rows keep the full provider payload in rawData as
        // { sms: SmsEvent, request: … }; attach only the normalized view.
        const raw = rawStmt.get(id) as { raw_data: string } | undefined;
        try {
          const parsed = JSON.parse(raw?.raw_data ?? "null") as { sms?: SmsEvent } | null;
          if (parsed?.sms) detail.sms = parsed.sms;
        } catch {
          /* Legacy or non-JSON payloads. */
        }
      }
      return detail;
    },
    getRaw(id) {
      const row = rawStmt.get(id) as { raw_data: string | null } | undefined;
      return row?.raw_data ?? null;
    },
    delete(id) {
      const result = deleteStmt.run(id) as { changes?: number };
      return (result.changes ?? 0) > 0;
    },
    clear() {
      const result = clearStmt.run() as { changes?: number };
      return result.changes ?? 0;
    },
    count() {
      const row = countStmt.get() as { n: number };
      return row.n;
    },
    close() {
      database.close();
    },
  };

  return { store, mode };
}
