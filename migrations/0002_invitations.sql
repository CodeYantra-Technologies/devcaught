-- Phase 1 metadata only. Existing identity rows and SQLite messages are untouched.
CREATE TABLE IF NOT EXISTS "invitation" (
  "id" text PRIMARY KEY,
  "email" text NOT NULL CHECK ("email" = lower(trim("email"))),
  "tokenHash" text NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  "createdAt" timestamptz NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "consumed" boolean NOT NULL DEFAULT false,
  "revoked" boolean NOT NULL DEFAULT false,
  "consumedAt" timestamptz,
  CHECK ("expiresAt" > "createdAt"),
  CHECK ("consumed" = ("consumedAt" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation" ("email");

-- Better Auth's authoritative, database-backed abuse counters.
CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" text PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL
);
