import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { verifiedSessionUser, type SessionReader } from "./session-policy.ts";

export type PrivateInbox = { id: string; owner_id: string };

export const newPrivateInboxId = () => `inbox_${randomUUID()}`;

/** Server infrastructure only. ownerId must come from a verified session/user creation. */
export async function provisionPrivateInbox(db: Kysely<unknown>, ownerId: string): Promise<PrivateInbox> {
  // One atomic statement: concurrent first requests return the same existing ID.
  // Never replace an existing assignment or touch the SQLite message store.
  const { rows } = await sql<PrivateInbox>`
    INSERT INTO private_inbox (id, owner_id)
    VALUES (${newPrivateInboxId()}, ${ownerId})
    ON CONFLICT (owner_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
    RETURNING id, owner_id
  `.execute(db);
  if (!rows[0]) throw new Error("Private inbox provisioning failed");
  return rows[0];
}

/** Injectable server policy; no caller-supplied identity or inbox is accepted. */
export async function resolvePrivateInbox(
  auth: SessionReader,
  headers: Headers,
  enabled: boolean,
  db: Kysely<unknown>,
  options: { provisionMissing?: boolean } = {},
): Promise<PrivateInbox | null> {
  const user = await verifiedSessionUser(auth, headers, enabled);
  if (!user) return null;
  const inbox = options.provisionMissing === false
    ? (await sql<PrivateInbox>`
        SELECT id, owner_id FROM private_inbox WHERE owner_id = ${user.id}
      `.execute(db)).rows[0]
    : await provisionPrivateInbox(db, user.id);
  if (!inbox) return null;
  if (inbox.owner_id !== user.id || !/^[A-Za-z0-9_-]{1,128}$/.test(inbox.id)) {
    throw new Error("Private inbox ownership mismatch");
  }
  return inbox;
}
