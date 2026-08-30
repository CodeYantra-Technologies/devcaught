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
