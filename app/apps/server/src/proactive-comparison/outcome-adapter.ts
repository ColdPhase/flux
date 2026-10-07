import { comparisonOutcomeRows, type DbExecutor } from '@flux/db';
import { authorize, comparisonOutcomeUseCases, enforce, evaluateProject, type ComparisonOutcomePorts, type Database } from '@flux/core';

/**
 * The central policy for outcome operations. A change holds the access rows it decided on (`lock`);
 * a read inside a read-only snapshot needs no locks, since every decision and row comes from the
 * same snapshot.
 */
export function comparisonOutcomeAccess(tx: DbExecutor, lock = true): ComparisonOutcomePorts['access'] {
  const rows = comparisonOutcomeRows(tx);
  return {
    async requireProject(principal, projectId, mode) {
      enforce(await evaluateProject(principal, mode === 'write' ? 'project.write' : 'project.read', projectId,
        tx, { lock }), 'project');
    },
    async canOpenSource(principal, projectId, source) {
      if (!await rows.sourceExists(projectId, source)) return false;
      if (source.type === 'thought')
        return (await authorize(principal, 'sketch.read', { type: 'sketch', id: source.sketchId! }, tx, { lock })).allowed;
      return (await evaluateProject(principal, 'project.read', projectId, tx, { lock })).allowed;
    },
  };
}

/** Compose the outcome ports with the current central policy in one transaction per operation. */
export function comparisonOutcomes(db: Database) {
  return comparisonOutcomeUseCases({ run: (action) => db.transaction((tx) => {
    const rows = comparisonOutcomeRows(tx);
    return action({ outcomes: rows, access: comparisonOutcomeAccess(tx) });
  }) });
}

/**
 * The read-only operations (the outcome page and usage) in one read-only repeatable-read snapshot
 * per call, without row locks (#298): share-locking the access rows made every Tasks view read
 * write WAL and wait for its flush at commit. Changes use `comparisonOutcomes`.
 */
export function comparisonOutcomeReads(db: Database) {
  const reads = comparisonOutcomeUseCases({ run: (action) => db.transaction((tx) =>
    action({ outcomes: comparisonOutcomeRows(tx), access: comparisonOutcomeAccess(tx, false) }),
  { isolationLevel: 'repeatable read', accessMode: 'read only' }) });
  return { list: reads.list, usage: reads.usage };
}
