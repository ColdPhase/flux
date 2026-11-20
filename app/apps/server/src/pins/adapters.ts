import { and, eq } from 'drizzle-orm';
import { createPinUseCases, enforce, evaluateAgent, evaluateDm, evaluateProject, ForbiddenError, NotFoundError, recordEvent, type PinPorts, type PinUnitOfWork, type PinTargetRef } from '@flux/core';
import { accessReader, messagePinRows, schema, type Database, type PinTarget, type Transaction } from '@flux/db';
import { eventPorts } from '../events.js';

// Adapters of pinned messages (C-74, #1615): the access policy decides who reads and writes a conversation, exactly as it does for its
// messages (a space's `project.read` / `project.write`, a direct message's participants, an agent's chat its owner), and `@flux/db` keeps the rows.

function pinPorts(tx: Transaction): PinPorts {
  const reader = accessReader(tx);
  const rows = messagePinRows(tx);
  return {
    access: {
      async require(principal, place, action) {
        const write = action === 'write';
        if (place.type === 'project') {
          const { project } = enforce(await evaluateProject(principal, write ? 'project.write' : 'project.read', place.id, reader, { lock: write }), 'project');
          return { workspaceId: project!.workspaceId };
        }
        if (place.type === 'dm') {
          const { dm } = enforce(await evaluateDm(principal, write ? 'dm.write' : 'dm.read', place.id, reader, { lock: write }), 'dm');
          // A 1:1 whose other person left takes no new messages: its person still reads it, and its list, but pins nothing (a reader).
          if (write) {
            const [found] = await tx.select({ kind: schema.dms.kind }).from(schema.dms).where(eq(schema.dms.id, place.id));
            const people = await tx.select({ id: schema.dmParticipants.userId }).from(schema.dmParticipants).where(eq(schema.dmParticipants.dmId, place.id));
            if (found?.kind === 'pair' && people.length < 2) throw new ForbiddenError('This conversation takes no new messages, so nothing can be pinned in it', 'PIN_NOT_ALLOWED');
          }
          return { workspaceId: dm!.workspaceId };
        }
        // An agent's chat is its owner's alone, while the agent is theirs and not revoked; anyone else is told it is not there.
        const { agent } = await evaluateAgent(principal, 'agent.read', place.id, reader, { lock: write });
        if (!agent || principal.kind !== 'human' || agent.ownerUserId !== principal.id || agent.revokedAt) throw new NotFoundError('Agent', 'AGENT_NOT_FOUND');
        const [chat] = await tx.select({ id: schema.assistantSettings.agentId }).from(schema.assistantSettings).where(and(eq(schema.assistantSettings.agentId, place.id)));
        if (!chat) throw new NotFoundError('Agent', 'AGENT_NOT_FOUND');
        return { workspaceId: agent.workspaceId, ownerUserId: agent.ownerUserId };
      },
    },
    pins: {
      target: (place, workspaceId, messageId, part) => rows.target(place, workspaceId, messageId, part),
      pin: (target: PinTargetRef, pinnedBy) => rows.pin(target as PinTarget, pinnedBy),
      unpin: (target: PinTargetRef) => rows.unpin(target as PinTarget),
      list: (place, workspaceId, limit) => rows.list(place, workspaceId, limit),
    },
    events: { record: async (principal, workspaceId, kind, objectId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, objectId, data); } },
  };
}

/** One transaction per use case. */
export function pinUnitOfWork(db: Database): PinUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(pinPorts(tx))) };
}

export const pinUseCases = (db: Database) => createPinUseCases(pinUnitOfWork(db));
