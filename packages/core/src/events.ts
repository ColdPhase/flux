import { randomUUID } from 'node:crypto';
import { schema } from '@flux/db';
import type { Executor, Principal } from './types.js';

/** The actor column format of events: `<kind>:<id>`. */
export function principalKey(principal: Principal) {
  return `${principal.kind}:${principal.id}`;
}

/**
 * Records a versioned event in the caller's transaction. Events carry identifiers and
 * audience, never content; the stream filters them per recipient through the policy.
 * Write the event as the last statement of a transaction: the seq trigger takes a lock
 * that is held until commit.
 */
export async function recordEvent(tx: Executor, principal: Principal, workspaceId: string, kind: string, objectId: string, data: Record<string, unknown>) {
  const id = randomUUID();
  await tx.insert(schema.events).values({ id, kind, objectId, actorId: principalKey(principal), data, workspaceId });
  return id;
}
