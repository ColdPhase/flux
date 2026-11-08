import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { and, count, eq } from 'drizzle-orm';
import { accessPorts, schema } from '@flux/db';
import {
  addMember,
  ConflictError,
  createAgent,
  createProject,
  createWorkspace,
  DomainError,
  grantProject,
  removeMember,
  revokeAgent,
  RuleViolationError,
} from '@flux/core';
import { db, insertedHuman, pool } from './support/db.js';
import { interleave } from './support/locks.js';

// The grantee rules of the grant use cases, and the constraint violations of a grant write,
// through the real SQL repositories on the Compose PostgreSQL (issues #46, #91). access-use-cases.test.ts pins the statement order over
// in-memory ports; here the rows are real, so a rule that moved into a repository or lost its condition fails.

const on = (error: unknown, type: new (...args: never[]) => DomainError, status: number, code: string) =>
  error instanceof type && error.status === status && error.code === code;

/** An owner, a member and a guest of one workspace. */
async function scene(label: string) {
  const owner = await insertedHuman(`${label}-owner`);
  const member = await insertedHuman(`${label}-member`);
  const guest = await insertedHuman(`${label}-guest`);
  const ws = await createWorkspace(owner, { name: label }, db, accessPorts);
  await addMember(owner, ws.id, { userId: member.id, role: 'member' }, db, accessPorts);
  await addMember(owner, ws.id, { userId: guest.id, role: 'guest' }, db, accessPorts);
  return { owner, member, guest, ws };
}

async function grantsOf(projectId: string, userId: string) {
  return db.select().from(schema.projectGrants).where(and(eq(schema.projectGrants.projectId, projectId), eq(schema.projectGrants.userId, userId)));
}

async function grantEvents(projectId: string) {
  const [row] = await db.select({ n: count() }).from(schema.events).where(and(eq(schema.events.kind, 'project.grant_set.v1'), eq(schema.events.objectId, projectId)));
  return row!.n;
}

describe('grantees and grant writes through the SQL repositories', () => {
  test('AGENT_NOT_IN_WORKSPACE and NOT_A_MEMBER: a grant names only a member or an active agent of the project workspace', async () => {
    const { owner, ws } = await scene('grantee');
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const elsewhere = await createWorkspace(owner, { name: 'grantee-elsewhere' }, db, accessPorts);
    const strangerAgent = await createAgent(owner, elsewhere.id, { name: 'Elsewhere', owner: 'self' }, db, accessPorts);
    const retired = await createAgent(owner, ws.id, { name: 'Retired', owner: 'self' }, db, accessPorts);
    await revokeAgent(owner, retired.id, db, accessPorts);
    // An agent has no grant of its own (F-036 AG-3): any agent principal is refused as input.
    for (const [label, id] of [['an agent of another workspace', strangerAgent.id], ['a revoked agent', retired.id], ['an id that is not a UUID', 'not-a-uuid']] as const) {
      await assert.rejects(grantProject(owner, room.id, { principal: { kind: 'agent', id }, role: 'contributor' } as never, db, accessPorts),
        (error) => (error as { code?: string }).code === 'INVALID_INPUT', label);
    }
    const outsider = await insertedHuman('grantee-outsider');
    await assert.rejects(grantProject(owner, room.id, { principal: { kind: 'human', id: outsider.id }, role: 'contributor' }, db, accessPorts),
      (error) => on(error, RuleViolationError, 422, 'NOT_A_MEMBER'));
    const [{ n }] = await db.select({ n: count() }).from(schema.projectGrants).where(eq(schema.projectGrants.projectId, room.id));
    assert.equal(n, 1, 'no refused grant left a row: only the creator\'s own admin grant (F-037)');
  });

  test('GRANT_CONFLICT: a grant for the same principal committed while this one waits on the unique index (23505)', async () => {
    const { owner, member, ws } = await scene('grant-conflict');
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const { firstResult, secondResult } = await interleave(db, pool,
      // Another writer's grant for the same person, uncommitted: this session's `FOR UPDATE` read does not see it, its insert waits for it.
      async (tx) => tx.insert(schema.projectGrants).values({ id: randomUUID(), workspaceId: ws.id, projectId: room.id, userId: member.id, role: 'contributor', createdBy: owner.id }).returning(),
      () => grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'contributor' }, db, accessPorts));
    assert.equal(firstResult.length, 1);
    assert.ok(on(secondResult.error, ConflictError, 409, 'GRANT_CONFLICT'), `got ${String(secondResult.error)}`);
    const rows = await grantsOf(room.id, member.id);
    assert.deepEqual(rows.map((row) => row.role), ['contributor'], 'only the committed grant remains');
    assert.equal(await grantEvents(room.id), 0, 'the refused grant wrote no event');
  });

  test('GRANTEE_REMOVED: the grantee left the workspace while this grant waited on the membership row (23503)', async () => {
    const { owner, member, ws } = await scene('grantee-removed');
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const { secondResult } = await interleave(db, pool,
      // The removal is uncommitted: this session still reads the membership, and its grant insert waits for the membership row's lock.
      (tx) => removeMember(owner, ws.id, member.id, tx, accessPorts),
      () => grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'contributor' }, db, accessPorts));
    assert.ok(on(secondResult.error, ConflictError, 409, 'GRANTEE_REMOVED'), `got ${String(secondResult.error)}`);
    assert.deepEqual(await grantsOf(room.id, member.id), [], 'no grant outlives the membership');
    assert.equal(await grantEvents(room.id), 0, 'the refused grant wrote no event');
  });
});
