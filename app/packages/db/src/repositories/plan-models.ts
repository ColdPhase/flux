import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PlanModelEntry, PlanModels } from '@flux/contracts';
import type * as schema from '../schema.js';

// A signed-in plan's models as the runtime's supervisor last read them (#1332, migration 0069): one typed row per model in
// `agent_runtime_connection_models`, and on the connection whether the last reading worked and when. Display facts only.

type Exec = Pick<NodePgDatabase<typeof schema>, 'execute'>;

/** The most models a plan keeps as "no longer offered": a plan lists a handful, so this is a bound nobody meets. */
export const MAX_RETIRED_MODELS = 20;
/** Where the retired ones start in the order, after the longest list a reading may carry. */
const RETIRED_FROM = 1000;

type ModelRow = { model_id: string; name: string; note: string; is_default: boolean; sees_pictures: boolean; retired: boolean };

/** The plan's models for a connection whose last reading is `status` at `checkedAt`; null while it was never tried. */
export async function loadPlanModels(db: Exec, connectionId: string, status: 'listed' | 'unavailable' | null, checkedAt: Date | string | null): Promise<PlanModels | null> {
  if (status === null || checkedAt === null) return null;
  const rows = await db.execute<ModelRow>(sql`SELECT model_id, name, note, is_default, sees_pictures, retired FROM agent_runtime_connection_models
    WHERE connection_id = ${connectionId} ORDER BY position`);
  return {
    listed: rows.rows.filter((row) => !row.retired).map((row): PlanModelEntry => ({ id: row.model_id, name: row.name, note: row.note, default: row.is_default, seesPictures: row.sees_pictures })),
    retired: rows.rows.filter((row) => row.retired).map((row) => ({ id: row.model_id, name: row.name })),
    state: status, checkedOn: new Date(checkedAt).toISOString().slice(0, 10),
  };
}

/**
 * Replaces a connection's list with a new reading, inside the caller's transaction. A model the earlier list had that this one lacks was stopped
 * by the plan: it stays as `retired`, with the name the CLI gave it, so its agents can say why they are paused; one that came back is offered
 * again. The oldest retired ones go past {@link MAX_RETIRED_MODELS}.
 */
export async function replacePlanModels(tx: Exec, connectionId: string, read: readonly PlanModelEntry[]): Promise<void> {
  const earlier = await tx.execute<Pick<ModelRow, 'model_id' | 'name' | 'retired'>>(sql`SELECT model_id, name, retired FROM agent_runtime_connection_models
    WHERE connection_id = ${connectionId} ORDER BY retired DESC, position`);
  const now = new Set(read.map((entry) => entry.id));
  const retired = [...new Map(earlier.rows.filter((row) => !now.has(row.model_id)).map((row) => [row.model_id, { id: row.model_id, name: row.name }])).values()].slice(-MAX_RETIRED_MODELS);
  await tx.execute(sql`DELETE FROM agent_runtime_connection_models WHERE connection_id = ${connectionId}`);
  const rows = [
    ...read.map((entry, index) => sql`(${connectionId}, ${entry.id}, ${index}, ${entry.name}, ${entry.note}, ${entry.default}, ${entry.seesPictures}, false)`),
    ...retired.map((entry, index) => sql`(${connectionId}, ${entry.id}, ${RETIRED_FROM + index}, ${entry.name}, '', false, true, true)`),
  ];
  if (rows.length) await tx.execute(sql`INSERT INTO agent_runtime_connection_models(connection_id, model_id, position, name, note, is_default, sees_pictures, retired)
    VALUES ${sql.join(rows, sql`, `)}`);
}

/** Forgets a connection's list: a new sign-in, another account or a sign-out has other models. */
export async function clearPlanModels(tx: Exec, connectionIds: readonly string[]): Promise<void> {
  if (!connectionIds.length) return;
  await tx.execute(sql`DELETE FROM agent_runtime_connection_models WHERE connection_id IN (${sql.join(connectionIds.map((id) => sql`${id}`), sql`, `)})`);
}
