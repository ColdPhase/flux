import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, Page, Project, Workspace } from '@flux/contracts';
import { evaluateProject, type Principal } from '@flux/core';
import { accessReader, memberFilter, reachableProjectIds, schema, sql } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { searchUseCases } from '../../apps/server/src/search/adapters.js';
import { SearchCursorCodec } from '../../apps/server/src/search/cursor.js';
import { db, pool } from './support/db.js';
import { agentConnection } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';

// C-15 and #934 (founder direction, Hubert, 2026-11-07): an agent sees what its owner sees in the sidebar. A company owner or admin
// reaches every space themselves, but their agents (server agents, local clients, `/ai`) read, search and act only in the spaces the
// person was added to, until the person adds themselves to another with Add me. Every surface below decides through the same access SQL.

describe('a company admin\'s agents reach only the spaces the admin was added to (C-15, #934)', () => {
  const connections = new FakeConnections();
  const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections, providerEnabled: true });
  const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
  let ari: Person; let mira: Person; let lee: Person; let ws: Workspace;
  let open: Project; let closed: Project; let closedTalk: Conversation; let openTalk: Conversation;
  const agents: Record<string, string> = {};
  const agentOf = (key: string): Principal => ({ kind: 'agent', id: agents[key]! });

  const level = async (principal: Principal, projectId: string, action: 'project.read' | 'project.write' | 'project.manage' = 'project.read') =>
    evaluateProject(principal, action, projectId, accessReader(db));
  const projectNames = async (principal: Principal) => {
    const filter = await memberFilter(principal, ws.id, 'project', db);
    return (await db.select({ name: schema.projects.name }).from(schema.projects).where(filter)).map((row) => row.name).sort();
  };
  const search = searchUseCases(db, new SearchCursorCodec('admin-agents-scope-secret-of-32-characters-or-more'));
  const found = async (principal: Principal) => (await search.search(principal, { q: 'Tidal' })).items.map((item) => item.title.map((part) => part.text).join('')).sort();

  before(async () => {
    [ari, mira, lee] = await Promise.all(['aas-ari', 'aas-mira', 'aas-lee'].map(person));
    ws = await createWorkspace(ari, 'Tidal club');
    await addMember(ari, ws.id, mira, 'admin');
    await addMember(ari, ws.id, lee, 'member');
    open = await createProject(ari, ws.id, 'Tidal open', 'workspace');
    // A closed space only Lee belongs to: Ari (the company's owner) and Mira (an admin) reach it, but were never added.
    closed = await createProject(lee, ws.id, 'Tidal closed', 'restricted');
    closedTalk = expectStatus(await lee.browser.request('POST', `/api/v1/projects/${closed.id}/conversations`, { body: { body: 'The tide table for the closed space', clientMessageId: randomUUID() } }), 201) as Conversation;
    openTalk = expectStatus(await ari.browser.request('POST', `/api/v1/projects/${open.id}/conversations`, { body: { body: 'The tide table for everyone', clientMessageId: randomUUID() } }), 201) as Conversation;
    for (const [key, someone] of [['ari', ari], ['mira', mira], ['lee', lee]] as const) {
      agents[key] = (expectStatus(await someone.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: `${key} helper`, owner: 'self' } }), 201) as { id: string }).id;
      const connection = randomUUID();
      connections.connect(someone.id, connection);
      await runs.enable(human(someone), { agentId: agents[key]!, connection, model: 'claude-sonnet-5' });
    }
  });

  test('the admin reaches the closed space but is not in it (the baseline C-15 already had)', async () => {
    const list = expectStatus(await mira.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects`), 200) as Page<Project>;
    const entries = new Map(list.items.map((item) => [item.name, item]));
    assert.equal(entries.get('Tidal closed')?.member, false, 'reachable, but not a space of hers');
    assert.equal(entries.get('Tidal open')?.member, true);
    expectStatus(await mira.browser.request('GET', `/api/v1/projects/${closed.id}`), 200);
    assert.ok(!(await found(human(mira))).includes('Tidal closed'), 'and her search does not show it');
  });

  test('server agents: a company admin\'s and owner\'s agents read and act only in the spaces the person was added to', async () => {
    for (const key of ['mira', 'ari'] as const) {
      const closedRead = await level(agentOf(key), closed.id);
      assert.deepEqual([closedRead.allowed, closedRead.visible], [false, false], `${key}'s agent does not even learn that the closed space exists`);
      assert.equal((await level(agentOf(key), closed.id, 'project.write')).allowed, false);
      assert.deepEqual([(await level(agentOf(key), open.id)).allowed, (await level(agentOf(key), open.id, 'project.write')).allowed], [true, true], 'and works in Everyone');
      assert.deepEqual((await projectNames(agentOf(key))).filter((name) => name.startsWith('Tidal')), ['Tidal open'], 'lists');
      assert.deepEqual(await found(agentOf(key)), ['Tidal open'], 'search');
    }
    // The person herself still reaches it, and a member's agent is unchanged (the member belongs where the level says).
    assert.equal((await level(human(mira), closed.id)).allowed, true);
    assert.deepEqual([(await level(agentOf('lee'), closed.id, 'project.write')).allowed, (await level(agentOf('lee'), open.id)).allowed], [true, true]);
  });

  test('/ai: the admin\'s assistant cannot be asked in a space she was not added to, and can in one she was', async () => {
    const refused = await runs.invoke(human(mira), closedTalk.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'What does the tide table say?' }).then(() => null, (error: unknown) => error as { code?: string });
    assert.equal(refused?.code, 'PERSONAL_RUN_NO_PROJECT_ACCESS', 'her assistant has no access to the closed space');
    const asked = await runs.invoke(human(mira), openTalk.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'What does the tide table say?' });
    assert.ok(asked.run.id, 'in Everyone it works');
  });

  test('local clients: a signed-in client reaches only spaces the admin belongs to, and the assistant\'s reach is the same list', async () => {
    const client = await agentConnection(pool, mira.browser, agents.mira, [open.id]);
    const listed = (toolValue(await client.tool('flux_list_contexts', {})).projects as { id: string }[]).map((entry) => entry.id);
    assert.ok(!listed.includes(closed.id) && listed.includes(open.id), 'the client lists only the space she belongs to');
    const refused = await client.raw('flux_bootstrap', { projectId: closed.id, clientSessionId: randomUUID() });
    assert.ok(refused.status !== 200 || (refused.message?.result as { isError?: boolean } | undefined)?.isError === true, 'and is refused in the closed space');
    // The assistant's reach is every space its owner belongs to now, and for an admin that is the spaces she was added to.
    const assistant = (await db.execute<{ id: string }>(sql`SELECT id FROM agent_connections WHERE owner_user_id = ${mira.id} AND compute_source = 'owner_assistant' LIMIT 1`)).rows[0];
    assert.ok(assistant, 'her assistant has a connection');
    const reach = await db.transaction((tx) => reachableProjectIds(tx, assistant.id));
    assert.ok(!reach.includes(closed.id) && reach.includes(open.id), 'the assistant\'s projects leave out the closed space');
    assert.deepEqual(await db.transaction((tx) => reachableProjectIds(tx, client.connectionId)), reach, 'a client and the assistant reach the same list');
  });

  test('Add me: once the admin adds herself to the closed space her agents work there, and only there', async () => {
    const second = await createProject(lee, ws.id, 'Tidal second closed', 'restricted');
    await grant(mira, closed.id, mira, 'manager');
    assert.deepEqual([(await level(agentOf('mira'), closed.id, 'project.manage')).allowed, (await level(agentOf('mira'), closed.id, 'project.write')).allowed], [true, true], 'as its admin');
    assert.deepEqual(await found(agentOf('mira')), ['Tidal closed', 'Tidal open']);
    assert.equal((await level(agentOf('mira'), second.id)).allowed, false, 'not in the other closed space');
    assert.equal((await level(agentOf('ari'), closed.id)).allowed, false, 'and Ari\'s agent is still outside: it follows its own owner');
    const client = await agentConnection(pool, mira.browser, agents.mira, [closed.id]);
    assert.ok((toolValue(await client.tool('flux_list_contexts', {})).projects as { id: string }[]).some((entry) => entry.id === closed.id), 'a local client works in the space she joined');
    const asked = await runs.invoke(human(mira), closedTalk.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'And now?' });
    assert.ok(asked.run.id, '/ai works in the space she joined');
  });
});
