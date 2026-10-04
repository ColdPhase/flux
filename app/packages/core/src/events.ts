import { randomUUID } from 'node:crypto';
import { authorizeEvent, type EventRef } from './access/policy.js';
import type { Executor, Principal } from './types.js';

/** The actor column format of events: `<kind>:<id>`. */
export function principalKey(principal: Principal) {
  return `${principal.kind}:${principal.id}`;
}

/** One stored event and its stream audience, as the repository writes them (#89). */
export interface StoredEvent {
  id: string;
  kind: string;
  objectId: string;
  /** `principalKey` of the actor. */
  actorId: string;
  data: Readonly<Record<string, unknown>>;
  workspaceId: string;
}

/** Event storage bound to the writing transaction (#89); `@flux/db` `eventRepository` implements it. */
export interface EventRepository {
  /** Principals that could possibly read an event of `workspaceId`: its members and unrevoked agents. */
  candidates(workspaceId: string): Promise<Principal[]>;
  /** Inserts the event and one `event_audience` row per recipient. The insert takes the sequence lock. */
  insert(event: StoredEvent, recipients: readonly string[]): Promise<void>;
}

/** Whether `principal` may read the event's object now, decided inside the writing transaction. */
export type EventAuthorizer = (principal: Principal, event: EventRef) => Promise<boolean>;

export interface EventPorts {
  repository: EventRepository;
  authorize: EventAuthorizer;
}

/** The access policy as the event authorizer, inside `tx`, with the repository bound to the same transaction. */
export function policyEventPorts(tx: Executor, repository: EventRepository): EventPorts {
  return { repository, authorize: (principal, event) => authorizeEvent(principal, event, tx) };
}

/**
 * The stream audience of an event: every principal the access policy lets read the
 * event's object, evaluated inside the writing transaction so it sees that transaction's
 * own change (a share, a removal). Stored as `event_audience` rows; delivery re-checks.
 */
export async function eventAudience(ports: EventPorts, event: EventRef): Promise<string[]> {
  if (!event.workspaceId) return [];
  const recipients: string[] = [];
  for (const principal of await ports.repository.candidates(event.workspaceId)) {
    if (await ports.authorize(principal, event)) recipients.push(principalKey(principal));
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
export async function recordEvents(ports: EventPorts, intents: readonly EventIntent[]): Promise<string[]> {
  const prepared: { intent: EventIntent; id: string; recipients: string[] }[] = [];
  for (const intent of intents) prepared.push({ intent, id: randomUUID(),
    recipients: await eventAudience(ports, { kind: intent.kind, workspaceId: intent.workspaceId, objectId: intent.objectId }) });
  for (const { intent, id, recipients } of prepared) {
    await ports.repository.insert({ id, kind: intent.kind, objectId: intent.objectId, actorId: principalKey(intent.principal),
      data: intent.data, workspaceId: intent.workspaceId }, recipients);
  }
  return prepared.map(({ id }) => id);
}

/** Single-event compatibility entry; the same final-write ordering applies. */
export async function recordEvent(ports: EventPorts, principal: Principal, workspaceId: string, kind: string, objectId: string, data: Record<string, unknown>) {
  return (await recordEvents(ports, [{ principal, workspaceId, kind, objectId, data }]))[0]!;
}
