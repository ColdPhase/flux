import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { assertExactMigrationLedger, readAppliedMigrationVersions, readMigrationManifest, type MigrationFile } from './ledger.js';

interface PinnedFile extends MigrationFile { sha256: string }
export interface TaskCreationReversalManifest {
  current: PinnedFile[]; prior: PinnedFile[]; currentSha256: string; priorSha256: string;
  down: { name: string; sha256: string }; downSql: string;
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second);

/** Verify the reviewed sparse image manifests and down SQL before any database operation. */
export async function readTaskCreationReversalManifest(directory: string): Promise<TaskCreationReversalManifest> {
  const pin = JSON.parse(await readFile(join(directory, 'reverse/0048_manifest.json'), 'utf8')) as TaskCreationReversalManifest;
  const files = await readMigrationManifest(directory, 48);
  const actual: PinnedFile[] = [];
  for (const file of files) actual.push({ name: file.name, version: file.version, sha256: sha256(await readFile(join(directory, file.name), 'utf8')) });
  const prior = actual.filter(file => file.version !== 48);
  if (!same(actual, pin.current) || !same(prior, pin.prior)
    || sha256(JSON.stringify(actual)) !== pin.currentSha256 || sha256(JSON.stringify(prior)) !== pin.priorSha256
    || files.at(-1)?.name !== '0048_unused_ai_task_creation_undo.sql'
    || pin.down?.name !== '0048_unused_ai_task_creation_undo.down.sql') throw new Error('Reviewed task creation reversal manifest does not match this image');
  const downSql = await readFile(join(directory, 'reverse', pin.down.name), 'utf8');
  if (sha256(downSql) !== pin.down.sha256) throw new Error('Reviewed task creation down SQL does not match this image');
  return { ...pin, downSql };
}

/** Consumes and releases this dedicated client; the caller has stopped application feature writers. */
export async function reverseUnusedTaskCreation(client: Pick<PoolClient, 'query' | 'release'>, manifest: TaskCreationReversalManifest,
  options: { quiesced: boolean }): Promise<void> {
  let serialized = false; let began = false; let committing = false; let discard = false;
  try {
    if (!options.quiesced) throw new Error('Stop API/worker feature writers and explicitly acknowledge quiescence before reversal');
    if (manifest.current.at(-1)?.version !== 48 || manifest.current.at(-1)?.name !== '0048_unused_ai_task_creation_undo.sql'
      || !same(manifest.current.filter(file => file.version !== 48), manifest.prior)
      || sha256(JSON.stringify(manifest.current)) !== manifest.currentSha256 || sha256(JSON.stringify(manifest.prior)) !== manifest.priorSha256
      || manifest.down.name !== '0048_unused_ai_task_creation_undo.down.sql' || sha256(manifest.downSql) !== manifest.down.sha256)
      throw new Error('Exact reviewed reversal manifests and down SQL are required');
    // query_timeout need not cancel the server query. A failed control await can
    // still acquire a session lock or begin a transaction after the API rejects.
    try { await client.query('SELECT pg_advisory_lock(hashtext($1))', ['flux-migrate']); serialized = true; }
    catch (cause) { discard = true; throw cause; }
    began = true;
    try { await client.query('BEGIN'); } catch (cause) { discard = true; throw cause; }
    // NOWAIT refuses an existing holder instead of waiting in an order that could
    // deadlock a writer. Exclusion is retained before every history guard and DDL.
    await client.query(`LOCK TABLE proactive_comparison_proposals, agent_standing_grants,
      project_work_items, project_task_notices, task_creation_undo_receipts IN ACCESS EXCLUSIVE MODE NOWAIT`);
    assertExactMigrationLedger(manifest.current, await readAppliedMigrationVersions(client));
    await client.query(manifest.downSql);
    assertExactMigrationLedger(manifest.current, await readAppliedMigrationVersions(client));
    const removed = await client.query('DELETE FROM flux_schema_version WHERE version=$1 RETURNING version', [48]);
    if (removed.rows.length !== 1 || removed.rows[0]?.version !== 48) throw new Error('Reversal did not remove exactly its own version48 ledger row');
    assertExactMigrationLedger(manifest.prior, await readAppliedMigrationVersions(client));
    committing = true; await client.query('COMMIT'); began = false;
  } catch (cause) {
    // PostgreSQL SQLSTATE refusal is a known query outcome; an unclassified
    // transport rejection must never return a potentially live query to a pool.
    if (serialized && (!(cause instanceof Error) || !('code' in cause)
      || typeof cause.code !== 'string' || !/^[0-9A-Z]{5}$/.test(cause.code) || cause.code.startsWith('08'))) discard = true;
    if (began && !discard) {
      try { await client.query('ROLLBACK'); began = false; } catch { discard = true; }
    }
    if (committing) {
      discard = true;
      throw new Error('Reversal COMMIT outcome is unknown; inspect schema and exact ledger before any retry', { cause });
    }
    throw cause;
  } finally {
    if (serialized && !discard) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['flux-migrate']); }
      catch { discard = true; }
    }
    // Destruction also releases a lock/transaction whose failed control query
    // completed later. Never query or release this client again after this call.
    client.release(discard);
  }
}
