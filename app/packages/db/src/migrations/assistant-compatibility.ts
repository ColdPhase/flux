import type { Pool, PoolClient } from 'pg';

/** Reserved 0077 means this assistant/S6 seam, not an arbitrary numeric marker or unmerged prototype. */
export async function assertAssistantMigrationCompatibility(db: Pick<Pool | PoolClient, 'query'>, applied: readonly number[]): Promise<void> {
  const relation = await db.query("SELECT to_regclass('assistant_settings') AS settings, to_regclass('assistant_join_requests') AS requests");
  const exists = relation.rows[0]?.settings != null || relation.rows[0]?.requests != null;
  if (!applied.includes(77)) {
    if (exists) throw new Error('Flux migration refused: assistant tables exist without reserved ledger version 77. Restore the matching image/database backup or a reviewed conversion; no migration changes were applied.');
    return;
  }
  const expected: Record<string, string[]> = {
    assistant_settings: ['workspace_id','owner_user_id','agent_id','connection_id','approval_mode','changes_per_run','background_runs_per_day','project_mode','version','created_at','updated_at'],
    assistant_join_requests: ['id','workspace_id','project_id','owner_user_id','connection_id','state','version','created_at','updated_at'],
  };
  for (const [table, columns] of Object.entries(expected)) {
    const actual = await db.query('SELECT attname AS name FROM pg_catalog.pg_attribute WHERE attrelid = pg_catalog.to_regclass($1) AND attnum > 0 AND NOT attisdropped', [table]);
    const found = new Set(actual.rows.map((row: { name: string }) => row.name));
    if (columns.some((column) => !found.has(column))) throw new Error(`Flux migration refused: reserved 0077 assistant footprint is incomplete (${table}). Restore the matching image/database backup; no migration changes were applied.`);
  }
}
