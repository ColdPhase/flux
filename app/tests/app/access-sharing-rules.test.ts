import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { and, count, eq } from 'drizzle-orm';
import { accessPorts, schema } from '@flux/db';
import {
  addMember,
  ConflictError,
  createAgent,
  createDraft,
  createProject,
  createWorkspace,
  DomainError,
  ForbiddenError,
  grantProject,
  moveDraft,
  removeMember,
  revokeAgent,
  RuleViolationError,
  shareDraft,
  type Principal,
} from '@flux/core';
import { db, insertedHuman, pool } from './support/db.js';
import { interleave } from './support/locks.js';

// The audience, target and grantee rules of the draft and grant use cases, and the constraint violations of a grant write,
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

async function draftRow(id: string) {
  const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  return row!;
}

async function grantsOf(projectId: string, userId: string) {
  return db.select().from(schema.projectGrants).where(and(eq(schema.projectGrants.projectId, projectId), eq(schema.projectGrants.userId, userId)));
}

async function grantEvents(projectId: string) {
  const [row] = await db.select({ n: count() }).from(schema.events).where(and(eq(schema.events.kind, 'project.grant_set.v1'), eq(schema.events.objectId, projectId)));
  return row!.n;
}

describe('draft audience and target rules through the SQL repositories', () => {
  test('RESTRICTED_PROJECT: a draft in a restricted project is never shared with the whole workspace, by share or by move', async () => {
    const { owner, ws } = await scene('restricted');
    const vault = await createProject(owner, ws.id, { name: 'Vault', visibility: 'restricted' }, db, accessPorts);
    const open = await createProject(owner, ws.id, { name: 'Open', visibility: 'workspace' }, db, accessPorts);
    const inVault = await createDraft(owner, ws.id, { title: 'Vault notes', projectId: vault.id }, db, accessPorts);
    await assert.rejects(shareDraft(owner, inVault.id, { scope: 'workspace', expectedVersion: inVault.version }, db, accessPorts),
      (error) => on(error, RuleViolationError, 422, 'RESTRICTED_PROJECT'));
    const loose = await createDraft(owner, ws.id, { title: 'Loose notes', projectId: open.id }, db, accessPorts);
    await assert.rejects(moveDraft(owner, loose.id, { projectId: vault.id, visibility: 'workspace', expectedVersion: loose.version }, db, accessPorts),
      (error) => on(error, RuleViolationError, 422, 'RESTRICTED_PROJECT'));
    for (const before of [inVault, loose]) {
      const after = await draftRow(before.id);
      assert.deepEqual([after.version, after.visibility, after.projectId], [before.version, 'private', before.projectId], 'a refused change writes nothing');
    }
    assert.equal((await shareDraft(owner, inVault.id, { scope: 'project', expectedVersion: inVault.version }, db, accessPorts)).visibility, 'project', 'the project audience is allowed');
  });

  test('WORKSPACE_SHARE_FORBIDDEN: a guest and an agent cannot share with the whole workspace, by share or by move', async () => {
    const { owner, guest, ws } = await scene('share-forbidden');
    const mine = await createDraft(guest, ws.id, { title: 'Guest notes' }, db, accessPorts);
    await assert.rejects(shareDraft(guest, mine.id, { scope: 'workspace', expectedVersion: mine.version }, db, accessPorts),
      (error) => on(error, ForbiddenError, 403, 'WORKSPACE_SHARE_FORBIDDEN'));
    await assert.rejects(moveDraft(guest, mine.id, { projectId: null, visibility: 'workspace', expectedVersion: mine.version }, db, accessPorts),
      (error) => on(error, ForbiddenError, 403, 'WORKSPACE_SHARE_FORBIDDEN'));

    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'workspace' }, db, accessPorts);
    const agent = await createAgent(owner, ws.id, { name: 'Helper', owner: 'workspace' }, db, accessPorts);
    const bot: Principal = { kind: 'agent', id: agent.id };
    await grantProject(owner, room.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, db, accessPorts);
    const botDraft = await createDraft(bot, ws.id, { title: 'Agent notes', projectId: room.id }, db, accessPorts);
    await assert.rejects(shareDraft(bot, botDraft.id, { scope: 'workspace', expectedVersion: botDraft.version }, db, accessPorts),
      (error) => on(error, ForbiddenError, 403, 'WORKSPACE_SHARE_FORBIDDEN'));
    for (const before of [mine, botDraft]) {
      const after = await draftRow(before.id);
      assert.deepEqual([after.version, after.visibility], [before.version, 'private'], 'a refused change writes nothing');
    }
  });

  test('PROJECT_WRITE_REQUIRED: a project the caller can only read is not a target for a draft, whether created, shared or moved', async () => {
    const { owner, member, ws } = await scene('write-required');
    const room = await createProject(owner, ws.id, { name: 'Read only', visibility: 'restricted' }, db, accessPorts);
    await grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'viewer' }, db, accessPorts);
    await assert.rejects(createDraft(member, ws.id, { title: 'Into the room', projectId: room.id }, db, accessPorts),
      (error) => on(error, ForbiddenError, 403, 'PROJECT_WRITE_REQUIRED'));
    const mine = await createDraft(member, ws.id, { title: 'Mine' }, db, accessPorts);
    await assert.rejects(shareDraft(member, mine.id, { scope: 'project', projectId: room.id, expectedVersion: mine.version }, db, accessPorts),
      (error) => on(error, ForbiddenError, 403, 'PROJECT_WRITE_REQUIRED'));
    await assert.rejects(moveDraft(member, mine.id, { projectId: room.id, visibility: 'project', expectedVersion: mine.version }, db, accessPorts),
      (error) => on(error, ForbiddenError, 403, 'PROJECT_WRITE_REQUIRED'));
    const after = await draftRow(mine.id);
    assert.deepEqual([after.version, after.visibility, after.projectId], [mine.version, 'private', null], 'a refused change writes nothing');
    const [{ n }] = await db.select({ n: count() }).from(schema.drafts).where(eq(schema.drafts.workspaceId, ws.id));
    assert.equal(n, 1, 'the refused create left no draft behind');
  });
});

describe('grantees and grant writes through the SQL repositories', () => {
  test('AGENT_NOT_IN_WORKSPACE and NOT_A_MEMBER: a grant names only a member or an active agent of the project workspace', async () => {
    const { owner, ws } = await scene('grantee');
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const elsewhere = await createWorkspace(owner, { name: 'grantee-elsewhere' }, db, accessPorts);
    const strangerAgent = await createAgent(owner, elsewhere.id, { name: 'Elsewhere', owner: 'workspace' }, db, accessPorts);
    const retired = await createAgent(owner, ws.id, { name: 'Retired', owner: 'workspace' }, db, accessPorts);
    await revokeAgent(owner, retired.id, db, accessPorts);
    for (const [label, id] of [['an agent of another workspace', strangerAgent.id], ['a revoked agent', retired.id], ['an id that is not a UUID', 'not-a-uuid']] as const) {
      await assert.rejects(grantProject(owner, room.id, { principal: { kind: 'agent', id }, role: 'viewer' }, db, accessPorts),
        (error) => on(error, RuleViolationError, 422, 'AGENT_NOT_IN_WORKSPACE'), label);
    }
    const outsider = await insertedHuman('grantee-outsider');
    await assert.rejects(grantProject(owner, room.id, { principal: { kind: 'human', id: outsider.id }, role: 'viewer' }, db, accessPorts),
      (error) => on(error, RuleViolationError, 422, 'NOT_A_MEMBER'));
    const [{ n }] = await db.select({ n: count() }).from(schema.projectGrants).where(eq(schema.projectGrants.projectId, room.id));
    assert.equal(n, 0, 'no refused grant left a row');
  });

  test('GRANT_CONFLICT: a grant for the same principal committed while this one waits on the unique index (23505)', async () => {
    const { owner, member, ws } = await scene('grant-conflict');
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const { firstResult, secondResult } = await interleave(db, pool,
      // Another writer's grant for the same person, uncommitted: this session's `FOR UPDATE` read does not see it, its insert waits for it.
      async (tx) => tx.insert(schema.projectGrants).values({ id: randomUUID(), workspaceId: ws.id, projectId: room.id, userId: member.id, role: 'viewer', createdBy: owner.id }).returning(),
      () => grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'contributor' }, db, accessPorts));
    assert.equal(firstResult.length, 1);
    assert.ok(on(secondResult.error, ConflictError, 409, 'GRANT_CONFLICT'), `got ${String(secondResult.error)}`);
    const rows = await grantsOf(room.id, member.id);
    assert.deepEqual(rows.map((row) => row.role), ['viewer'], 'only the committed grant remains');
    assert.equal(await grantEvents(room.id), 0, 'the refused grant wrote no event');
  });

  test('GRANTEE_REMOVED: the grantee left the workspace while this grant waited on the membership row (23503)', async () => {
    const { owner, member, ws } = await scene('grantee-removed');
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const { secondResult } = await interleave(db, pool,
      // The removal is uncommitted: this session still reads the membership, and its grant insert waits for the membership row's lock.
      (tx) => removeMember(owner, ws.id, member.id, tx, accessPorts),
      () => grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'viewer' }, db, accessPorts));
    assert.ok(on(secondResult.error, ConflictError, 409, 'GRANTEE_REMOVED'), `got ${String(secondResult.error)}`);
    assert.deepEqual(await grantsOf(room.id, member.id), [], 'no grant outlives the membership');
    assert.equal(await grantEvents(room.id), 0, 'the refused grant wrote no event');
  });
});
