import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { AcceptInviteResult, AgentAccessRequest, AgentProjectAccess, InvitePreview, NeedsYouResponse, Project, ProjectGrant, WorkspaceInvite } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// #763 first-time user study (docs/agents/release-acceptance/evidence/first-time-user.md):
// FT-1 a member asks the project's managers to let their own agent in, and a manager allows it in one step;
// FT-2 a member whose agent a manager let in grants it the work of a handed task (proposed amendment of F-024 AC-4);
// FT-3 an invite made from a project opens that project and tells the inviter; FT-8 your own proposal does not ask you.

const DAY = 86_400_000;
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const needsYou = async (who: Person) => expectStatus(await who.browser.request('GET', '/api/v1/needs-you'), 200) as NeedsYouResponse;
const inbox = async (who: Person) => (expectStatus(await who.browser.request('GET', '/api/v1/inbox'), 200) as { items: { title: string; url: string | null; readAt: string | null }[] }).items;
const agentOf = async (who: Person, workspaceId: string, name: string) =>
  (expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
const ask = (who: Person, projectId: string, agentId: string, role?: 'viewer' | 'contributor') =>
  who.browser.request('POST', `/api/v1/projects/${projectId}/agent-requests`, { body: { agentId, ...(role ? { role } : {}) } });
const grantsOf = async (manager: Person, projectId: string) => expectStatus(await manager.browser.request('GET', `/api/v1/projects/${projectId}/grants`), 200) as ProjectGrant[];
const codeOf = (response: { json: unknown }) => (response.json as { code?: string }).code;

describe('#763 FT-1: a member asks a manager to let their own agent in', () => {
  let anna: Person; let ben: Person; let dev: Person; let guest: Person;
  let space: string; let app: Project; let open: Project;

  before(async () => {
    [anna, ben, dev, guest] = await Promise.all(['FT Anna', 'FT Ben', 'FT Dev', 'FT Guest'].map(person));
    space = (await workspace(anna, 'Volunteer space')).id;
    await addMember(anna, space, ben, 'admin');
    await addMember(anna, space, dev, 'member');
    await addMember(anna, space, guest, 'member');
    app = await project(anna, space, 'Volunteer sign-up app', 'restricted');
    open = await project(anna, space, 'Open notes', 'workspace');
    await grant(anna, app.id, dev, 'contributor');
    await grant(anna, app.id, guest, 'viewer');
  });

  test('asking notifies every manager, grants nothing, and Allow is the ordinary agent grant in one step', async () => {
    const agentId = await agentOf(dev, space, 'Claude Code');
    // Before: no grant; the owner sees the agent's place in each project they can open, and nowhere else.
    const access = expectStatus(await dev.browser.request('GET', `/api/v1/agents/${agentId}/project-access`), 200) as AgentProjectAccess[];
    assert.deepEqual(access.map((row) => row.projectId).sort(), [app.id, open.id].sort());
    assert.ok(access.every((row) => row.grant === null && row.request === null));

    const asked = expectStatus(await ask(dev, app.id, agentId), 201) as AgentAccessRequest & { notified: { id: string; name: string }[] };
    assert.equal(asked.state, 'pending');
    assert.equal(asked.role, 'contributor', 'a writer asks for a writing agent');
    assert.deepEqual(asked.notified.map((who) => who.id).sort(), [anna.id, ben.id].sort(), 'every manager of the project, not the asker');
    assert.equal((await grantsOf(anna, app.id)).some((row) => row.principal.kind === 'agent' && row.principal.id === agentId), false, 'asking grants nothing');

    // Each manager has one question in Needs you that opens the project's People; asking again does not repeat it.
    for (const manager of [anna, ben]) {
      const items = (await needsYou(manager)).items.filter((item) => item.url.includes(`agentRequest=${asked.id}`));
      assert.equal(items.length, 1, 'one Needs-you question');
      assert.equal(items[0]!.kind, 'question');
      assert.match(items[0]!.title, /FT Dev asks to let their agent Claude Code into Volunteer sign-up app/);
    }
    expectStatus(await ask(dev, app.id, agentId), 201);
    assert.equal((await needsYou(anna)).items.filter((item) => item.url.includes(`agentRequest=${asked.id}`)).length, 1, 'no second notice');

    // Managers see the request; the owner sees their own; another member sees nothing and cannot answer.
    assert.deepEqual((expectStatus(await anna.browser.request('GET', `/api/v1/projects/${app.id}/agent-requests`), 200) as AgentAccessRequest[]).map((row) => row.id), [asked.id]);
    assert.deepEqual((expectStatus(await dev.browser.request('GET', `/api/v1/projects/${app.id}/agent-requests`), 200) as AgentAccessRequest[]).map((row) => row.id), [asked.id]);
    assert.deepEqual(expectStatus(await guest.browser.request('GET', `/api/v1/projects/${app.id}/agent-requests`), 200), []);
    assert.equal((await dev.browser.request('POST', `/api/v1/projects/${app.id}/agent-requests/${asked.id}`, { body: { allow: true } })).status, 403, 'the owner cannot allow their own request');
    assert.equal((await guest.browser.request('POST', `/api/v1/projects/${app.id}/agent-requests/${asked.id}`, { body: { allow: true } })).status, 403);
    const pending = (expectStatus(await dev.browser.request('GET', `/api/v1/agents/${agentId}/project-access`), 200) as AgentProjectAccess[]).find((row) => row.projectId === app.id)!;
    assert.deepEqual(pending.request, { id: asked.id, role: 'contributor' });

    // Allow: the ordinary contributor grant by that manager; the questions leave Needs you; the owner hears it in the Inbox.
    const allowed = expectStatus(await ben.browser.request('POST', `/api/v1/projects/${app.id}/agent-requests/${asked.id}`, { body: { allow: true } }), 200) as AgentAccessRequest;
    assert.equal(allowed.state, 'accepted');
    const made = (await grantsOf(anna, app.id)).find((row) => row.principal.kind === 'agent' && row.principal.id === agentId);
    assert.equal(made?.role, 'contributor');
    assert.equal(made?.createdBy, ben.id, 'the grant is the manager\'s');
    for (const manager of [anna, ben]) assert.equal((await needsYou(manager)).items.some((item) => item.url.includes(`agentRequest=${asked.id}`)), false);
    assert.ok((await inbox(dev)).some((item) => item.title === 'Claude Code can now work in Volunteer sign-up app'));
    // Answering again changes nothing; asking again for what it has is a conflict.
    assert.equal((expectStatus(await anna.browser.request('POST', `/api/v1/projects/${app.id}/agent-requests/${asked.id}`, { body: { allow: false } }), 200) as AgentAccessRequest).state, 'accepted');
    assert.equal(codeOf(await ask(dev, app.id, agentId)), 'AGENT_ALREADY_IN_PROJECT');
    // The connection can now select the project, as Consent "1 of 2" does.
    expectStatus(await dev.browser.request('POST', '/api/v1/agent-connections', { body: { agentId, name: 'Dev laptop', selectedProjectIds: [app.id],
      scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] } }), 201);
  });

  test('a reader\'s agent can only ask to read; Decline closes without a grant; others\' and managers\' agents are refused', async () => {
    const agentId = await agentOf(guest, space, 'Guest agent');
    const asked = expectStatus(await ask(guest, app.id, agentId, 'contributor'), 201) as AgentAccessRequest;
    assert.equal(asked.role, 'viewer', 'never more than its owner has');
    const declined = expectStatus(await anna.browser.request('POST', `/api/v1/projects/${app.id}/agent-requests/${asked.id}`, { body: { allow: false } }), 200) as AgentAccessRequest;
    assert.equal(declined.state, 'declined');
    assert.equal((await grantsOf(anna, app.id)).some((row) => row.principal.kind === 'agent' && row.principal.id === agentId), false);
    assert.ok((await inbox(guest)).some((item) => item.title === 'Guest agent was not let into Volunteer sign-up app'));
    // Someone else's agent, and a project the asker cannot open, look missing.
    assert.equal((await ask(dev, app.id, agentId)).status, 404);
    const hidden = await project(anna, space, 'Board only', 'restricted');
    assert.equal((await ask(guest, hidden.id, agentId)).status, 404);
    // A manager gives access directly.
    const annaAgent = await agentOf(anna, space, 'Anna agent');
    assert.equal(codeOf(await ask(anna, app.id, annaAgent)), 'AGENT_REQUEST_MANAGER');
    const rows = (await pool.query('SELECT count(*)::int AS n FROM agent_access_requests WHERE agent_id = $1', [annaAgent])).rows as { n: number }[];
    assert.equal(rows[0]!.n, 0);
  });
});

describe('#763 FT-2: a member\'s agent that a manager let in can be given the work of a task', () => {
  test('the owner adds standing grants within the agent\'s grant; without the manager\'s grant it is refused', async () => {
    const [anna, dev] = await Promise.all(['FT2 Anna', 'FT2 Dev'].map(person));
    const space = (await workspace(anna, 'Grant space')).id;
    await addMember(anna, space, dev, 'member');
    const app = await project(anna, space, 'Grant app', 'workspace');
    const task = expectStatus(await anna.browser.request('POST', `/api/v1/projects/${app.id}/work`, { body: { title: 'Write the FAQ page' } }), 201) as { id: string };
    const agentId = await agentOf(dev, space, 'Dev agent');
    const asked = expectStatus(await ask(dev, app.id, agentId), 201) as AgentAccessRequest;
    expectStatus(await anna.browser.request('POST', `/api/v1/projects/${app.id}/agent-requests/${asked.id}`, { body: { allow: true } }), 200);
    const connection = expectStatus(await dev.browser.request('POST', '/api/v1/agent-connections', { body: { agentId, name: 'Dev laptop', selectedProjectIds: [app.id],
      scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] } }), 201) as { id: string };
    const create = (operation: string, objectId?: string) => dev.browser.request('POST', `/api/v1/agent-connections/${connection.id}/action-grants`, { body: {
      clientCommandId: randomUUID(), projectId: app.id, operation, peerRequestClass: 'execute', ...(objectId ? { objectId } : {}), maximumUses: 100, expiresAt: later(7 * DAY) } });
    // The hand-off's work: change and take the task, record results, write in its thread, start Wiki docs.
    for (const [operation, objectId] of [['work.update', task.id], ['cowork.unit.create', task.id], ['cowork.claim'], ['cowork.renew'], ['cowork.release'],
      ['cowork.unit.complete'], ['result.record'], ['conversation.reply'], ['doc.create']] as const) {
      expectStatus(await create(operation, objectId), 201, `${operation} by a writing member`);
    }
    // When the manager takes the agent's grant away, the member can add no more.
    const agentGrant = (await grantsOf(anna, app.id)).find((row) => row.principal.kind === 'agent' && row.principal.id === agentId)!;
    expectStatus(await anna.browser.request('DELETE', `/api/v1/projects/${app.id}/grants/${agentGrant.id}`), 204);
    const refused = await create('work.update', task.id);
    // The connection's project is no longer the agent's, so it reads as missing (before the grant check's 403 AGENT_GRANT_REQUIRED).
    assert.ok([403, 404].includes(refused.status), refused.text);
    const after = (expectStatus(await dev.browser.request('GET', `/api/v1/agent-connections/${connection.id}/action-grants`), 200) as { total: number }).total;
    assert.equal(after, 9, 'nothing was added');
  });
});

describe('#763 FT-3: an invite made from a project', () => {
  test('carries the project: the new person can open it, lands there, and the inviter is told', async () => {
    const [anna, ben] = await Promise.all(['FT3 Anna', 'FT3 Ben'].map(person));
    const space = (await workspace(anna, 'Invite space')).id;
    await addMember(anna, space, ben, 'member');
    const app = await project(anna, space, 'Sign-up app', 'restricted');
    const headers = () => ({ 'idempotency-key': randomUUID() });
    // Only someone who manages the project can tie a link to it.
    assert.equal((await ben.browser.request('POST', `/api/v1/workspaces/${space}/invites`, { body: { role: 'member', projectId: app.id }, headers: headers() })).status, 403);
    const invite = expectStatus(await anna.browser.request('POST', `/api/v1/workspaces/${space}/invites`, { body: { role: 'member', projectId: app.id }, headers: headers() }), 201) as WorkspaceInvite;
    assert.deepEqual(invite.project, { id: app.id, name: 'Sign-up app' });
    const listed = expectStatus(await anna.browser.request('GET', `/api/v1/workspaces/${space}/invites`), 200) as WorkspaceInvite[];
    assert.deepEqual(listed.find((item) => item.id === invite.id)?.project, { id: app.id, name: 'Sign-up app' });
    const token = invite.link.split('#')[1]!;
    const basia = await person('FT3 Basia');
    assert.equal((expectStatus(await basia.browser.request('POST', '/api/v1/invites/preview', { body: { token } }), 200) as InvitePreview).projectName, 'Sign-up app');
    const joined = expectStatus(await basia.browser.request('POST', '/api/v1/invites/accept', { body: { token }, headers: headers() }), 200) as AcceptInviteResult;
    assert.equal(joined.projectId, app.id, 'lands in the project');
    const seen = expectStatus(await basia.browser.request('GET', `/api/v1/projects/${app.id}`), 200) as Project;
    assert.equal(seen.access, 'contributor');
    assert.ok((await inbox(anna)).some((item) => item.title === 'FT3 Basia joined Sign-up app' && item.url === `/projects/${app.id}?open=people`));
    // A link for the space only: the inviter is asked to give access, in Needs you.
    const plain = expectStatus(await anna.browser.request('POST', `/api/v1/workspaces/${space}/invites`, { body: { role: 'member' }, headers: headers() }), 201) as WorkspaceInvite;
    assert.equal(plain.project, null);
    const cleo = await person('FT3 Cleo');
    const cleoJoined = expectStatus(await cleo.browser.request('POST', '/api/v1/invites/accept', { body: { token: plain.link.split('#')[1]! }, headers: headers() }), 200) as AcceptInviteResult;
    assert.equal(cleoJoined.projectId, null);
    assert.ok((await needsYou(anna)).items.some((item) => item.title === 'FT3 Cleo joined your space' && item.kind === 'question'));
  });
});
