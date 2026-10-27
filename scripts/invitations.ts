import { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { newInvitation } from "../src/lib/auth/invitations.ts";

export interface InvitationSql {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Caller must possess local operator/database access; never expose via HTTP. */
export async function invitationCommand(db: InvitationSql, args: string[]): Promise<string> {
  const [command, value, hours, ...extra] = args;
  if (extra.length) throw new Error("Invalid arguments");
  if (command === "create" && value) {
    const { token, record } = newInvitation(value, hours === undefined ? 24 : Number(hours));
    await db.query(`INSERT INTO "invitation"
      ("id", "email", "tokenHash", "createdAt", "expiresAt", "consumed", "revoked")
      VALUES ($1, $2, $3, $4, $5, false, false)`,
    [record.id, record.email, record.tokenHash, record.createdAt, record.expiresAt]);
    return JSON.stringify({ id: record.id, email: record.email, expiresAt: record.expiresAt, token });
  }
  if (command === "list" && value === undefined) {
    const result = await db.query(`SELECT "id", "email", "createdAt", "expiresAt", "consumed", "consumedAt", "revoked"
      FROM "invitation" ORDER BY "createdAt" DESC LIMIT 100`);
    return JSON.stringify(result.rows);
  }
  if (command === "revoke" && value && hours === undefined && /^[0-9a-f-]{36}$/i.test(value)) {
    const result = await db.query(`UPDATE "invitation" SET "revoked" = true WHERE "id" = $1
      RETURNING "id", "revoked"`, [value]);
    return JSON.stringify(result.rows);
  }
  throw new Error("Usage: invitations.ts --confirm-local-operator create EMAIL [HOURS] | list | revoke ID");
}

async function main() {
  const [, , confirmation, ...args] = process.argv;
  if (confirmation !== "--confirm-local-operator") throw new Error("Local operator confirmation required");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname)) {
    throw new Error("An explicit local PostgreSQL connection is required");
  }
  const pool = new Pool({ connectionString });
  try { process.stdout.write(await invitationCommand(pool, args) + "\n"); }
  finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Invitation operation failed; verify command and local database access"); process.exitCode = 1; });
}
