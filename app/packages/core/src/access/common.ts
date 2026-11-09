import type { WorkspaceRole } from '@flux/contracts';
import { randomUUID } from 'node:crypto';
import { policyEventPorts, principalKey } from '../events.js';
import type { Executor, Principal } from '../types.js';
import { ForbiddenError } from './errors.js';
import type { Actor } from './policy.js';
import type { AccessPorts } from './repositories.js';

// What the workspace, project and agent use cases (issues #46, #91) have in common.
//
// Every use case authorizes through ./policy.ts before touching data; mutations decide and write in the
// same transaction with the rows the decision depends on locked (membership/agent, project and
// the actor's grants on it). Membership, grant and agent changes take conflicting locks on the rows they
// change, so a concurrent revocation is either seen or waits until the mutation commits. Entry points
// must call these use cases, never the tables. Events are the last write of a mutation.

/** Events of these use cases: the access policy decides the audience; `@flux/db` stores (#89). */
export function eventPorts(ports: Pick<AccessPorts, 'access' | 'events'>, tx: Executor) {
  return policyEventPorts(ports.access(tx), ports.events(tx));
}

/**
 * A person's place in a company or an encrypted space ended: removed, or they left (#862). Every other event of it is decided by who can
 * read it, so they would hear nothing, and their open tabs would keep what they had read. `workspace.access_ended.v1` goes to them alone,
 * by name, and the stream lets this one kind through from their own row although they are no longer a member (`authorizeDelivery`); their
 * tabs forget what they kept and read their shell again. It names the workspace and nothing else; the actor is stored, never sent.
 */
export async function recordAccessEnded(ports: Pick<AccessPorts, 'access' | 'events'>, tx: Executor, principal: Principal, workspaceId: string, userId: string) {
  await eventPorts(ports, tx).repository.insert({ id: randomUUID(), kind: 'workspace.access_ended.v1', objectId: workspaceId, actorId: principalKey(principal), data: {}, workspaceId },
    [principalKey({ kind: 'human', id: userId })]);
}

/** Only an owner may create, change or remove another owner; admins manage admins, members and guests. */
export function requireRoleAuthority(actor: Actor, ...roles: WorkspaceRole[]) {
  if (roles.includes('owner') && actor.role !== 'owner') throw new ForbiddenError('Only an owner can grant, change or remove the owner role', 'OWNER_REQUIRED');
}

/** Optional transaction composition: prepare grant/project events, then flush after all related writes. */
export interface DomainEventSink {
  record(principal: Principal, workspaceId: string, kind: string, objectId: string, data: Record<string, unknown>): Promise<void>;
}
