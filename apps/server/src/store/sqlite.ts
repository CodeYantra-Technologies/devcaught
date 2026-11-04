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
import { MESSAGE_SCHEMA, MESSAGE_TABLE_SCHEMA, MIGRATION_2026_10_15_SMS } from "./schema.ts";

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

export interface LocalCapturePage {
  items: MessageSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type LocalCaptureChannel = "all" | "email" | "sms" | "webhook";

export interface LocalCaptureStore extends ScopedInboxStore {
  /** List a bounded page of local captures, ordered newest first. */
  listPage(options: { limit: number; cursor?: string | null; query?: string; channel?: LocalCaptureChannel }): LocalCapturePage;
  /** Read only trusted local SMTP detail; legacy and generic rows return null. */
  getLocalSmtp(id: string): MessageDetail | null;
  /** Read only trusted local SMTP or webhook detail. */
  getLocalCapture(id: string): MessageDetail | null;
}

export interface LocalWebhookCaptureStore {
  insert(message: Omit<StoredMessage, "id"> & { id?: string }): StoredMessage;
}

export interface LocalSmsCaptureStore {
  insertSms(message: Omit<StoredMessage, "id"> & { id?: string; dedupeKey: null }): SmsInsertResult;
}

export interface InboxStore {
  forInbox(inboxId: string): ScopedInboxStore;
  /** Local capture only: every operation is constrained to inbox_id IS NULL. */
  forLocalCapture(): LocalCaptureStore;
  /** Trusted SMTP-only capability; inserts and retention are provenance-scoped. */
  forLocalSmtpCapture(): ScopedInboxStore;
  /** Trusted generic local webhook ingress; inserts are webhook-only and unassigned. */
  forLocalWebhookCapture(): LocalWebhookCaptureStore;
  /** Trusted synthetic local SMS writer; inserts are simulated and unassigned. */
  forLocalSmsCapture(): LocalSmsCaptureStore;
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

function rejectCaptureOrigin(message: object): void {
  if (Object.hasOwn(message, "captureOrigin") || Object.hasOwn(message, "capture_origin")) {
    throw new Error("Capture origin is assigned only by trusted ingestion");
  }
}

const MAX_LOCAL_PAGE_SIZE = 50;
const MAX_LOCAL_CURSOR_LENGTH = 1_024;

interface LocalPageCursor {
  createdAt: number;
  id: string;
}

function encodeLocalPageCursor(cursor: LocalPageCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), "utf8").toString("base64url");
}

function decodeLocalPageCursor(value: string | null | undefined): LocalPageCursor | null {
  if (value == null) return null;
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_LOCAL_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error("Invalid local capture pagination cursor");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error("noncanonical cursor");
    const parsed: unknown = JSON.parse(decoded);
    if (
      !Array.isArray(parsed) || parsed.length !== 2 ||
      typeof parsed[0] !== "number" || !Number.isFinite(parsed[0]) ||
      typeof parsed[1] !== "string" || parsed[1].length === 0 || parsed[1].length > 256
    ) {
      throw new Error("invalid cursor payload");
    }
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    throw new Error("Invalid local capture pagination cursor");
  }
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
    const initialVersion = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (initialVersion > 2) throw new Error(`Unsupported inbox schema version: ${initialVersion}`);
    const existed = Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
    ).get());
    const previousIndexes = existed
      ? database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL ORDER BY name")
          .all() as { sql: string }[]
      : [];
    database.exec(MESSAGE_SCHEMA);
    let columns = database
      .prepare("PRAGMA table_info(messages)")
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === "dedupe_key")) {
      database.exec("ALTER TABLE messages ADD COLUMN dedupe_key TEXT");
    }
    if (!columns.some((column) => column.name === "inbox_id")) {
      database.exec("ALTER TABLE messages ADD COLUMN inbox_id TEXT");
    }
    if (!columns.some((column) => column.name === "capture_origin")) {
      database.exec("ALTER TABLE messages ADD COLUMN capture_origin TEXT");
    }

    // Versions before 2 predate at least one trusted provenance option. Rebuild
    // existing tables transactionally; NULL provenance is copied verbatim and
    // never inferred. Fresh databases already use the current definition.
    if (existed && initialVersion < 2) {
      columns = database.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
      const expectedColumns = ["id", "type", "source", "sender", "recipient", "subject", "text_body", "html_body", "raw_data", "detections", "created_at", "dedupe_key", "inbox_id", "capture_origin"];
      const unexpected = columns.map((column) => column.name).filter((name) => !expectedColumns.includes(name));
      if (unexpected.length) throw new Error(`Cannot safely migrate unknown messages columns: ${unexpected.join(", ")}`);
      database.exec(MESSAGE_TABLE_SCHEMA.replace("CREATE TABLE messages", "CREATE TABLE messages__provenance_v2"));
      database.exec(`INSERT INTO messages__provenance_v2 (${expectedColumns.join(", ")}) SELECT ${expectedColumns.join(", ")} FROM messages`);
      database.exec("DROP TABLE messages");
      database.exec("ALTER TABLE messages__provenance_v2 RENAME TO messages");
      for (const { sql } of previousIndexes) database.exec(sql);
    }
    database.exec("DROP INDEX IF EXISTS idx_messages_dedupe_key");
    database.exec(MIGRATION_2026_10_15_SMS);
    database.exec("PRAGMA user_version = 2");
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

  const trustedLocalSmtpInsertStmt = database.prepare(`
    INSERT INTO messages (
      id, type, source, sender, recipient, subject,
      text_body, html_body, raw_data, detections, created_at,
      dedupe_key, inbox_id, capture_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'local_smtp')
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

  // The local capture view deliberately uses separate NULL-scoped statements.
  // The root store is unscoped and must never back a local dashboard operation.
  const localListStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, detections, created_at,
      CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages WHERE inbox_id IS NULL ORDER BY created_at DESC
  `);
  const localSearchStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, detections, created_at,
      CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages WHERE inbox_id IS NULL AND (
      COALESCE(subject, '') LIKE ? ESCAPE '\\'
      OR COALESCE(sender, '') LIKE ? ESCAPE '\\'
      OR COALESCE(recipient, '') LIKE ? ESCAPE '\\'
      OR COALESCE(text_body, '') LIKE ? ESCAPE '\\'
    ) ORDER BY created_at DESC
  `);
  const localPageStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, detections, created_at,
      CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages
    WHERE inbox_id IS NULL AND capture_origin IN ('local_smtp', 'local_sms', 'local_webhook')
      AND (? = 'all' OR (? = 'email' AND capture_origin = 'local_smtp') OR (? = 'sms' AND capture_origin = 'local_sms') OR (? = 'webhook' AND capture_origin = 'local_webhook'))
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const localSearchPageStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, detections, created_at,
      CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages
    WHERE inbox_id IS NULL AND capture_origin IN ('local_smtp', 'local_sms', 'local_webhook')
      AND (? = 'all' OR (? = 'email' AND capture_origin = 'local_smtp') OR (? = 'sms' AND capture_origin = 'local_sms') OR (? = 'webhook' AND capture_origin = 'local_webhook'))
      AND (
        (capture_origin = 'local_smtp' AND (
          COALESCE(subject, '') LIKE ? ESCAPE '\\'
          OR COALESCE(sender, '') LIKE ? ESCAPE '\\'
          OR COALESCE(recipient, '') LIKE ? ESCAPE '\\'
          OR COALESCE(text_body, '') LIKE ? ESCAPE '\\'
        ))
        OR (capture_origin = 'local_webhook' AND (
          COALESCE(subject, '') LIKE ? ESCAPE '\\'
          OR COALESCE(text_body, '') LIKE ? ESCAPE '\\'
        ))
        OR (capture_origin = 'local_sms' AND (
          COALESCE(subject, '') LIKE ? ESCAPE '\\'
          OR COALESCE(sender, '') LIKE ? ESCAPE '\\'
          OR COALESCE(recipient, '') LIKE ? ESCAPE '\\'
          OR COALESCE(text_body, '') LIKE ? ESCAPE '\\'
        ))
      )
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const localGetStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, text_body, html_body,
      detections, created_at FROM messages WHERE id = ? AND inbox_id IS NULL
  `);
  const trustedLocalSmtpGetStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, text_body, html_body,
      detections, created_at FROM messages
    WHERE id = ? AND inbox_id IS NULL AND capture_origin = 'local_smtp'
  `);
  const trustedLocalCaptureGetStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, text_body, html_body,
      detections, created_at, CASE WHEN type = 'sms' THEN raw_data ELSE NULL END AS raw_data FROM messages
    WHERE id = ? AND inbox_id IS NULL AND capture_origin IN ('local_smtp', 'local_sms', 'local_webhook')
  `);
  const trustedLocalWebhookInsertStmt = database.prepare(`
    INSERT INTO messages (
      id, type, source, sender, recipient, subject,
      text_body, html_body, raw_data, detections, created_at,
      dedupe_key, inbox_id, capture_origin
    ) VALUES (?, 'webhook', 'http', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'local_webhook')
  `);
  const trustedLocalSmsInsertStmt = database.prepare(`
    INSERT INTO messages (
      id, type, source, sender, recipient, subject,
      text_body, html_body, raw_data, detections, created_at,
      dedupe_key, inbox_id, capture_origin
    ) VALUES (?, 'sms', 'simulated', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'local_sms')
  `);
  const trustedLocalSmtpListStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, detections, created_at,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages WHERE inbox_id IS NULL AND capture_origin = 'local_smtp'
    ORDER BY created_at DESC, id DESC
  `);
  const trustedLocalSmtpSearchStmt = database.prepare(`
    SELECT id, type, source, sender, recipient, subject, detections, created_at,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages WHERE inbox_id IS NULL AND capture_origin = 'local_smtp' AND (
      COALESCE(subject, '') LIKE ? ESCAPE '\\'
      OR COALESCE(sender, '') LIKE ? ESCAPE '\\'
      OR COALESCE(recipient, '') LIKE ? ESCAPE '\\'
      OR COALESCE(text_body, '') LIKE ? ESCAPE '\\'
    ) ORDER BY created_at DESC, id DESC
  `);
  const trustedLocalSmtpRawStmt = database.prepare(`
    SELECT raw_data FROM messages
    WHERE id = ? AND inbox_id IS NULL AND capture_origin = 'local_smtp'
  `);
  const trustedLocalSmtpDeleteStmt = database.prepare(`
    DELETE FROM messages WHERE id = ? AND inbox_id IS NULL AND capture_origin = 'local_smtp'
  `);
  const trustedLocalSmtpClearStmt = database.prepare(
    "DELETE FROM messages WHERE inbox_id IS NULL AND capture_origin = 'local_smtp'",
  );
  const trustedLocalSmtpCountStmt = database.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE inbox_id IS NULL AND capture_origin = 'local_smtp'",
  );
  const trustedLocalSmtpPruneExpiredStmt = database.prepare(
    "DELETE FROM messages WHERE inbox_id IS NULL AND capture_origin = 'local_smtp' AND created_at < ?",
  );
  const trustedLocalSmtpPruneOverMaxStmt = database.prepare(`
    DELETE FROM messages WHERE inbox_id IS NULL AND capture_origin = 'local_smtp' AND id NOT IN (
      SELECT id FROM messages WHERE inbox_id IS NULL AND capture_origin = 'local_smtp'
      ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `);
  const localRawStmt = database.prepare(
    "SELECT raw_data FROM messages WHERE id = ? AND inbox_id IS NULL",
  );
  const localDeleteStmt = database.prepare(
    "DELETE FROM messages WHERE id = ? AND inbox_id IS NULL",
  );
  const localClearStmt = database.prepare("DELETE FROM messages WHERE inbox_id IS NULL");
  const localCountStmt = database.prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id IS NULL");
  const localByDedupeKeyStmt = database.prepare(
    "SELECT id FROM messages WHERE dedupe_key = ? AND inbox_id IS NULL",
  );
  const localPruneExpiredStmt = database.prepare(
    "DELETE FROM messages WHERE inbox_id IS NULL AND created_at < ?",
  );
  const localPruneOverMaxStmt = database.prepare(`
    DELETE FROM messages WHERE inbox_id IS NULL AND id NOT IN (
      SELECT id FROM messages WHERE inbox_id IS NULL ORDER BY created_at DESC LIMIT ?
    )
  `);

  function rejectInboxAssignment(message: object): void {
    if (Object.hasOwn(message, "inboxId") || Object.hasOwn(message, "inbox_id")) {
      throw new Error("Local capture messages cannot specify an inbox assignment");
    }
  }

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
    forLocalSmtpCapture() {
      return {
        insert(message) {
          rejectInboxAssignment(message);
          rejectCaptureOrigin(message);
          if (message.type !== "email" || message.source !== "smtp") {
            throw new Error("Trusted local SMTP storage accepts only SMTP email messages");
          }
          const id = message.id ?? crypto.randomUUID();
          trustedLocalSmtpInsertStmt.run(
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
          );
          const { id: _ignored, ...rest } = message;
          return { ...rest, id };
        },
        insertSms() {
          throw new Error("Trusted local SMTP storage does not accept SMS messages");
        },
        list(query) {
          const trimmed = query?.trim();
          const pattern = trimmed ? `%${escapeLike(trimmed)}%` : "";
          const rows = (trimmed
            ? trustedLocalSmtpSearchStmt.all(pattern, pattern, pattern, pattern)
            : trustedLocalSmtpListStmt.all()) as unknown as MessageRow[];
          return rows.map(toSummary);
        },
        get(id) {
          const row = trustedLocalSmtpGetStmt.get(id) as MessageRow | undefined;
          return row ? toDetail(row) : null;
        },
        getRaw(id) {
          const row = trustedLocalSmtpRawStmt.get(id) as { raw_data: string | null } | undefined;
          return row?.raw_data ?? null;
        },
        delete(id) {
          return trustedLocalSmtpDeleteStmt.run(id).changes > 0;
        },
        clear() {
          return Number(trustedLocalSmtpClearStmt.run().changes);
        },
        count() {
          return (trustedLocalSmtpCountStmt.get() as { n: number }).n;
        },
        pruneExpired(now, retentionDays) {
          if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
          return Number(trustedLocalSmtpPruneExpiredStmt.run(now - retentionDays * 86_400_000).changes);
        },
        pruneOverMax(maxMessages) {
          if (!Number.isInteger(maxMessages) || maxMessages <= 0) return 0;
          return Number(trustedLocalSmtpPruneOverMaxStmt.run(maxMessages).changes);
        },
      };
    },
    forLocalWebhookCapture() {
      return {
        insert(message) {
          rejectInboxAssignment(message);
          rejectCaptureOrigin(message);
          if (message.type !== "webhook" || message.source !== "http") {
            throw new Error("Trusted local webhook storage accepts only HTTP webhook messages");
          }
          const id = message.id ?? crypto.randomUUID();
          trustedLocalWebhookInsertStmt.run(
            id,
            message.sender,
            message.recipient,
            message.subject,
            message.textBody,
            message.htmlBody,
            message.rawData,
            JSON.stringify(message.detections),
            message.createdAt,
          );
          const { id: _ignored, ...rest } = message;
          return { ...rest, id } as StoredMessage;
        },
      };
    },
    forLocalSmsCapture() {
      return {
        insertSms(message) {
          rejectInboxAssignment(message);
          rejectCaptureOrigin(message);
          if (message.type !== "sms" || message.source !== "simulated") {
            throw new Error("Trusted local SMS storage accepts only simulated SMS messages");
          }
          if (message.dedupeKey !== null) {
            throw new Error("Trusted local SMS storage does not accept provider deduplication keys");
          }
          const id = message.id ?? crypto.randomUUID();
          trustedLocalSmsInsertStmt.run(
            id,
            message.sender,
            message.recipient,
            message.subject,
            message.textBody,
            message.htmlBody,
            message.rawData,
            JSON.stringify(message.detections),
            message.createdAt,
          );
          const { id: _ignored, dedupeKey: _dedupeKey, ...rest } = message;
          return { duplicate: false, message: { ...rest, id } as StoredMessage };
        },
      };
    },
    forInbox(inboxId) {
      assertInboxId(inboxId);

      const unavailable = (): never => {
        throw new Error("Scoped inbox operation not implemented");
      };

      return {
        insert(message) {
          rejectCaptureOrigin(message);
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
          rejectCaptureOrigin(message);
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
    forLocalCapture() {
      return {
        insert(message) {
          rejectInboxAssignment(message);
          rejectCaptureOrigin(message);
          return writeMessage(message, null);
        },
        insertSms(message) {
          rejectInboxAssignment(message);
          rejectCaptureOrigin(message);
          const { dedupeKey, ...storedMessage } = message;
          if (dedupeKey) {
            const existing = localByDedupeKeyStmt.get(dedupeKey) as { id: string } | undefined;
            if (existing) return { duplicate: true, id: existing.id };
          }
          try {
            return { duplicate: false, message: writeMessage(storedMessage, dedupeKey) };
          } catch (error) {
            if (dedupeKey && isUniqueConstraintError(error)) {
              const existing = localByDedupeKeyStmt.get(dedupeKey) as { id: string } | undefined;
              if (existing) return { duplicate: true, id: existing.id };
            }
            throw error;
          }
        },
        list(query) {
          const trimmed = query?.trim();
          const pattern = trimmed ? `%${escapeLike(trimmed)}%` : "";
          const rows = trimmed
            ? localSearchStmt.all(pattern, pattern, pattern, pattern) as unknown as MessageRow[]
            : localListStmt.all() as unknown as MessageRow[];
          return rows.map(toSummary);
        },
        listPage({ limit, cursor, query, channel = "all" }) {
          if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error("Local capture page size must be a positive integer");
          }
          if (channel !== "all" && channel !== "email" && channel !== "sms" && channel !== "webhook") {
            throw new Error("Invalid local capture channel");
          }
          const pageLimit = Math.min(limit, MAX_LOCAL_PAGE_SIZE);
          const decodedCursor = decodeLocalPageCursor(cursor);
          const trimmed = query?.trim();
          const pattern = trimmed ? `%${escapeLike(trimmed)}%` : "";
          const cursorAt = decodedCursor?.createdAt ?? null;
          const cursorId = decodedCursor?.id ?? null;
          const rows = (trimmed
            ? localSearchPageStmt.all(
                channel, channel, channel, channel,
                pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern,
                cursorAt, cursorAt, cursorAt, cursorId, pageLimit + 1,
              )
            : localPageStmt.all(
                channel, channel, channel, channel,
                cursorAt, cursorAt, cursorAt, cursorId, pageLimit + 1,
              )) as unknown as MessageRow[];
          const hasMore = rows.length > pageLimit;
          const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
          const items = pageRows.map(toSummary);
          const last = pageRows.at(-1);
          return {
            items,
            hasMore,
            nextCursor: hasMore && last
              ? encodeLocalPageCursor({ createdAt: last.created_at, id: last.id })
              : null,
          };
        },
        getLocalSmtp(id) {
          const row = trustedLocalSmtpGetStmt.get(id) as MessageRow | undefined;
          return row ? toDetail(row) : null;
        },
        getLocalCapture(id) {
          const row = trustedLocalCaptureGetStmt.get(id) as MessageRow | undefined;
          if (!row) return null;
          const detail = toDetail(row);
          if (row.type === "sms") {
            try {
              const parsed = JSON.parse(row.raw_data ?? "null") as { sms?: SmsEvent } | null;
              if (parsed?.sms) detail.sms = parsed.sms;
            } catch {
              /* No normalized SMS view for malformed stored payloads. */
            }
          }
          return detail;
        },
        get(id) {
          const row = localGetStmt.get(id) as MessageRow | undefined;
          if (!row) return null;
          const detail = toDetail(row);
          if (row.type === "sms" || row.type === "webhook") {
            const raw = localRawStmt.get(id) as { raw_data: string | null } | undefined;
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
          const row = localRawStmt.get(id) as { raw_data: string | null } | undefined;
          return row?.raw_data ?? null;
        },
        delete(id) {
          return localDeleteStmt.run(id).changes > 0;
        },
        clear() {
          return Number(localClearStmt.run().changes);
        },
        count() {
          return (localCountStmt.get() as { n: number }).n;
        },
        pruneExpired(now, retentionDays) {
          if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
          return Number(localPruneExpiredStmt.run(now - retentionDays * 86_400_000).changes);
        },
        pruneOverMax(maxMessages) {
          if (!Number.isInteger(maxMessages) || maxMessages <= 0) return 0;
          return Number(localPruneOverMaxStmt.run(maxMessages).changes);
        },
      };
    },
    insert(message) {
      rejectCaptureOrigin(message);
      return writeMessage(message, null);
    },

    insertSms(message) {
      rejectCaptureOrigin(message);
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
