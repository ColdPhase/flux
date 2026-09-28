import { proactiveOutboxRows } from '@flux/db';
import { evaluateProject, reservationUseCases, type Database, type ReservationPorts } from '@flux/core';

/** Internal composition for a future worker; no HTTP endpoint or scheduled provider call. */
export function proactiveReservation(db: Database) {
  return reservationUseCases({ run: (action) => db.transaction(async (tx) => {
    const rows = proactiveOutboxRows(tx);
    const ports: ReservationPorts = {
      rows,
      access: {
        async currentOwnerAndAgent(ownerId, agentId, projectId) {
          const owner = await evaluateProject({ kind: 'human', id: ownerId }, 'project.write', projectId, tx, { lock: true });
          const agent = await evaluateProject({ kind: 'agent', id: agentId }, 'project.write', projectId, tx, { lock: true });
          return owner.allowed && agent.allowed && agent.actor?.agent?.ownerUserId === ownerId;
        },
      },
    };
    return action(ports);
  }) });
}
