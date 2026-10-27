-- Ownership metadata only: never infer ownership of existing SQLite messages.
CREATE TABLE IF NOT EXISTS private_inbox (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  owner_id text NOT NULL UNIQUE REFERENCES "user" (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
