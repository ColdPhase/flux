import type { Pool, PoolClient } from 'pg';

/**
 * An unmerged build used 0057 for summary columns, while 0057 belongs to another migration.
 * A numeric ledger cannot distinguish those meanings once the reserved file is composed
 * into an image. Inspect the table that this connection's search_path actually resolves.
 * Call under the migrator lock, before any migration SQL or ledger write.
 */
export async function assertMorningSummaryMigrationCompatibility(
  db: Pick<Pool | PoolClient, 'query'>,
  applied: readonly number[],
): Promise<void> {
  if (applied.includes(72)) return;
  const columns = await db.query(`
    SELECT attname AS name FROM pg_catalog.pg_attribute
    WHERE attrelid = pg_catalog.to_regclass('notification_preferences')
      AND attnum > 0 AND NOT attisdropped
      AND attname IN ('summary_enabled', 'summary_at', 'summary_last_on')
    ORDER BY attname
  `);
  if (!columns.rows.length) return;
  const names = columns.rows.map((row: { name: string }) => row.name).join(', ');
  throw new Error(
    `Flux migration refused: unversioned or legacy morning-summary columns (${names}) exist without ledger version 72. ` +
    'This can come from the unmerged 0057_morning_summary build; reserved migration 0057 is not that schema. ' +
    'Restore the matching image/database backup or use an explicitly reviewed data conversion. ' +
    'Do not renumber migrations, edit the ledger, or drop these columns to guess a repair. No migration changes were applied.',
  );
}
