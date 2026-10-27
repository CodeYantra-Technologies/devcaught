import { sql, type Kysely } from "kysely";

/** Read-only check against the application's configured auth database, never a substitute DB. */
export async function privateInboxTargetReady(db: Kysely<unknown>): Promise<boolean> {
  try {
    const { rows } = await sql<{ ready: boolean }>`
      WITH registry AS (
        SELECT t.oid, id.attnum AS id_col, owner.attnum AS owner_col
        FROM pg_class t
        JOIN pg_attribute id ON id.attrelid=t.oid AND id.attname='id'
        JOIN pg_attribute owner ON owner.attrelid=t.oid AND owner.attname='owner_id'
        JOIN pg_attribute created ON created.attrelid=t.oid AND created.attname='created_at'
        WHERE t.oid=to_regclass('private_inbox') AND t.relkind='r'
          AND id.attnotnull AND id.atttypid='text'::regtype
          AND owner.attnotnull AND owner.atttypid='text'::regtype
          AND created.attnotnull AND created.atttypid='timestamptz'::regtype
      )
      SELECT (
        (SELECT count(*) FROM _migrations WHERE name IN (
          '0001_auth.sql', '0002_invitations.sql', '0003_private_inboxes.sql'
        ))=3
        AND EXISTS (
          SELECT FROM registry r
          WHERE EXISTS (
            SELECT FROM pg_constraint c WHERE c.conrelid=r.oid AND c.contype='p'
              AND c.convalidated AND c.conkey=ARRAY[r.id_col]
          ) AND EXISTS (
            SELECT FROM pg_constraint c WHERE c.conrelid=r.oid AND c.contype='u'
              AND c.convalidated AND c.conkey=ARRAY[r.owner_col]
          ) AND EXISTS (
            SELECT FROM pg_constraint c
            JOIN pg_attribute target ON target.attrelid=c.confrelid AND target.attname='id'
            WHERE c.conrelid=r.oid AND c.contype='f' AND c.convalidated
              AND c.conkey=ARRAY[r.owner_col] AND c.confkey=ARRAY[target.attnum]
              AND c.confrelid=to_regclass('"user"') AND c.confdeltype='r'
          )
        )
      ) AS ready
    `.execute(db);
    return rows[0]?.ready === true;
  } catch {
    return false;
  }
}
