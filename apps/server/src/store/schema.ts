export const MESSAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  sender TEXT,
  recipient TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  raw_data TEXT,
  detections TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
`;

/**
 * SMS migration (2026-10-15): adds the nullable `dedupe_key` column used to
 * deduplicate provider event retries, plus a partial UNIQUE index over the
 * non-null values (existing email/webhook rows keep NULL and never collide).
 * Applied by `migrateInboxStore` inside a transaction; also safe on a fresh
 * database (the ALTER is guarded by a table_info check there).
 */
export const MIGRATION_2026_10_15_SMS = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe_key
  ON messages(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND inbox_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_inbox_dedupe_key
  ON messages(inbox_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND inbox_id IS NOT NULL;
`;
