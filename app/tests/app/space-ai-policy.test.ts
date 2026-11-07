import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { Project, ProjectPerson } from '@flux/contracts';
import { SPACE_AI_POLICY_CHANGED_EVENT, projectAiPolicyPath, projectPath } from '@flux/contracts';
import { authorizeEvent, requireSpaceAi } from '@flux/core';
import { loadActor, spaceAi, accessReader } from '@flux/db';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { setSpaceAi, spaceAiRow } from './support/space-ai.js';

// AG-10 (F-037; it replaces the workspace AI lock of F-029): each space has its own AI switch, on by default. The policy row,
// who may change it (a space admin, and the company's owners and admins in any space), the state everyone who can open the space
// sees, one check that fails closed, and the principal layer: an agent in a space whose AI is off reads nothing there, is not in
// its audience and gets no event audience row, while the same agent keeps working in the company's other spaces.

describe('space AI switch', () => {
  let owner: Person; let companyAdmin: Person; let spaceAdmin: Person; let member: Person; let guest: Person; let stranger: Person;
  let wsId: string; let place: Project; let other: Project; let agentId: string;

  before(async () => {
    [owner, companyAdmin, spaceAdmin, member, guest, stranger] = await Promise.all(['ai-owner', 'ai-admin', 'ai-space-admin', 'ai-member', 'ai-guest', 'ai-stranger'].map((label) => person(label)));
    wsId = (await workspace(owner!, 'Garden club')).id;
    await addMember(owner!, wsId, companyAdmin!, 'admin');
    await addMember(owner!, wsId, spaceAdmin!, 'member');
    await addMember(owner!, wsId, member!, 'member');
    await addMember(owner!, wsId, guest!, 'guest');
    place = await project(spaceAdmin!, wsId, 'Sensors', 'restricted');
    other = await project(spaceAdmin!, wsId, 'Compost', 'restricted');
    await grant(spaceAdmin!, place.id, member!, 'contributor');
    await grant(spaceAdmin!, place.id, guest!, 'contributor');
    await grant(spaceAdmin!, other.id, member!, 'contributor');
    agentId = (expectStatus(await member!.browser.request('POST', `/api/v1/workspaces/${wsId}/agents`, { body: { name: 'Member agent', owner: 'self' } }), 201) as { id: string }).id;
    // An agent has exactly its owner's rights (F-036 AG-3): its owner is added to both spaces, so it reads both and is listed with its owner.
  });

  const put = (who: Person, projectId: string, state: 'allowed' | 'blocked') => who.browser.request('PUT', projectAiPolicyPath(projectId), { body: { state } });

  test('a new space starts with AI on and everyone who can open it sees the state; the switch of another space is its own', async () => {
    const created = expectStatus(await spaceAdmin.browser.request('GET', projectPath(place.id)), 200) as Project;
    assert.equal(created.ai, 'allowed');
    assert.equal(place.ai, 'allowed', 'the create answer says so too');
    await setSpaceAi(place.id, 'blocked');
    try {
      for (const who of [member, guest, spaceAdmin, companyAdmin]) {
        assert.equal((expectStatus(await who.browser.request('GET', projectPath(place.id)), 200) as Project).ai, 'blocked', 'the change is visible on the next read');
      }
      const listed = (expectStatus(await member.browser.request('GET', `/api/v1/workspaces/${wsId}/projects`), 200) as { items: Project[] }).items;
      assert.equal(listed.find((item) => item.id === place.id)!.ai, 'blocked');
      assert.equal(listed.find((item) => item.id === other.id)!.ai, 'allowed', 'another space keeps its own switch');
    } finally { await setSpaceAi(place.id, 'allowed'); }
  });

  test('creating a space with AI off, and with people: one command, the creator is its admin', async () => {
    const created = expectStatus(await spaceAdmin.browser.request('POST', `/api/v1/workspaces/${wsId}/projects`,
      { body: { name: 'Payroll', visibility: 'restricted', ai: false, people: [member.id, member.id, spaceAdmin.id] } }), 201) as Project;
    assert.equal(created.ai, 'blocked');
    assert.equal(created.access, 'manager');
    assert.equal((await spaceAiRow(created.id))!.state, 'blocked');
    const roles = (await pool.query('SELECT user_id, role FROM project_grants WHERE project_id = $1 ORDER BY role', [created.id])).rows;
    assert.deepEqual(roles.map((row) => [row.user_id, row.role]).sort(), [[member.id, 'contributor'], [spaceAdmin.id, 'manager']].sort());
    expectStatus(await member.browser.request('GET', projectPath(created.id)), 200);
    expectStatus(await stranger.browser.request('GET', projectPath(created.id)), 404);
    // Someone outside the company is not added, and nothing is left half made.
    const refused = await spaceAdmin.browser.request('POST', `/api/v1/workspaces/${wsId}/projects`, { body: { name: 'Half made', visibility: 'restricted', people: [stranger.id] } });
    assert.deepEqual([refused.status, (refused.json as { code?: string }).code], [422, 'NOT_A_MEMBER']);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1 AND name = 'Half made'`, [wsId])).rows[0].n, 0);
  });

  test('who may turn AI off and on: a space admin and a company owner or admin; not a member, a guest, a stranger or an agent', async () => {
    const results: Record<string, number> = {};
    const attempts: [string, Person][] = [['member', member], ['guest', guest], ['stranger', stranger]];
    for (const [label, who] of attempts) results[label] = (await put(who, place.id, 'blocked')).status;
    // A member and a guest can open the space and are told they may not; a stranger cannot know it exists.
    assert.deepEqual(results, { member: 403, guest: 403, stranger: 404 });
    assert.equal((await spaceAiRow(place.id))!.state, 'allowed', 'nothing changed');
    const agent = await authorizeEvent({ kind: 'agent', id: agentId }, { kind: 'project.updated.v1', workspaceId: wsId, objectId: place.id }, accessReader(db));
    assert.equal(agent, true, 'control: the agent reads the space while AI is on');
    for (const [label, who] of [['space admin', spaceAdmin], ['company admin', companyAdmin], ['owner', owner]] as const) {
      const off = await put(who, place.id, 'blocked');
      assert.equal(off.status, 200, `${label}: ${off.text}`);
      assert.equal((off.json as { ai: string; changed: boolean }).ai, 'blocked');
      const on = await put(who, place.id, 'allowed');
      assert.equal(on.status, 200, `${label}: ${on.text}`);
    }
    // The company admin is not in the space (no grant) and still changes it: they are a manager of every space.
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_grants WHERE project_id = $1 AND user_id = $2', [place.id, companyAdmin.id])).rows[0].n, 0);
    // Setting the state it already has changes nothing.
    const again = await put(spaceAdmin, place.id, 'allowed');
    assert.deepEqual([again.status, (again.json as { changed: boolean }).changed], [200, false]);
  });

  test('one check: allowed, blocked, another epoch and a missing row (fail closed)', async () => {
    const allowed = await requireSpaceAi(accessReader(db), place.id);
    assert.equal(allowed.state, 'allowed');
    await assert.rejects(requireSpaceAi(accessReader(db), place.id, { epoch: allowed.epoch + 1 }), (error: { code?: string }) => error.code === 'SPACE_AI_OFF', 'another epoch is refused');
    await setSpaceAi(place.id, 'blocked');
    try {
      await assert.rejects(requireSpaceAi(accessReader(db), place.id), (error: { status?: number; code?: string }) => error.status === 403 && error.code === 'SPACE_AI_OFF');
      await requireSpaceAi(accessReader(db), other.id);
    } finally { await setSpaceAi(place.id, 'allowed'); }
    const row = (await pool.query('DELETE FROM project_ai_policies WHERE project_id = $1 RETURNING *', [place.id])).rows[0];
    try {
      assert.equal((await spaceAi(db, place.id)).state, 'blocked', 'a missing row reads as blocked');
      assert.equal((await spaceAi(db, 'not-a-uuid')).state, 'blocked');
    } finally {
      await pool.query('INSERT INTO project_ai_policies (project_id, state, epoch, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5)',
        [row.project_id, row.state, row.epoch, row.changed_by, row.changed_at]);
    }
  });

  test('an agent reads nothing in a space whose AI is off: no read, no audience, no event; people and other spaces are unchanged', async () => {
    const audience = async () => (expectStatus(await member.browser.request('GET', `/api/v1/projects/${place.id}/people`), 200) as ProjectPerson[]).map((who) => who.id);
    const agentReads = async (projectId: string) => authorizeEvent({ kind: 'agent', id: agentId }, { kind: 'project.updated.v1', workspaceId: wsId, objectId: projectId }, accessReader(db));
    const recipientsOfNewEvent = async () => {
      const seq = Number((await pool.query('SELECT coalesce(max(seq), 0) AS seq FROM events')).rows[0].seq);
      expectStatus(await spaceAdmin.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: `Check ${Date.now()}` } }), 201);
      return (await pool.query(`SELECT DISTINCT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id WHERE e.workspace_id = $1 AND e.seq > $2`,
        [wsId, seq])).rows.map((row) => row.recipient as string);
    };
    // Allowed (the control): the agent is active, in the audience and receives the event.
    assert.equal((await loadActor({ kind: 'agent', id: agentId }, wsId, db)).active, true);
    assert.ok((await audience()).includes(agentId), 'control: the agent is in the space audience');
    assert.equal(await agentReads(place.id), true);
    // The change of the switch is for people only: an agent who may read the space still never receives it.
    const switchChanged = { kind: SPACE_AI_POLICY_CHANGED_EVENT, workspaceId: wsId, objectId: place.id };
    assert.equal(await authorizeEvent({ kind: 'agent', id: agentId }, switchChanged, accessReader(db)), false, 'no agent receives project.ai_policy_changed.v1');
    assert.equal(await authorizeEvent({ kind: 'human', id: member.id }, switchChanged, accessReader(db)), true, 'control: a member does');
    assert.equal(await authorizeEvent({ kind: 'agent', id: agentId }, { ...switchChanged, kind: 'project.grant_set.v1' }, accessReader(db)), true, 'control: other space events still reach the agent');
    const allowedRecipients = await recipientsOfNewEvent();
    assert.ok(allowedRecipients.includes(`agent:${agentId}`), `control: an agent audience row is written (${allowedRecipients.join(', ')})`);
    await setSpaceAi(place.id, 'blocked');
    try {
      // The agent stays a company agent (it is not inactive as a whole): it simply has no level in this space.
      assert.equal((await loadActor({ kind: 'agent', id: agentId }, wsId, db)).active, true, 'the agent is not removed from the company');
      assert.ok(!(await audience()).includes(agentId), 'the agent leaves the space audience');
      assert.equal(await agentReads(place.id), false);
      assert.equal(await agentReads(other.id), true, 'the same agent still reads the company\'s other spaces');
      const blockedRecipients = await recipientsOfNewEvent();
      assert.ok(!blockedRecipients.some((key) => key.startsWith('agent:')), 'no agent audience row while AI is off');
      assert.ok(blockedRecipients.includes(`human:${member.id}`), 'people still get the event');
      expectStatus(await member.browser.request('GET', projectPath(place.id)), 200);
    } finally { await setSpaceAi(place.id, 'allowed'); }
    assert.ok((await audience()).includes(agentId), 'back after AI is on again');
  });
});
