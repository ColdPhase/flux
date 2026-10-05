import { typingRows } from '@flux/db';
import { authorize, dmClosedFor, type Database, type TypingAccessPorts, type TypingTaskDiscussion } from '@flux/core';

/** Composes exact live human sessions with the existing single native policy. */
export function typingAccess(db: Database, tasks?: TypingTaskDiscussion): TypingAccessPorts {
  const rows = typingRows(db);
  return {
    currentHuman: (actor) => rows.currentHuman(actor),
    async canonicalContext(principal, context, action) {
      principal = { ...principal };
      context = { ...context };
      if (principal.kind !== 'human') return null;
      if (context.kind === 'dm') {
        if (!(await authorize(principal, action === 'write' ? 'dm.write' : 'dm.read', { type: 'dm', id: context.id }, db)).allowed) return null;
        if (action === 'write' && await dmClosedFor(db, context.id, principal.id)) return null;
        return { ...context };
      }
      const located = await rows.locate(context);
      if (!located || !(await authorize(principal, action === 'write' ? 'project.write' : 'project.read', { type: 'project', id: located.projectId }, db)).allowed) return null;
      if (context.kind === 'conversation') return { ...context };
      // Main has no accepted task-discussion mapping yet. Do not invent or create a root.
      const conversationId = tasks ? await tasks.conversation(principal, context.id) : null;
      if (!conversationId) return null;
      const canonical = { kind: 'conversation' as const, id: conversationId };
      const discussion = await rows.locate(canonical);
      return discussion?.projectId === located.projectId ? canonical : null;
    },
  };
}
