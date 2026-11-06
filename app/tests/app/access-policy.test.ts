import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { count, eq } from 'drizzle-orm';
import { accessPorts, schema, visibleFilter, accessReader, type Database } from '@flux/db';
import {
  addMember,
  authorize,
  changeRole,
  assertAuthorized,
  createAgent,
  createDraft,
  createProject,
  createWorkspace,
  ForbiddenError,
  getDraft,
  getProject,
  grantProject,
  listProjects,
  listWorkspaces,
  NotFoundError,
  moveDraft,
  removeMember,
  revokeAgent,
  revokeProjectGrant,
  RuleViolationError,
  shareDraft,
  updateDraft,
  type Principal,
} from '@flux/core';
import { db, insertedHuman, pool } from './support/db.js';
import { interleave as interleaveOn } from './support/locks.js';

// Policy contract and agent principals exercised directly against PostgreSQL (issue #29).
// Agent authentication is a later task, so agents are driven through core methods here.
function agentPrincipal(id: string): Principal {
  return { id, kind: 'agent' };
}

async function sharedDraft(actor: Principal, workspaceId: string, title: string, scope: 'project' | 'workspace', projectId?: string) {
  const item = await createDraft(actor, workspaceId, { title, projectId }, db, accessPorts);
  return shareDraft(actor, item.id, { scope, expectedVersion: item.version }, db, accessPorts);
}

function pgCode(error: unknown) {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code ?? candidate.cause?.code;
}

// F-036 AG-3 (#855): an agent has exactly its owner's current rights. There are no agent grants: its project level is
// its owner's, read live on every call, so it never exceeds its owner and loses access the moment its owner does.
describe('an agent has exactly its owner\'s rights', () => {
  test('a member\'s agent reads and writes exactly where its owner does', async () => {
    const admin = await insertedHuman('rights-admin');
    const human = await insertedHuman('rights-member');
    const ws = await createWorkspace(admin, { name: 'Owner rights' }, db, accessPorts);
    await addMember(admin, ws.id, { userId: human.id, role: 'member' }, db, accessPorts);
    const open = await createProject(admin, ws.id, { name: 'Open', visibility: 'workspace' }, db, accessPorts);
    const board = await createProject(admin, ws.id, { name: 'Board', visibility: 'restricted' }, db, accessPorts);
    const hidden = await createProject(admin, ws.id, { name: 'Hidden', visibility: 'restricted' }, db, accessPorts);
    await grantProject(admin, board.id, { principal: { kind: 'human', id: human.id }, role: 'viewer' }, db, accessPorts);
    const inOpen = await sharedDraft(admin, ws.id, 'in open', 'project', open.id);
    const minutes = await sharedDraft(admin, ws.id, 'Board minutes', 'project', board.id);
    const secret = await sharedDraft(admin, ws.id, 'hidden', 'project', hidden.id);
    const wide = await sharedDraft(admin, ws.id, 'workspace wide', 'workspace');

    const agent = await createAgent(human, ws.id, { name: 'Personal helper' }, db, accessPorts);
    assert.deepEqual(agent.owner, { kind: 'human', id: human.id });
    const bot = agentPrincipal(agent.id);
    assert.deepEqual((await listProjects(bot, ws.id, {}, db, accessPorts)).items.map((p) => [p.name, p.access]).sort(),
      [['Board', 'viewer'], ['Open', 'contributor']], 'the owner\'s projects at the owner\'s levels, and nothing else');
    assert.equal((await getDraft(bot, minutes.id, db, accessPorts)).id, minutes.id);
    await assert.rejects(updateDraft(bot, minutes.id, { body: 'x', expectedVersion: minutes.version }, db, accessPorts), ForbiddenError, 'the owner only reads here');
    assert.equal((await updateDraft(bot, inOpen.id, { body: 'agent edit', expectedVersion: inOpen.version }, db, accessPorts)).body, 'agent edit');
    for (const id of [secret.id, wide.id]) await assert.rejects(getDraft(bot, id, db, accessPorts), NotFoundError);
    await assert.rejects(getProject(bot, hidden.id, db, accessPorts), NotFoundError, 'never more than its owner');
    const own = await createDraft(bot, ws.id, { title: 'agent draft', projectId: open.id }, db, accessPorts);
    assert.deepEqual(own.owner, { kind: 'agent', id: agent.id });
    await assert.rejects(shareDraft(bot, own.id, { scope: 'workspace', expectedVersion: own.version }, db, accessPorts), ForbiddenError, 'agents cannot share workspace-wide');
    await assert.rejects(createWorkspace(bot, { name: 'Agent workspace' }, db, accessPorts), ForbiddenError);

    await revokeAgent(human, agent.id, db, accessPorts);
    await assert.rejects(getDraft(bot, inOpen.id, db, accessPorts), NotFoundError, 'revoked agent');
    assert.deepEqual(await listWorkspaces(bot, db, accessPorts), []);
  });

  test('a manager can no longer give an agent its own project access', async () => {
    const owner = await insertedHuman('no-agent-grants');
    const ws = await createWorkspace(owner, { name: 'No agent grants' }, db, accessPorts);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const agent = await createAgent(owner, ws.id, { name: 'Helper' }, db, accessPorts);
    await assert.rejects(grantProject(owner, room.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } as never, db, accessPorts),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT');
    await assert.rejects(createAgent(owner, ws.id, { name: 'Workspace bot', owner: 'workspace' } as never, db, accessPorts),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT', 'every agent belongs to one person');
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'project_grants' AND column_name = 'agent_id'");
    assert.equal(columns.rowCount, 0, 'the data has no agent grants');
  });

  for (const [loss, lose] of [
    ['the owner is kept out of the project', (admin: Principal, ws: string, project: string, human: string) =>
      grantProject(admin, project, { principal: { kind: 'human', id: human }, role: 'denied' }, db, accessPorts)],
    ['the owner\'s access is narrowed to reading', (admin: Principal, ws: string, project: string, human: string) =>
      grantProject(admin, project, { principal: { kind: 'human', id: human }, role: 'viewer' }, db, accessPorts)],
    // With a grant a guest still works in the space by hand, so only the role can stop the agent: a guest has no AI (AG-2).
    ['the owner becomes a guest with a grant on the project', async (admin: Principal, ws: string, project: string, human: string) => {
      await grantProject(admin, project, { principal: { kind: 'human', id: human }, role: 'contributor' }, db, accessPorts);
      await changeRole(admin, ws, human, { role: 'guest' }, db, accessPorts);
    }],
    ['the owner leaves the workspace', (admin: Principal, ws: string, _project: string, human: string) =>
      removeMember(admin, ws, human, db, accessPorts)],
  ] as const) {
    test(`the agent loses what its owner loses: ${loss}`, async () => {
      const admin = await insertedHuman('loss-admin');
      const human = await insertedHuman('loss-member');
      const ws = await createWorkspace(admin, { name: `Loss: ${loss}` }, db, accessPorts);
      await addMember(admin, ws.id, { userId: human.id, role: 'member' }, db, accessPorts);
      const open = await createProject(admin, ws.id, { name: 'Open', visibility: 'workspace' }, db, accessPorts);
      const item = await sharedDraft(admin, ws.id, 'Plan', 'project', open.id);
      const bot = agentPrincipal((await createAgent(human, ws.id, { name: 'Helper' }, db, accessPorts)).id);
      const own = await createDraft(bot, ws.id, { title: 'agent own', projectId: open.id }, db, accessPorts);
      assert.equal((await updateDraft(bot, item.id, { body: 'before', expectedVersion: item.version }, db, accessPorts)).body, 'before');

      await lose(admin, ws.id, open.id, human.id);
      const write = updateDraft(bot, item.id, { body: 'after', expectedVersion: item.version + 1 }, db, accessPorts);
      if (loss.includes('narrowed')) {
        await assert.rejects(write, ForbiddenError, 'it reads like its owner, and cannot write');
        assert.equal((await getDraft(bot, item.id, db, accessPorts)).body, 'before');
        assert.deepEqual(await authorize(bot, 'project.write', { type: 'project', id: open.id }, accessReader(db)), { allowed: false, visible: true });
      } else {
        await assert.rejects(write, NotFoundError, 'it no longer sees the project at all');
        await assert.rejects(getDraft(bot, own.id, db, accessPorts), NotFoundError, 'not even its own draft');
        assert.deepEqual(await authorize(bot, 'project.read', { type: 'project', id: open.id }, accessReader(db)), { allowed: false, visible: false });
        assert.equal((await listProjects(bot, ws.id, {}, db, accessPorts).catch(() => ({ items: [] }))).items.length, 0);
      }
      assert.equal((await draftRow(item.id)).body, 'before', 'nothing was written after the loss');
    });
  }

  test('an agent creates drafts only inside a project its owner can write in', async () => {
    const admin = await insertedHuman('draft-admin');
    const human = await insertedHuman('draft-member');
    const ws = await createWorkspace(admin, { name: 'Agent drafts' }, db, accessPorts);
    await addMember(admin, ws.id, { userId: human.id, role: 'member' }, db, accessPorts);
    const viewed = await createProject(admin, ws.id, { name: 'Viewed', visibility: 'restricted' }, db, accessPorts);
    await grantProject(admin, viewed.id, { principal: { kind: 'human', id: human.id }, role: 'viewer' }, db, accessPorts);
    const bot = agentPrincipal((await createAgent(human, ws.id, { name: 'Writer' }, db, accessPorts)).id);
    assert.deepEqual(await authorize(bot, 'draft.create', { type: 'workspace', id: ws.id }, accessReader(db)), { allowed: false, visible: true });
    await assert.rejects(createDraft(bot, ws.id, { title: 'viewer only', projectId: viewed.id }, db, accessPorts), ForbiddenError);
    const open = await createProject(admin, ws.id, { name: 'Open', visibility: 'workspace' }, db, accessPorts);
    await assert.rejects(createDraft(bot, ws.id, { title: 'unscoped' }, db, accessPorts),
      (error: unknown) => error instanceof RuleViolationError && error.status === 422 && error.code === 'PROJECT_REQUIRED');
    const inside = await createDraft(bot, ws.id, { title: 'inside', projectId: open.id }, db, accessPorts);
    await assert.rejects(moveDraft(bot, inside.id, { projectId: null, visibility: 'private', expectedVersion: inside.version }, db, accessPorts), RuleViolationError, 'cannot leave every project');
    const rows = await db.select({ n: count() }).from(schema.drafts).where(eq(schema.drafts.ownerAgentId, bot.id));
    assert.equal(rows[0]!.n, 1, 'only the project draft was created');
    const filter = await visibleFilter(bot, ws.id, 'draft', db);
    assert.equal((await db.select({ n: count() }).from(schema.drafts).where(filter))[0]!.n, 1);
  });
});

/** Two real sessions (`support/locks.ts`): `first` stays uncommitted while `second` runs on another connection and waits for it. */
const interleave = <A, B>(first: (tx: Database) => Promise<A>, second: () => Promise<B>) => interleaveOn(db, pool, first, second);

interface RaceCase {
  writer: Principal;
  draftId: string;
  change: (db: Database) => Promise<unknown>;
  refused: typeof NotFoundError | typeof ForbiddenError;
}

async function draftRow(id: string) {
  const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  return row!;
}

/** Access change committed while the write had already decided: the write commits, the change waits. */
async function writeThenChange({ writer, draftId, change, refused }: RaceCase) {
  const { version } = await draftRow(draftId);
  const { firstResult, secondResult } = await interleave(
    (tx) => updateDraft(writer, draftId, { body: 'decided under the old access', expectedVersion: version }, tx, accessPorts),
    () => change(db));
  assert.equal(firstResult.body, 'decided under the old access');
  assert.equal(secondResult.error, null, 'the access change completes after the write');
  assert.equal((await draftRow(draftId)).body, 'decided under the old access');
  await assert.rejects(updateDraft(writer, draftId, { body: 'after the change', expectedVersion: version + 1 }, db, accessPorts), refused, 'the next write sees the change');
}

/** Access change uncommitted when the write starts: the write waits and is then refused. */
async function changeThenWrite({ writer, draftId, change, refused }: RaceCase) {
  const before = await draftRow(draftId);
  const { secondResult } = await interleave(
    (tx) => change(tx),
    () => updateDraft(writer, draftId, { body: 'must not commit', expectedVersion: before.version }, db, accessPorts));
  assert.ok(secondResult.error instanceof refused, `the write is refused with ${refused.name}, got ${String(secondResult.error)}`);
  const after = await draftRow(draftId);
  assert.equal(after.body, before.body);
  assert.equal(after.version, before.version, 'no write committed under stale access');
}

describe('access changes are serialized with draft writes (two connections)', () => {
  /** A member's agent writes in a restricted project through its owner's grant: changing the owner's access is what changes the agent's. */
  async function agentCase(label: string) {
    const owner = await insertedHuman(`${label}-owner`);
    const member = await insertedHuman(`${label}-member`);
    const ws = await createWorkspace(owner, { name: label }, db, accessPorts);
    await addMember(owner, ws.id, { userId: member.id, role: 'member' }, db, accessPorts);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    const grant = await grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'contributor' }, db, accessPorts);
    const agent = await createAgent(member, ws.id, { name: 'Racer' }, db, accessPorts);
    const bot = agentPrincipal(agent.id);
    const item = await createDraft(bot, ws.id, { title: 'race', projectId: room.id }, db, accessPorts);
    return { owner, member, ws, room, bot, grant, item };
  }

  /** A member edits an owner's project draft through implicit contributor access (no grant row). */
  async function memberCase(label: string) {
    const owner = await insertedHuman(`${label}-owner`);
    const member = await insertedHuman(`${label}-member`);
    const ws = await createWorkspace(owner, { name: label }, db, accessPorts);
    await addMember(owner, ws.id, { userId: member.id, role: 'member' }, db, accessPorts);
    const open = await createProject(owner, ws.id, { name: 'Open', visibility: 'workspace' }, db, accessPorts);
    const item = await sharedDraft(owner, ws.id, 'member race', 'project', open.id);
    assert.equal((await updateDraft(member, item.id, { body: 'implicit access works', expectedVersion: item.version }, db, accessPorts)).version, 3);
    return { owner, member, ws, open, item };
  }

  for (const [order, run] of [['write first', writeThenChange], ['change first', changeThenWrite]] as const) {
    test(`(a) revoking the agent's owner's contributor grant — ${order}`, async () => {
      const { owner, room, bot, grant, item } = await agentCase(`revoke-${order}`);
      await run({ writer: bot, draftId: item.id, refused: NotFoundError, change: (tx) => revokeProjectGrant(owner, room.id, grant.id, tx, accessPorts) });
      await assert.rejects(getDraft(bot, item.id, db, accessPorts), NotFoundError);
    });

    test(`(b) inserting a denied grant for a member without a grant row — ${order}`, async () => {
      const { owner, member, open, item } = await memberCase(`deny-${order}`);
      await run({ writer: member, draftId: item.id, refused: NotFoundError, change: (tx) => grantProject(owner, open.id, { principal: { kind: 'human', id: member.id }, role: 'denied' }, tx, accessPorts) });
    });

    test(`(b) keeping the agent's owner out of the project — ${order}`, async () => {
      const { owner, member, room, bot, item } = await agentCase(`agent-deny-${order}`);
      await run({ writer: bot, draftId: item.id, refused: NotFoundError, change: (tx) => grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'denied' }, tx, accessPorts) });
    });

    test(`(c) removing the agent's owner from the workspace — ${order}`, async () => {
      const { owner, member, ws, bot, item } = await agentCase(`agent-remove-${order}`);
      await run({ writer: bot, draftId: item.id, refused: NotFoundError, change: (tx) => removeMember(owner, ws.id, member.id, tx, accessPorts) });
    });

    test(`(c) narrowing a member's default access with a viewer grant — ${order}`, async () => {
      const { owner, member, open, item } = await memberCase(`narrow-${order}`);
      await run({ writer: member, draftId: item.id, refused: ForbiddenError, change: (tx) => grantProject(owner, open.id, { principal: { kind: 'human', id: member.id }, role: 'viewer' }, tx, accessPorts) });
    });

    test(`(c) changing a member to guest removes default project access — ${order}`, async () => {
      const { owner, member, ws, item } = await memberCase(`guest-${order}`);
      await run({ writer: member, draftId: item.id, refused: NotFoundError, change: (tx) => changeRole(owner, ws.id, member.id, { role: 'guest' }, tx, accessPorts) });
    });

    test(`(c) removing the member — ${order}`, async () => {
      const { owner, member, ws, item } = await memberCase(`remove-${order}`);
      await run({ writer: member, draftId: item.id, refused: NotFoundError, change: (tx) => removeMember(owner, ws.id, member.id, tx, accessPorts) });
    });
  }
});

describe('policy contract', () => {
  test('authorize distinguishes invisible from forbidden and visibleFilter matches list results', async () => {
    const owner = await insertedHuman('contract-owner');
    const viewer = await insertedHuman('contract-viewer');
    const stranger = await insertedHuman('contract-stranger');
    const ws = await createWorkspace(owner, { name: 'Contract' }, db, accessPorts);
    await addMember(owner, ws.id, { userId: viewer.id, role: 'member' }, db, accessPorts);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db, accessPorts);
    await grantProject(owner, room.id, { principal: { kind: 'human', id: viewer.id }, role: 'viewer' }, db, accessPorts);
    const item = await sharedDraft(owner, ws.id, 'Contract draft', 'project', room.id);
    await createDraft(owner, ws.id, { title: 'owner private' }, db, accessPorts);

    assert.deepEqual(await authorize(stranger, 'draft.read', { type: 'draft', id: item.id }, accessReader(db)), { allowed: false, visible: false });
    assert.deepEqual(await authorize(viewer, 'draft.read', { type: 'draft', id: item.id }, accessReader(db)), { allowed: true, visible: true });
    assert.deepEqual(await authorize(viewer, 'draft.write', { type: 'draft', id: item.id }, accessReader(db)), { allowed: false, visible: true });
    assert.deepEqual(await authorize(viewer, 'project.manage', { type: 'project', id: room.id }, accessReader(db)), { allowed: false, visible: true });
    assert.deepEqual(await authorize(owner, 'project.manage', { type: 'project', id: room.id }, accessReader(db)), { allowed: true, visible: true });
    assert.deepEqual(await authorize(viewer, 'workspace.manage_members', { type: 'workspace', id: ws.id }, accessReader(db)), { allowed: false, visible: true });
    assert.deepEqual(await authorize(stranger, 'workspace.read', { type: 'workspace', id: ws.id }, accessReader(db)), { allowed: false, visible: false });
    await assert.rejects(assertAuthorized(stranger, 'draft.read', { type: 'draft', id: item.id }, accessReader(db)), NotFoundError);
    await assert.rejects(assertAuthorized(viewer, 'draft.write', { type: 'draft', id: item.id }, accessReader(db)), ForbiddenError);

    const filter = await visibleFilter(viewer, ws.id, 'draft', db);
    const rows = await db.select({ id: schema.drafts.id }).from(schema.drafts).where(filter);
    assert.deepEqual(rows.map((r) => r.id), [item.id]);
    const strangerFilter = await visibleFilter(stranger, ws.id, 'draft', db);
    assert.equal((await db.select({ n: count() }).from(schema.drafts).where(strangerFilter))[0]!.n, 0);
    const projectFilter = await visibleFilter(viewer, ws.id, 'project', db);
    assert.deepEqual((await db.select({ id: schema.projects.id }).from(schema.projects).where(projectFilter)).map((r) => r.id), [room.id]);
  });
});

describe('database integrity', () => {
  test('composite foreign keys reject cross-workspace links', async () => {
    const owner = await insertedHuman('integrity-owner');
    const stranger = await insertedHuman('integrity-stranger');
    const a = await createWorkspace(owner, { name: 'A' }, db, accessPorts);
    const b = await createWorkspace(owner, { name: 'B' }, db, accessPorts);
    const projectB = await createProject(owner, b.id, { name: 'B project' }, db, accessPorts);
    // F-037: the creator's own admin grant would answer the inserts below with a duplicate first; only the keys are tested.
    await pool.query('DELETE FROM project_grants WHERE project_id = $1', [projectB.id]);
    const draftA = await createDraft(owner, a.id, { title: 'A draft' }, db, accessPorts);
    const agentB = await createAgent(owner, b.id, { name: 'B agent' }, db, accessPorts);

    const attempts: [string, () => Promise<unknown>, string][] = [
      ['draft links a project of another workspace', () => pool.query(
        "INSERT INTO drafts (id, workspace_id, project_id, owner_user_id, title, created_by) VALUES ($1, $2, $3, $4, 'x', $4)",
        [randomUUID(), a.id, projectB.id, owner.id]), '23503'],
      ['existing draft is moved to another workspace project', () => pool.query('UPDATE drafts SET project_id = $1 WHERE id = $2', [projectB.id, draftA.id]), '23503'],
      ['grant names a project of another workspace', () => pool.query(
        "INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) VALUES ($1, $2, $3, $4, 'viewer', $4)",
        [randomUUID(), a.id, projectB.id, owner.id]), '23503'],
      ['grant names a person who is not a member', () => pool.query(
        "INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) VALUES ($1, $2, $3, $4, 'viewer', $4)",
        [randomUUID(), b.id, projectB.id, stranger.id]), '23503'],
      ['draft is owned by an agent of another workspace', () => pool.query(
        "INSERT INTO drafts (id, workspace_id, owner_agent_id, title, created_by) VALUES ($1, $2, $3, 'x', $4)",
        [randomUUID(), a.id, agentB.id, owner.id]), '23503'],
      ['project visibility without a project', () => pool.query("UPDATE drafts SET visibility = 'project' WHERE id = $1", [draftA.id]), '23514'],
      ['unknown workspace role', () => pool.query("UPDATE workspace_members SET role = 'superuser' WHERE workspace_id = $1", [a.id]), '23514'],
    ];
    for (const [label, attempt, code] of attempts) {
      await assert.rejects(attempt(), (error: unknown) => pgCode(error) === code, label);
    }
    const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftA.id));
    assert.equal(row!.projectId, null);
    assert.equal(row!.visibility, 'private');
  });
});
