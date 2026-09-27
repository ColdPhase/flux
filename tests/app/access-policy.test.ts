import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { count, eq } from 'drizzle-orm';
import { createDatabase, schema } from '@flux/db';
import {
  addMember,
  authorize,
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
  removeMember,
  revokeAgent,
  shareDraft,
  updateDraft,
  visibleFilter,
  type Principal,
} from '@flux/core';

// Policy contract and agent principals exercised directly against PostgreSQL (issue #29).
// Agent authentication is a later task, so agents are driven through core methods here.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

async function person(label: string): Promise<Principal> {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: label, email: `${label}-${id}@example.test` });
  return { id, kind: 'human' };
}

function agentPrincipal(id: string): Principal {
  return { id, kind: 'agent' };
}

async function sharedDraft(actor: Principal, workspaceId: string, title: string, scope: 'project' | 'workspace', projectId?: string) {
  const item = await createDraft(actor, workspaceId, { title, projectId }, db);
  return shareDraft(actor, item.id, { scope }, db);
}

function pgCode(error: unknown) {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code ?? candidate.cause?.code;
}

describe('agent principals', () => {
  test('an agent with a scoped grant reads only its project', async () => {
    const owner = await person('agent-owner');
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
    await assert.rejects(updateDraft(bot, inGranted.id, { body: 'agent edit' }, db), ForbiddenError, 'viewer agent cannot write');
    await assert.rejects(shareDraft(bot, inGranted.id, { scope: 'workspace' }, db), ForbiddenError);

    await grantProject(owner, granted.id, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, db);
    assert.equal((await updateDraft(bot, inGranted.id, { body: 'agent edit' }, db)).body, 'agent edit');
    const own = await createDraft(bot, ws.id, { title: 'agent draft', projectId: granted.id }, db);
    assert.deepEqual(own.owner, { kind: 'agent', id: agent.id });
    await assert.rejects(shareDraft(bot, own.id, { scope: 'workspace' }, db), ForbiddenError, 'agents cannot share workspace-wide');
    await assert.rejects(getDraft(owner, own.id, db), NotFoundError, 'an agent draft is private too');
    await assert.rejects(createDraft(bot, ws.id, { title: 'elsewhere', projectId: open.id }, db), NotFoundError);
    await assert.rejects(createWorkspace(bot, { name: 'Agent workspace' }, db), ForbiddenError);

    await revokeAgent(owner, agent.id, db);
    await assert.rejects(getDraft(bot, inGranted.id, db), NotFoundError, 'revoked agent');
    await assert.rejects(listDrafts(bot, ws.id, {}, db), NotFoundError);
    assert.deepEqual(await listWorkspaces(bot, db), []);
  });

  test('a person-owned agent is capped by its owner and stops when the owner leaves', async () => {
    const admin = await person('ws-admin');
    const human = await person('agent-human');
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
    await assert.rejects(updateDraft(bot, item.id, { body: 'x' }, db), ForbiddenError, 'agent cannot exceed its owner (viewer)');

    await removeMember(admin, ws.id, human.id, db);
    await assert.rejects(getDraft(bot, item.id, db), NotFoundError, 'owner left the workspace');
    const grants = await db.select({ n: count() }).from(schema.projectGrants).where(eq(schema.projectGrants.agentId, agent.id));
    assert.equal(grants[0]!.n, 1, 'the agent grant is kept but no longer effective');
  });
});

describe('policy contract', () => {
  test('authorize distinguishes invisible from forbidden and visibleFilter matches list results', async () => {
    const owner = await person('contract-owner');
    const viewer = await person('contract-viewer');
    const stranger = await person('contract-stranger');
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
    const owner = await person('integrity-owner');
    const stranger = await person('integrity-stranger');
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
