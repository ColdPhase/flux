import { comparisonSchedulingRows } from '@flux/db';
import { evaluateProject, type ComparisonSchedulingUnitOfWork, type Database } from '@flux/core';

/** Controlled scheduling composition; not registered or a grant to invoke compute. */
export function comparisonScheduling(db: Database): ComparisonSchedulingUnitOfWork {
  return { run: (action) => db.transaction((tx) => {
    const rows = comparisonSchedulingRows(tx);
    return action({ ...rows, access: {
      async currentOwnerAndAgent(rule) {
        const owner = await evaluateProject({ kind: 'human', id: rule.ownerUserId }, 'project.write', rule.projectId, tx, { lock: true });
        const agent = await evaluateProject({ kind: 'agent', id: rule.agentId }, 'project.write', rule.projectId, tx, { lock: true });
        return owner.allowed && agent.allowed && agent.actor?.agent?.ownerUserId === rule.ownerUserId;
      },
    } });
  }) };
}
