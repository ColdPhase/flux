import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { assertExactMigrationLedger, readAppliedMigrationVersions, readMigrationManifest, type MigrationFile } from './ledger.js';

/** #238's own migrations, reversed newest first. */
const OWN = [
  { version: 57, name: '0057_task_creation_undo_grant.sql', down: '0057_task_creation_undo_grant.down.sql' },
  { version: 48, name: '0048_unused_ai_task_creation_undo.sql', down: '0048_unused_ai_task_creation_undo.down.sql' },
] as const;

export interface TaskCreationReversalPlan {
  /** Every migration file of this image. */
  current: MigrationFile[];
  /** The ledger after the reversal: this image without #238's own migrations. */
  prior: MigrationFile[];
  downs: { version: number; name: string; sql: string }[];
}

/** Reads this image's migrations and #238's two guarded down files before any database operation. */
export async function readTaskCreationReversalPlan(directory: string, expectedLatest: number): Promise<TaskCreationReversalPlan> {
  const current = await readMigrationManifest(directory, expectedLatest);
  for (const own of OWN) {
    if (!current.some((file) => file.version === own.version && file.name === own.name))
      throw new Error(`This image does not contain ${own.name}; there is nothing of #238 to reverse`);
  }
  const versions = new Set<number>(OWN.map((own) => own.version));
  const downs = await Promise.all(OWN.map(async (own) => ({ version: own.version, name: own.down, sql: await readFile(join(directory, 'reverse', own.down), 'utf8') })));
  return { current, prior: current.filter((file) => !versions.has(file.version)), downs };
}

/**
 * Guarded pre-use reversal of 0057 and 0048 (#238) in one transaction, for a return to the matching prior image.
 * The caller has stopped the API and worker. It holds the migrator's advisory lock, takes the affected tables
 * with NOWAIT (an active holder is refused, not waited for), requires the exact ledger of this image, runs the two
 * guarded down files and removes exactly their two ledger rows. Any refusal rolls everything back. It consumes and
 * releases this dedicated client; on an unknown outcome the client is destroyed, never returned to a pool.
 */
export async function reverseUnusedTaskCreation(client: Pick<PoolClient, 'query' | 'release'>, plan: TaskCreationReversalPlan,
  options: { quiesced: boolean }): Promise<void> {
  let serialized = false; let began = false; let committing = false; let discard = false;
  try {
    if (!options.quiesced) throw new Error('Stop the API and worker and acknowledge that before the reversal');
    if (plan.downs.map((down) => down.version).join(',') !== OWN.map((own) => own.version).join(','))
      throw new Error('The reversal runs 0057 and then 0048');
    // query_timeout need not cancel the server query: a failed control await can still take the session lock or
    // begin a transaction after the client gave up, so such a client is discarded.
    try { await client.query('SELECT pg_advisory_lock(hashtext($1))', ['flux-migrate']); serialized = true; }
    catch (cause) { discard = true; throw cause; }
    began = true;
    try { await client.query('BEGIN'); } catch (cause) { discard = true; throw cause; }
    await client.query(`LOCK TABLE proactive_comparison_proposals, agent_standing_grants,
      project_work_items, project_task_notices, task_creation_undo_receipts IN ACCESS EXCLUSIVE MODE NOWAIT`);
    assertExactMigrationLedger(plan.current, await readAppliedMigrationVersions(client));
    for (const down of plan.downs) await client.query(down.sql);
    const removed = await client.query('DELETE FROM flux_schema_version WHERE version = ANY($1::int[]) RETURNING version', [plan.downs.map((down) => down.version)]);
    if (removed.rows.length !== plan.downs.length) throw new Error('The reversal did not remove exactly the 0057 and 0048 ledger rows');
    assertExactMigrationLedger(plan.prior, await readAppliedMigrationVersions(client));
    committing = true; await client.query('COMMIT'); began = false;
  } catch (cause) {
    // A PostgreSQL SQLSTATE refusal is a known outcome; an unclassified transport rejection must never return a
    // possibly live query to a pool.
    if (serialized && (!(cause instanceof Error) || !('code' in cause)
      || typeof cause.code !== 'string' || !/^[0-9A-Z]{5}$/.test(cause.code) || cause.code.startsWith('08'))) discard = true;
    if (began && !discard) {
      try { await client.query('ROLLBACK'); began = false; } catch { discard = true; }
    }
    if (committing) {
      discard = true;
      throw new Error('The reversal COMMIT outcome is unknown; inspect the schema and the exact ledger before any retry', { cause });
    }
    throw cause;
  } finally {
    if (serialized && !discard) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['flux-migrate']); }
      catch { discard = true; }
    }
    // Destruction also releases a lock or transaction whose failed control query completed later.
    client.release(discard);
  }
}
