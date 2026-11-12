import type { LiveContextRef } from '@flux/contracts';
import type { schema } from '@flux/db';

type SessionRow = Pick<typeof schema.liveSessions.$inferSelect, 'projectId' | 'conversationId' | 'workId' | 'sketchId' | 'docId'>;

/** Where a session belongs, from its row: the one object it names, or the space itself when it names none (F-041, migration 0055). */
export function liveContextOf(row: SessionRow): LiveContextRef {
  if (row.conversationId) return { type: 'conversation', id: row.conversationId };
  if (row.workId) return { type: 'work', id: row.workId };
  if (row.sketchId) return { type: 'sketch', id: row.sketchId };
  if (row.docId) return { type: 'doc', id: row.docId };
  return { type: 'space', id: row.projectId };
}

/** The row's columns for a context; a call of the space names none of them. */
export function liveContextColumns(context: LiveContextRef) {
  return {
    conversationId: context.type === 'conversation' ? context.id : null,
    workId: context.type === 'work' ? context.id : null,
    sketchId: context.type === 'sketch' ? context.id : null,
    docId: context.type === 'doc' ? context.id : null,
  };
}

export function sameLiveContext(left: LiveContextRef, right: LiveContextRef): boolean {
  return left.type === right.type && left.id === right.id;
}
