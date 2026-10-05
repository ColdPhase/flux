import { comparisonSchedulingRows } from '@flux/db';
import { collectComparisonSourceChanges, COMPARISON_EVENT_BATCH, reconsiderComparisonSources, type Database } from '@flux/core';
import { comparisonScheduling } from './scheduling-adapter.js';

/** Selects ready candidate ids only; no key or provider port is present. Registered by
 * `registerComparisonWorker` when the operator switched background comparisons on (#58). */
export async function comparisonSchedulingTick(db: Database, now = new Date(),
  log: (message: string, details: Record<string, number>) => void = (message, details) => console.warn(message, details)) {
  const unit = comparisonScheduling(db);
  let events = 0; let projects = 0; let created = 0; let obsolete = 0;
  for (;;) {
    const result = await collectComparisonSourceChanges(unit, now);
    events += result.processed;
    if (result.recovered) log('Comparison event cursor recovered; enabled projects reconsidered', { cursor: result.cursor, projects: result.marked });
    if (result.processed < COMPARISON_EVENT_BATCH) break;
  }
  for (;;) {
    const result = await reconsiderComparisonSources(unit, now);
    projects += result.processed; created += result.created; obsolete += result.obsolete;
    if (result.processed < 100) break;
  }
  // New commits since collection keep this empty; the next tick catches them.
  const readyIds = await comparisonSchedulingRows(db).readyIds(now, 100);
  return { events, projects, created, obsolete, readyIds };
}
