import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { Project, ProjectPerson, Workspace } from '@flux/contracts';
import { authorize, authorizeEvent, requireWorkspaceAi } from '@flux/core';
import { loadActor, workspaceAi, accessReader } from '@flux/db';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';
import { setWorkspaceAi } from './support/workspace-ai.js';

// F-029 workspace AI lock, S1 (#614): the policy row, who may change it (workspace.manage_ai), the state every member sees,
// one check that fails closed, and the principal layer: an agent of a workspace whose AI is off is inactive, so it reads
// nothing, is not in the project audience and gets no event audience row. Each case has its allowed control.

describe('workspace AI policy', () => {
  let owner: Person; let admin: Person; let member: Person; let guest: Person;
  let ws: Workspace; let other: Workspace; let place: Project; let agentId: string;

  before(async () => {
    [owner, admin, member, guest] = await Promise.all(['ai-owner', 'ai-admin', 'ai-member', 'ai-guest'].map((label) => person(label)));
    ws = await workspace(owner!, 'Garden club');
    other = await workspace(owner!, 'Other club');
    await addMember(owner!, ws.id, admin!, 'admin');
    await addMember(owner!, ws.id, member!, 'member');
    await addMember(owner!, ws.id, guest!, 'guest');
    place = await project(owner!, ws.id, 'Sensors', 'workspace');
    agentId = (expectStatus(await owner!.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada agent', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner!.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  });

  test('a new workspace starts allowed and every member sees the state; who changed it is named to members only', async () => {
    const created = expectStatus(await owner.browser.request('GET', `/api/v1/workspaces/${ws.id}`), 200) as Workspace;
    assert.equal(created.ai.state, 'allowed');
    assert.equal(created.ai.changedBy, null);
    await pool.query('UPDATE workspace_ai_policies SET changed_by = $2 WHERE workspace_id = $1', [ws.id, admin.id]);
    const byMember = expectStatus(await member.browser.request('GET', `/api/v1/workspaces/${ws.id}`), 200) as Workspace;
    assert.equal(byMember.ai.changedBy?.id, admin.id, 'a member sees who changed it');
    const byGuest = expectStatus(await guest.browser.request('GET', `/api/v1/workspaces/${ws.id}`), 200) as Workspace;
    assert.equal(byGuest.ai.state, 'allowed', 'a guest sees the state');
    assert.equal(byGuest.ai.changedBy, null, 'a guest is not told who changed it');
    const listed = (expectStatus(await guest.browser.request('GET', '/api/v1/workspaces'), 200) as Workspace[]).find((item) => item.id === ws.id)!;
    assert.deepEqual(listed.ai, byGuest.ai);
    await setWorkspaceAi(ws.id, 'blocked');
    try {
      assert.equal((expectStatus(await member.browser.request('GET', `/api/v1/workspaces/${ws.id}`), 200) as Workspace).ai.state, 'blocked', 'the change is visible on the next read');
      assert.equal((expectStatus(await owner.browser.request('GET', `/api/v1/workspaces/${other.id}`), 200) as Workspace).ai.state, 'allowed', 'other workspaces keep their own policy');
    } finally { await setWorkspaceAi(ws.id, 'allowed'); }
  });

  test('only owners and admins hold workspace.manage_ai; members, guests and agents do not', async () => {
    const may = async (principal: { kind: 'human' | 'agent'; id: string }) => (await authorize(principal, 'workspace.manage_ai', { type: 'workspace', id: ws.id }, accessReader(db))).allowed;
    assert.equal(await may({ kind: 'human', id: owner.id }), true);
    assert.equal(await may({ kind: 'human', id: admin.id }), true);
    assert.equal(await may({ kind: 'human', id: member.id }), false);
    assert.equal(await may({ kind: 'human', id: guest.id }), false);
    assert.equal(await may({ kind: 'agent', id: agentId }), false);
  });

  test('one check: allowed, blocked, another epoch and a missing row (fail closed)', async () => {
    const allowed = await requireWorkspaceAi(accessReader(db), ws.id);
    assert.equal(allowed.state, 'allowed');
    await assert.rejects(requireWorkspaceAi(accessReader(db), ws.id, { epoch: allowed.epoch + 1 }), (error: { code?: string }) => error.code === 'WORKSPACE_AI_BLOCKED', 'another epoch is refused');
    await setWorkspaceAi(ws.id, 'blocked');
    try {
      await assert.rejects(requireWorkspaceAi(accessReader(db), ws.id), (error: { status?: number; code?: string }) => error.status === 403 && error.code === 'WORKSPACE_AI_BLOCKED');
    } finally { await setWorkspaceAi(ws.id, 'allowed'); }
    const row = (await pool.query('DELETE FROM workspace_ai_policies WHERE workspace_id = $1 RETURNING *', [ws.id])).rows[0];
    try {
      assert.equal((await workspaceAi(db, ws.id)).state, 'blocked', 'a missing row reads as blocked');
      assert.equal((await loadActor({ kind: 'agent', id: agentId }, ws.id, db)).active, false);
    } finally {
      await pool.query('INSERT INTO workspace_ai_policies (workspace_id, state, epoch, version, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [row.workspace_id, row.state, row.epoch, row.version, row.changed_by, row.changed_at]);
    }
  });

  test('an agent of a workspace whose AI is off is inactive: no project read, no audience, no event; people are unchanged', async () => {
    const audience = async () => (expectStatus(await member.browser.request('GET', `/api/v1/projects/${place.id}/people`), 200) as ProjectPerson[]).map((who) => who.id);
    const agentReads = async () => (await authorizeEvent({ kind: 'agent', id: agentId }, { kind: 'project.updated.v1', workspaceId: ws.id, objectId: place.id }, accessReader(db)));
    const recipientsOfNewEvent = async () => {
      const seq = Number((await pool.query('SELECT coalesce(max(seq), 0) AS seq FROM events')).rows[0].seq);
      expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: `Check ${Date.now()}` } }), 201);
      return (await pool.query(`SELECT DISTINCT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id WHERE e.workspace_id = $1 AND e.seq > $2`,
        [ws.id, seq])).rows.map((row) => row.recipient as string);
    };
    // Allowed (the control): the agent is active, in the audience and receives the event.
    assert.equal((await loadActor({ kind: 'agent', id: agentId }, ws.id, db)).active, true);
    assert.ok((await audience()).includes(agentId), 'control: the agent is in the project audience');
    assert.equal(await agentReads(), true);
    // The change of the policy is for people only: an agent in an allowed workspace, who may read the workspace, still never receives it.
    const policyChanged = { kind: 'workspace.ai_policy_changed.v1', workspaceId: ws.id, objectId: ws.id };
    assert.equal(await authorizeEvent({ kind: 'agent', id: agentId }, policyChanged, accessReader(db)), false, 'no agent receives workspace.ai_policy_changed.v1');
    assert.equal(await authorizeEvent({ kind: 'human', id: member.id }, policyChanged, accessReader(db)), true, 'control: a member does');
    assert.equal(await authorizeEvent({ kind: 'agent', id: agentId }, { ...policyChanged, kind: 'workspace.member_added.v1' }, accessReader(db)), true, 'control: other workspace events still reach the agent');
    const allowedRecipients = await recipientsOfNewEvent();
    assert.ok(allowedRecipients.includes(`agent:${agentId}`), `control: an agent audience row is written (${allowedRecipients.join(', ')})`);
    await setWorkspaceAi(ws.id, 'blocked');
    try {
      const actor = await loadActor({ kind: 'agent', id: agentId }, ws.id, db);
      assert.deepEqual([actor.active, actor.blockedBy], [false, 'workspace_ai']);
      assert.ok(!(await audience()).includes(agentId), 'the agent leaves the project audience');
      assert.equal(await agentReads(), false);
      const blockedRecipients = await recipientsOfNewEvent();
      assert.ok(!blockedRecipients.some((key) => key.startsWith('agent:')), 'no agent audience row while AI is off');
      assert.ok(blockedRecipients.includes(`human:${member.id}`), 'people still get the event');
      assert.equal((await loadActor({ kind: 'human', id: member.id }, ws.id, db)).active, true, 'people keep every right');
    } finally { await setWorkspaceAi(ws.id, 'allowed'); }
    assert.ok((await audience()).includes(agentId), 'back after AI is on again');
  });

  test('no new agent identity while AI is off', async () => {
    await setWorkspaceAi(ws.id, 'blocked');
    try {
      const refused = await member.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Blocked agent', owner: 'self' } });
      assert.deepEqual([refused.status, (refused.json as { code?: string }).code], [403, 'WORKSPACE_AI_BLOCKED']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agents WHERE workspace_id = $1 AND name = 'Blocked agent'`, [ws.id])).rows[0].n, 0);
      expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${other.id}/agents`, { body: { name: 'x', owner: 'self' } }), 404);
    } finally { await setWorkspaceAi(ws.id, 'allowed'); }
    expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Allowed agent', owner: 'self' } }), 201);
  });
});
