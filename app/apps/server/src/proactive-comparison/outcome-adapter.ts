import { comparisonOutcomeRows, type DbExecutor } from '@flux/db';
import { authorize, comparisonOutcomeUseCases, enforce, evaluateProject, type ComparisonOutcomePorts, type Database } from '@flux/core';

export function comparisonOutcomeAccess(tx: DbExecutor): ComparisonOutcomePorts['access'] {
  const rows = comparisonOutcomeRows(tx);
  return {
    async requireProject(principal, projectId, mode) {
      enforce(await evaluateProject(principal, mode === 'write' ? 'project.write' : 'project.read', projectId,
        tx, { lock: true }), 'project');
    },
    async canOpenSource(principal, projectId, source) {
      if (!await rows.sourceExists(projectId, source)) return false;
      if (source.type === 'thought')
        return (await authorize(principal, 'sketch.read', { type: 'sketch', id: source.sketchId! }, tx, { lock: true })).allowed;
      return (await evaluateProject(principal, 'project.read', projectId, tx, { lock: true })).allowed;
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
