import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Detection,
  MessageDetail,
  MessageSummary,
  StoredMessage,
} from "../../../../packages/shared/src/types.ts";
import { sanitizeEmailHtml } from "../ingest/sanitizePreview.ts";
import { MESSAGE_SCHEMA } from "./schema.ts";

export interface InboxStore {
  insert(message: Omit<StoredMessage, "id"> & { id?: string }): StoredMessage;
  list(query?: string): MessageSummary[];
  get(id: string): MessageDetail | null;
  getRaw(id: string): string | null;
  delete(id: string): boolean;
  clear(): number;
  count(): number;
  close(): void;
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
  return {
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

export function openInboxStore(dbPath: string): { store: InboxStore; mode: "file" | "memory" } {
  let mode: "file" | "memory" = "file";
  let database: DatabaseSync;

  if (dbPath === ":memory:") {
    mode = "memory";
    database = new DatabaseSync(":memory:");
  } else {
    try {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      database = new DatabaseSync(dbPath);
    } catch (error) {
      console.warn(
        `[DevCaught] Could not open SQLite file at ${dbPath} (${error instanceof Error ? error.message : error}). Falling back to in-memory storage.`,
      );
      mode = "memory";
      database = new DatabaseSync(":memory:");
    }
  }

  database.exec(MESSAGE_SCHEMA);

  const insertStmt = database.prepare(`
    INSERT INTO messages (
      id, type, source, sender, recipient, subject,
      text_body, html_body, raw_data, detections, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listStmt = database.prepare(`
    SELECT
      id, type, source, sender, recipient, subject,
      detections, created_at,
      CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html,
      CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text
    FROM messages
    ORDER BY created_at DESC
  `);

  const searchStmt = database.prepare(`
    SELECT
      id, type, source, sender, recipient, subject,
      detections, created_at,
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
  const deleteStmt = database.prepare(`DELETE FROM messages WHERE id = ?`);
  const clearStmt = database.prepare(`DELETE FROM messages`);
  const countStmt = database.prepare(`SELECT COUNT(*) AS n FROM messages`);

  const store: InboxStore = {
    insert(message) {
      const id = message.id ?? crypto.randomUUID();
      const stored: StoredMessage = { ...message, id };
      insertStmt.run(
        stored.id,
        stored.type,
        stored.source,
        stored.sender,
        stored.recipient,
        stored.subject,
        stored.textBody,
        stored.htmlBody,
        stored.rawData,
        JSON.stringify(stored.detections),
        stored.createdAt,
      );
      return stored;
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
