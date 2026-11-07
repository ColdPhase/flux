import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { AcceptInviteResult, InvitePreview, NeedsYouResponse, ProjectGrant, WorkspaceInvite } from '@flux/contracts';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';

// #763 first-time user study (docs/agents/release-acceptance/evidence/first-time-user.md):
// FT-1 (replaced by F-036, #855) nobody asks a manager to let an agent in: it has its owner's rights;
// FT-2 a member grants their agent the work of a handed task where they write (amendment of F-024 AC-4);
// FT-3 an invite made from a project opens that project and tells the inviter; FT-8 your own proposal does not ask you.

const needsYou = async (who: Person) => expectStatus(await who.browser.request('GET', '/api/v1/needs-you'), 200) as NeedsYouResponse;
const inbox = async (who: Person) => (expectStatus(await who.browser.request('GET', '/api/v1/inbox'), 200) as { items: { title: string; url: string | null; readAt: string | null }[] }).items;
const agentOf = async (who: Person, workspaceId: string, name: string) =>
  (expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
const ask = (who: Person, projectId: string, agentId: string, role?: 'viewer' | 'contributor') =>
  who.browser.request('POST', `/api/v1/projects/${projectId}/agent-requests`, { body: { agentId, ...(role ? { role } : {}) } });
const grantsOf = async (manager: Person, projectId: string) => expectStatus(await manager.browser.request('GET', `/api/v1/projects/${projectId}/grants`), 200) as ProjectGrant[];

describe('F-036 #855: nobody asks a manager to let an agent in', () => {
  test('the agent access request routes are gone; a member\'s agent already has its owner\'s rights', async () => {
    const [anna, dev] = await Promise.all(['FT1 Anna', 'FT1 Dev'].map(person));
    const space = (await workspace(anna, 'No manager requests')).id;
    await addMember(anna, space, dev, 'member');
    const app = await project(anna, space, 'Shared app', 'workspace');
    const agentId = await agentOf(dev, space, 'Dev agent');
    for (const response of [await ask(dev, app.id, agentId), await dev.browser.request('GET', `/api/v1/projects/${app.id}/agent-requests`),
      await dev.browser.request('GET', `/api/v1/agents/${agentId}/project-access`)]) assert.equal(response.status, 404);
    // Choosing the project for its connection needs no manager: the member writes here, so their agent may too.
    expectStatus(await dev.browser.request('POST', '/api/v1/agent-connections', { body: { agentId, name: 'Dev laptop', selectedProjectIds: [app.id],
      scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] } }), 201);
    assert.deepEqual((await grantsOf(anna, app.id)).filter((row) => row.principal.kind !== 'human'), [], 'and no grant was made for it');
    assert.equal((await needsYou(anna)).items.length, 0, 'the manager is asked nothing');
  });
});

describe('F-037: an invite link joins the company only', () => {
  test('a link carries no space; the new person lands in the company and the inviter is told', async () => {
    const [anna] = await Promise.all(['FT3 Anna'].map(person));
    const space = (await workspace(anna, 'Invite space')).id;
    const headers = () => ({ 'idempotency-key': randomUUID() });
    // A link never names a space any more: the field is dropped like any unknown one.
    const app = await project(anna, space, 'Sign-up app', 'restricted');
    const named = expectStatus(await anna.browser.request('POST', `/api/v1/workspaces/${space}/invites`, { body: { role: 'member', projectId: app.id }, headers: headers() }), 201) as WorkspaceInvite;
    assert.equal('project' in named, false);
    const plain = expectStatus(await anna.browser.request('POST', `/api/v1/workspaces/${space}/invites`, { body: { role: 'member' }, headers: headers() }), 201) as WorkspaceInvite;
    assert.equal('project' in plain, false);
    const token = plain.link.split('#')[1]!;
    const cleo = await person('FT3 Cleo');
    assert.equal('projectName' in (expectStatus(await cleo.browser.request('POST', '/api/v1/invites/preview', { body: { token } }), 200) as InvitePreview), false);
    const joined = expectStatus(await cleo.browser.request('POST', '/api/v1/invites/accept', { body: { token }, headers: headers() }), 200) as AcceptInviteResult;
    assert.equal(joined.status, 'joined');
    // A restricted space stays closed to the newcomer until someone adds them.
    assert.equal((await cleo.browser.request('GET', `/api/v1/projects/${app.id}`)).status, 404);
    assert.ok((await inbox(anna)).some((item) => item.title === 'FT3 Cleo joined Invite space' && item.url === '/settings/company'));
  });
});
