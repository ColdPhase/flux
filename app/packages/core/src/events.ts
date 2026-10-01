import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@flux/db';
import { authorizeEvent, type EventRef } from './access/policy.js';
import type { Executor, Principal } from './types.js';

/** The actor column format of events: `<kind>:<id>`. */
export function principalKey(principal: Principal) {
  return `${principal.kind}:${principal.id}`;
}

/** Principals that could possibly read an event of `workspaceId`: its members and unrevoked agents. */
async function candidates(tx: Executor, workspaceId: string): Promise<Principal[]> {
  const members = await tx.select({ id: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
  const agents = await tx.select({ id: schema.agents.id }).from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.revokedAt)));
  return [...members.map(({ id }) => ({ kind: 'human' as const, id })), ...agents.map(({ id }) => ({ kind: 'agent' as const, id }))];
}

/**
 * The stream audience of an event: every principal the access policy lets read the
 * event's object, evaluated inside the writing transaction so it sees that transaction's
 * own change (a share, a removal). Stored as `event_audience` rows; delivery re-checks.
 */
export async function eventAudience(tx: Executor, event: EventRef): Promise<string[]> {
  if (!event.workspaceId) return [];
  const recipients: string[] = [];
  for (const principal of await candidates(tx, event.workspaceId)) {
    if (await authorizeEvent(principal, event, tx)) recipients.push(principalKey(principal));
  }
  return recipients;
}

/**
 * Records a versioned event in the caller's transaction, with one `event_audience` row per
 * principal that may read it (the per-recipient stream index). Events carry identifiers
 * and audience, never content. The audience is decided before the event insert: the seq
 * trigger takes a lock held until commit, so write the event as the last statement of a
 * transaction and keep the work after the insert to the audience rows.
 */
export async function recordEvent(tx: Executor, principal: Principal, workspaceId: string, kind: string, objectId: string, data: Record<string, unknown>) {
  const id = randomUUID();
  const recipients = await eventAudience(tx, { kind, workspaceId, objectId });
  const [row] = await tx.insert(schema.events).values({ id, kind, objectId, actorId: principalKey(principal), data, workspaceId }).returning({ seq: schema.events.seq });
  if (recipients.length) await tx.insert(schema.eventAudience).values(recipients.map((recipient) => ({ recipient, seq: row!.seq, eventId: id })));
  return id;
}
