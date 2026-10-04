import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle adapter for event recording (#46, #89). It satisfies core's `EventRepository` port
 * structurally; core decides the audience. Bind it to the writing transaction: the event insert is
 * the transaction's last event statement and takes the sequence trigger's lock
 * (`pg_advisory_xact_lock(hashtext('flux.events.seq'))`).
 */
export function eventRepository(db: DbExecutor) {
  return {
    async candidates(workspaceId: string): Promise<{ kind: 'human' | 'agent'; id: string }[]> {
      const members = await db.select({ id: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
      const agents = await db.select({ id: schema.agents.id }).from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.revokedAt)));
      return [...members.map(({ id }) => ({ kind: 'human' as const, id })), ...agents.map(({ id }) => ({ kind: 'agent' as const, id }))];
    },
    async insert(event: { id: string; kind: string; objectId: string; actorId: string; data: Readonly<Record<string, unknown>>; workspaceId: string },
      recipients: readonly string[]): Promise<void> {
      const [row] = await db.insert(schema.events).values({ id: event.id, kind: event.kind, objectId: event.objectId,
        actorId: event.actorId, data: event.data, workspaceId: event.workspaceId }).returning({ seq: schema.events.seq });
      if (recipients.length) await db.insert(schema.eventAudience).values(recipients.map((recipient) => ({ recipient, seq: row!.seq, eventId: event.id })));
    },
  };
}
