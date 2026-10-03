import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { count, eq } from 'drizzle-orm';
import { schema } from '@flux/db';
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
  listDrafts,
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
  visibleFilter,
  type Database,
  type Principal,
} from '@flux/core';
import { db, insertedHuman, pool } from './support/db.js';
import { backendPid, settled, waitUntilBlockedBy } from './support/locks.js';

// Policy contract and agent principals exercised directly against PostgreSQL (issue #29).
// Agent authentication is a later task, so agents are driven through core methods here.
function agentPrincipal(id: string): Principal {
  return { id, kind: 'agent' };
}

async function sharedDraft(actor: Principal, workspaceId: string, title: string, scope: 'project' | 'workspace', projectId?: string) {
  const item = await createDraft(actor, workspaceId, { title, projectId }, db);
  return shareDraft(actor, item.id, { scope, expectedVersion: item.version }, db);
}

function pgCode(error: unknown) {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code ?? candidate.cause?.code;
}

describe('agent principals', () => {
  test('an agent with a scoped grant reads only its project', async () => {
    const owner = await insertedHuman('agent-owner');
    const ws = await createWorkspace(owner, { name: 'Agents' }, db);
    const granted = await createProject(owner, ws.id, { name: 'Granted', visibility: 'restricted' }, db);
    const open = await createProject(owner, ws.id, { name: 'Open', visibility: 'workspace' }, db);
    const inGranted = await sharedDraft(owner, ws.id, 'in granted', 'project', granted.id);
    const inOpen = await sharedDraft(owner, ws.id, 'in open', 'project', open.id);
    const wide = await sharedDraft(owner, ws.id, 'workspace wide', 'workspace');
    const privateOne = await createDraft(owner, ws.id, { title: 'private', projectId: granted.id }, db);

    const agent = await createAgent(owner, ws.id, { name: 'Helper', owner: 'workspace' }, db);
    assert.deepEqual(agent.owner, { kind: 'workspace' });
    const bot = agentPrincipal(agent.id);
    assert.equal((await listDrafts(bot, ws.id, {}, db)).total, 0, 'no grant, no drafts');
    await grantProject(owner, granted.id, { principal: { kind: 'agent', id: agent.id }, role: 'viewer' }, db);

    const page = await listDrafts(bot, ws.id, { limit: 100 }, db);
    assert.deepEqual(page.items.map((d) => d.id), [inGranted.id]);
    assert.equal(page.total, 1);
    assert.equal((await getDraft(bot, inGranted.id, db)).title, 'in granted');
    for (const hidden of [inOpen.id, wide.id, privateOne.id]) {
      await assert.rejects(getDraft(bot, hidden, db), NotFoundError);
    }
    await assert.rejects(getProject(bot, open.id, db), NotFoundError, 'workspace-visible project needs an explicit grant');
    assert.deepEqual((await listProjects(bot, ws.id, {}, db)).items.map((p) => [p.id, p.access]), [[granted.id, 'viewer']]);
    assert.deepEqual((await listWorkspaces(bot, db)).map((w) => [w.id, w.role]), [[ws.id, null]]);
    await assert.rejects(updateDraft(bot, inGranted.id, { body: 'agent edit', expectedVersion: inGranted.version }, db), ForbiddenError, 'viewer agent cannot write');
    await assert.rejects(shareDraft(bot, inGranted.id, { scope: 'workspace', expectedVersion: inGranted.version }, db), ForbiddenError);

    await grantProject(owner, granted.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, db);
    assert.equal((await updateDraft(bot, inGranted.id, { body: 'agent edit', expectedVersion: inGranted.version }, db)).body, 'agent edit');
    const own = await createDraft(bot, ws.id, { title: 'agent draft', projectId: granted.id }, db);
    assert.deepEqual(own.owner, { kind: 'agent', id: agent.id });
    await assert.rejects(shareDraft(bot, own.id, { scope: 'workspace', expectedVersion: own.version }, db), ForbiddenError, 'agents cannot share workspace-wide');
    await assert.rejects(getDraft(owner, own.id, db), NotFoundError, 'an agent draft is private too');
    await assert.rejects(createDraft(bot, ws.id, { title: 'elsewhere', projectId: open.id }, db), NotFoundError);
    await assert.rejects(createWorkspace(bot, { name: 'Agent workspace' }, db), ForbiddenError);

    await revokeAgent(owner, agent.id, db);
    await assert.rejects(getDraft(bot, inGranted.id, db), NotFoundError, 'revoked agent');
    await assert.rejects(listDrafts(bot, ws.id, {}, db), NotFoundError);
    assert.deepEqual(await listWorkspaces(bot, db), []);
  });

  test('a person-owned agent is capped by its owner and stops when the owner leaves', async () => {
    const admin = await insertedHuman('ws-admin');
    const human = await insertedHuman('agent-human');
    const ws = await createWorkspace(admin, { name: 'Delegation' }, db);
    await addMember(admin, ws.id, { userId: human.id, role: 'member' }, db);
    const board = await createProject(admin, ws.id, { name: 'Board', visibility: 'restricted' }, db);
    await grantProject(admin, board.id, { principal: { kind: 'human', id: human.id }, role: 'viewer' }, db);
    const item = await sharedDraft(admin, ws.id, 'Board minutes', 'project', board.id);

    const agent = await createAgent(human, ws.id, { name: 'Personal helper', owner: 'self' }, db);
    assert.deepEqual(agent.owner, { kind: 'human', id: human.id });
    const bot = agentPrincipal(agent.id);
    await grantProject(admin, board.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, db);
    assert.equal((await getDraft(bot, item.id, db)).id, item.id);
    await assert.rejects(updateDraft(bot, item.id, { body: 'x', expectedVersion: item.version }, db), ForbiddenError, 'agent cannot exceed its owner (viewer)');

    await removeMember(admin, ws.id, human.id, db);
    await assert.rejects(getDraft(bot, item.id, db), NotFoundError, 'owner left the workspace');
    const grants = await db.select({ n: count() }).from(schema.projectGrants).where(eq(schema.projectGrants.agentId, agent.id));
    assert.equal(grants[0]!.n, 1, 'the agent grant is kept but no longer effective');
  });
});

describe('agents stay inside current project grants', () => {
  test('an agent without a writable grant cannot create drafts', async () => {
    const owner = await insertedHuman('zero-owner');
    const ws = await createWorkspace(owner, { name: 'Zero grants' }, db);
    const project = await createProject(owner, ws.id, { name: 'Ungranted', visibility: 'workspace' }, db);
    const viewed = await createProject(owner, ws.id, { name: 'Viewed', visibility: 'restricted' }, db);
    const agent = await createAgent(owner, ws.id, { name: 'No grants', owner: 'workspace' }, db);
    const bot = agentPrincipal(agent.id);

    assert.deepEqual(await authorize(bot, 'draft.create', { type: 'workspace', id: ws.id }, db), { allowed: false, visible: true });
    await assert.rejects(createDraft(bot, ws.id, { title: 'zero grant draft' }, db), ForbiddenError, 'no project, no grant');
    await assert.rejects(createDraft(bot, ws.id, { title: 'ungranted', projectId: project.id }, db), ForbiddenError);

    await grantProject(owner, viewed.id, { principal: { kind: 'agent', id: agent.id }, role: 'viewer' }, db);
    await assert.rejects(createDraft(bot, ws.id, { title: 'viewer only', projectId: viewed.id }, db), ForbiddenError, 'viewer grant is not writable');

    await grantProject(owner, viewed.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, db);
    await assert.rejects(createDraft(bot, ws.id, { title: 'still unscoped' }, db), (error: unknown) => error instanceof RuleViolationError && error.status === 422 && error.code === 'PROJECT_REQUIRED');
    await assert.rejects(createDraft(bot, ws.id, { title: 'other project', projectId: project.id }, db), NotFoundError, 'ungranted project is invisible');
    const inside = await createDraft(bot, ws.id, { title: 'inside', projectId: viewed.id }, db);
    assert.equal(inside.projectId, viewed.id);
    await assert.rejects(moveDraft(bot, inside.id, { projectId: null, visibility: 'private', expectedVersion: inside.version }, db), RuleViolationError, 'cannot leave every project');

    const rows = await db.select({ n: count() }).from(schema.drafts).where(eq(schema.drafts.ownerAgentId, agent.id));
    assert.equal(rows[0]!.n, 1, 'only the project draft was created');
  });

  test('revoking or narrowing a grant removes the agent access to its own drafts', async () => {
    const owner = await insertedHuman('revoke-owner');
    const ws = await createWorkspace(owner, { name: 'Revocation' }, db);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db);
    const agent = await createAgent(owner, ws.id, { name: 'Writer', owner: 'workspace' }, db);
    const bot = agentPrincipal(agent.id);
    const grant = await grantProject(owner, room.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, db);
    const mine = await createDraft(bot, ws.id, { title: 'agent private', projectId: room.id }, db);
    const shared = await sharedDraft(bot, ws.id, 'agent shared', 'project', room.id);
    assert.equal((await updateDraft(bot, mine.id, { body: 'v2', expectedVersion: mine.version }, db)).body, 'v2');
    assert.equal((await listDrafts(bot, ws.id, {}, db)).total, 2);

    await grantProject(owner, room.id, { principal: { kind: 'agent', id: agent.id }, role: 'viewer' }, db);
    assert.equal((await getDraft(bot, mine.id, db)).id, mine.id, 'viewer still reads its own draft');
    await assert.rejects(updateDraft(bot, mine.id, { body: 'v3', expectedVersion: 2 }, db), ForbiddenError, 'viewer cannot write its own draft');
    await assert.rejects(shareDraft(bot, mine.id, { scope: 'project', expectedVersion: 2 }, db), ForbiddenError);
    assert.deepEqual(await authorize(bot, 'draft.write', { type: 'draft', id: shared.id }, db), { allowed: false, visible: true });

    await revokeProjectGrant(owner, room.id, grant.id, db);
    for (const id of [mine.id, shared.id]) {
      await assert.rejects(getDraft(bot, id, db), NotFoundError, 'revoked grant hides the agent draft');
      await assert.rejects(updateDraft(bot, id, { body: 'after revoke', expectedVersion: 2 }, db), NotFoundError);
      assert.deepEqual(await authorize(bot, 'draft.read', { type: 'draft', id }, db), { allowed: false, visible: false });
    }
    const page = await listDrafts(bot, ws.id, {}, db);
    assert.equal(page.total, 0);
    assert.deepEqual(page.items, []);
    const filter = await visibleFilter(bot, ws.id, 'draft', db);
    assert.equal((await db.select({ n: count() }).from(schema.drafts).where(filter))[0]!.n, 0);
    assert.equal((await getDraft(owner, shared.id, db)).body, '', 'the owner still sees the project draft');
  });

  test('an explicit deny hides the agent own drafts', async () => {
    const owner = await insertedHuman('deny-owner');
    const ws = await createWorkspace(owner, { name: 'Deny' }, db);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db);
    const agent = await createAgent(owner, ws.id, { name: 'Denied', owner: 'workspace' }, db);
    const bot = agentPrincipal(agent.id);
    await grantProject(owner, room.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, db);
    const mine = await createDraft(bot, ws.id, { title: 'soon denied', projectId: room.id }, db);
    await grantProject(owner, room.id, { principal: { kind: 'agent', id: agent.id }, role: 'denied' }, db);
    await assert.rejects(getDraft(bot, mine.id, db), NotFoundError);
    assert.equal((await listDrafts(bot, ws.id, {}, db)).total, 0);
  });
});

/**
 * Runs `first` inside a transaction on one pooled connection and keeps that transaction
 * open after `first` finished; then runs `second` on another connection, asserts that it
 * is blocked by the first transaction's locks, and finally commits the first. Returns
 * the outcomes of both. Two real PostgreSQL sessions, no timing assumptions.
 */
async function interleave<A, B>(first: (tx: Database) => Promise<A>, second: () => Promise<B>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ready!: (pid: number) => void;
  const holding = new Promise<number>((resolve) => { ready = resolve; });
  const outer = db.transaction(async (tx) => {
    const result = await first(tx as unknown as Database);
    ready(await backendPid(tx));
    await gate;
    return result;
  });
  outer.catch(() => ready(-1));
  const holder = await holding;
  if (holder < 0) await outer; // surfaces the error of `first`
  const later = second();
  const laterDone = settled(later);
  await waitUntilBlockedBy(pool, holder);
  assert.equal(laterDone(), false, 'the second session waits for the first transaction');
  release();
  const firstResult = await outer;
  const secondResult = await later.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }));
  return { firstResult, secondResult };
}

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
    (tx) => updateDraft(writer, draftId, { body: 'decided under the old access', expectedVersion: version }, tx),
    () => change(db));
  assert.equal(firstResult.body, 'decided under the old access');
  assert.equal(secondResult.error, null, 'the access change completes after the write');
  assert.equal((await draftRow(draftId)).body, 'decided under the old access');
  await assert.rejects(updateDraft(writer, draftId, { body: 'after the change', expectedVersion: version + 1 }, db), refused, 'the next write sees the change');
}

/** Access change uncommitted when the write starts: the write waits and is then refused. */
async function changeThenWrite({ writer, draftId, change, refused }: RaceCase) {
  const before = await draftRow(draftId);
  const { secondResult } = await interleave(
    (tx) => change(tx),
    () => updateDraft(writer, draftId, { body: 'must not commit', expectedVersion: before.version }, db));
  assert.ok(secondResult.error instanceof refused, `the write is refused with ${refused.name}, got ${String(secondResult.error)}`);
  const after = await draftRow(draftId);
  assert.equal(after.body, before.body);
  assert.equal(after.version, before.version, 'no write committed under stale access');
}

describe('access changes are serialized with draft writes (two connections)', () => {
  async function agentCase(label: string) {
    const owner = await insertedHuman(`${label}-owner`);
    const ws = await createWorkspace(owner, { name: label }, db);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db);
    const agent = await createAgent(owner, ws.id, { name: 'Racer', owner: 'workspace' }, db);
    const bot = agentPrincipal(agent.id);
    const grant = await grantProject(owner, room.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, db);
    const item = await createDraft(bot, ws.id, { title: 'race', projectId: room.id }, db);
    return { owner, ws, room, bot, grant, item };
  }

  /** A member edits an owner's project draft through implicit contributor access (no grant row). */
  async function memberCase(label: string) {
    const owner = await insertedHuman(`${label}-owner`);
    const member = await insertedHuman(`${label}-member`);
    const ws = await createWorkspace(owner, { name: label }, db);
    await addMember(owner, ws.id, { userId: member.id, role: 'member' }, db);
    const open = await createProject(owner, ws.id, { name: 'Open', visibility: 'workspace' }, db);
    const item = await sharedDraft(owner, ws.id, 'member race', 'project', open.id);
    assert.equal((await updateDraft(member, item.id, { body: 'implicit access works', expectedVersion: item.version }, db)).version, 3);
    return { owner, member, ws, open, item };
  }

  for (const [order, run] of [['write first', writeThenChange], ['change first', changeThenWrite]] as const) {
    test(`(a) revoking an agent contributor grant — ${order}`, async () => {
      const { owner, room, bot, grant, item } = await agentCase(`revoke-${order}`);
      await run({ writer: bot, draftId: item.id, refused: NotFoundError, change: (tx) => revokeProjectGrant(owner, room.id, grant.id, tx) });
      await assert.rejects(getDraft(bot, item.id, db), NotFoundError);
    });

    test(`(b) inserting a denied grant for a member without a grant row — ${order}`, async () => {
      const { owner, member, open, item } = await memberCase(`deny-${order}`);
      await run({ writer: member, draftId: item.id, refused: NotFoundError, change: (tx) => grantProject(owner, open.id, { principal: { kind: 'human', id: member.id }, role: 'denied' }, tx) });
    });

    test(`(b) replacing an agent grant with denied — ${order}`, async () => {
      const { owner, room, bot, item } = await agentCase(`agent-deny-${order}`);
      await run({ writer: bot, draftId: item.id, refused: NotFoundError, change: (tx) => grantProject(owner, room.id, { principal: { kind: 'agent', id: bot.id }, role: 'denied' }, tx) });
    });

    test(`(c) narrowing a member's default access with a viewer grant — ${order}`, async () => {
      const { owner, member, open, item } = await memberCase(`narrow-${order}`);
      await run({ writer: member, draftId: item.id, refused: ForbiddenError, change: (tx) => grantProject(owner, open.id, { principal: { kind: 'human', id: member.id }, role: 'viewer' }, tx) });
    });

    test(`(c) changing a member to guest removes default project access — ${order}`, async () => {
      const { owner, member, ws, item } = await memberCase(`guest-${order}`);
      await run({ writer: member, draftId: item.id, refused: NotFoundError, change: (tx) => changeRole(owner, ws.id, member.id, { role: 'guest' }, tx) });
    });

    test(`(c) removing the member — ${order}`, async () => {
      const { owner, member, ws, item } = await memberCase(`remove-${order}`);
      await run({ writer: member, draftId: item.id, refused: NotFoundError, change: (tx) => removeMember(owner, ws.id, member.id, tx) });
    });
  }
});

describe('policy contract', () => {
  test('authorize distinguishes invisible from forbidden and visibleFilter matches list results', async () => {
    const owner = await insertedHuman('contract-owner');
    const viewer = await insertedHuman('contract-viewer');
    const stranger = await insertedHuman('contract-stranger');
    const ws = await createWorkspace(owner, { name: 'Contract' }, db);
    await addMember(owner, ws.id, { userId: viewer.id, role: 'member' }, db);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db);
    await grantProject(owner, room.id, { principal: { kind: 'human', id: viewer.id }, role: 'viewer' }, db);
    const item = await sharedDraft(owner, ws.id, 'Contract draft', 'project', room.id);
    await createDraft(owner, ws.id, { title: 'owner private' }, db);

    assert.deepEqual(await authorize(stranger, 'draft.read', { type: 'draft', id: item.id }, db), { allowed: false, visible: false });
    assert.deepEqual(await authorize(viewer, 'draft.read', { type: 'draft', id: item.id }, db), { allowed: true, visible: true });
    assert.deepEqual(await authorize(viewer, 'draft.write', { type: 'draft', id: item.id }, db), { allowed: false, visible: true });
    assert.deepEqual(await authorize(viewer, 'project.manage', { type: 'project', id: room.id }, db), { allowed: false, visible: true });
    assert.deepEqual(await authorize(owner, 'project.manage', { type: 'project', id: room.id }, db), { allowed: true, visible: true });
    assert.deepEqual(await authorize(viewer, 'workspace.manage_members', { type: 'workspace', id: ws.id }, db), { allowed: false, visible: true });
    assert.deepEqual(await authorize(stranger, 'workspace.read', { type: 'workspace', id: ws.id }, db), { allowed: false, visible: false });
    await assert.rejects(assertAuthorized(stranger, 'draft.read', { type: 'draft', id: item.id }, db), NotFoundError);
    await assert.rejects(assertAuthorized(viewer, 'draft.write', { type: 'draft', id: item.id }, db), ForbiddenError);

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
    const a = await createWorkspace(owner, { name: 'A' }, db);
    const b = await createWorkspace(owner, { name: 'B' }, db);
    const projectB = await createProject(owner, b.id, { name: 'B project' }, db);
    const draftA = await createDraft(owner, a.id, { title: 'A draft' }, db);
    const agentB = await createAgent(owner, b.id, { name: 'B agent', owner: 'workspace' }, db);

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
