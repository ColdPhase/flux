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

export interface EventIntent {
  readonly principal: Readonly<Principal>;
  readonly workspaceId: string;
  readonly kind: string;
  readonly objectId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Final event storage in the caller's transaction. Resolve every audience before the
 * first insert takes the sequence lock; after that point write only events and their
 * derived audience/outbox records. Domain, coordination and receipt writes precede
 * this call. Events contain canonical identifiers, never copied public content.
 */
export async function recordEvents(tx: Executor, intents: readonly EventIntent[]): Promise<string[]> {
  const prepared: { intent: EventIntent; id: string; recipients: string[] }[] = [];
  for (const intent of intents) prepared.push({ intent, id: randomUUID(),
    recipients: await eventAudience(tx, { kind: intent.kind, workspaceId: intent.workspaceId, objectId: intent.objectId }) });
  for (const { intent, id, recipients } of prepared) {
    const [row] = await tx.insert(schema.events).values({ id, kind: intent.kind, objectId: intent.objectId,
      actorId: principalKey(intent.principal), data: intent.data, workspaceId: intent.workspaceId }).returning({ seq: schema.events.seq });
    if (recipients.length) await tx.insert(schema.eventAudience).values(recipients.map((recipient) => ({ recipient, seq: row!.seq, eventId: id })));
  }
  return prepared.map(({ id }) => id);
}

/** Single-event compatibility entry; the same final-write ordering applies. */
export async function recordEvent(tx: Executor, principal: Principal, workspaceId: string, kind: string, objectId: string, data: Record<string, unknown>) {
  return (await recordEvents(tx, [{ principal, workspaceId, kind, objectId, data }]))[0]!;
}
