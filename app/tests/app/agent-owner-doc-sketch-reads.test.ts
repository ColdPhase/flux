import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { DocSummary, NamedPrincipal, Page, SketchPage } from '@flux/contracts';
import { pool } from './support/db.js';
import { agentConnection } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, removeMember, workspace, type Person } from './support/people.js';

/**
 * A self-owned agent with a project grant, and a viewer who reads the project lists (#339 AC-2). The owner is a
 * workspace admin, so it manages the project and can set up standing grants; ending its membership is the way its
 * access ends, because a workspace owner or admin keeps project management whatever project grant it has.
 */
async function scene() {
  const [manager, owner, reader] = await Promise.all(['List manager', 'List owner', 'List reader'].map(person));
  const ws = await workspace(manager, 'Scoped list owners');
  await addMember(manager, ws.id, owner, 'admin');
  await addMember(manager, ws.id, reader, 'guest');
  const place = await project(manager, ws.id, 'Scoped lists', 'restricted');
  await grant(manager, place.id, reader, 'viewer');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, {
    body: { name: 'List writer', owner: 'self' },
  }), 201) as { id: string };
  const access = expectStatus(await manager.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
    body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
  }), 201) as { id: string };
  const connection = await agentConnection(pool, owner.browser, agent.id, [place.id]);
  return { manager, owner, reader, ws, place, agent, access, connection };
}

const expectedAgent = (f: Awaited<ReturnType<typeof scene>>, projectOwner?: { kind: 'human'; id: string }): NamedPrincipal =>
  ({ kind: 'agent', id: f.agent.id, name: 'List writer', ...(projectOwner ? { projectOwner } : {}) });

test('a doc an agent last changed names its owner in the project list while that person has access, and drops it when access ends', async () => {
  const f = await scene();
  const create = await f.connection.grant('doc.create', 'plan');
  const created = toolValue(await f.connection.tool('flux_create_doc', {
    projectId: f.place.id, runtimeSessionId: f.connection.runtimeSessionId, grantId: create.id, clientCommandId: randomUUID(),
    peerRequestClass: 'plan', sources: [], doc: { title: 'Scoped list doc', body: 'Written by the agent.' },
  }));
  const docId = String(created.docId);
  const listed = async (who: Person = f.reader): Promise<DocSummary> => {
    const page = expectStatus(await who.browser.request('GET', `/api/v1/projects/${f.place.id}/docs`), 200) as Page<DocSummary>;
    const item = page.items.find((doc) => doc.id === docId);
    assert.ok(item, 'the agent-written doc is listed');
    return item;
  };
  assert.deepEqual((await listed()).updatedBy, expectedAgent(f, { kind: 'human', id: f.owner.id }), 'the authorized owner is named while the agent is in the audience');

  expectStatus(await f.manager.browser.request('DELETE', `/api/v1/projects/${f.place.id}/grants/${f.access.id}`), 204);
  const retained = (await listed()).updatedBy;
  assert.deepEqual(retained, expectedAgent(f, { kind: 'human', id: f.owner.id }), 'the revoked agent keeps its name and its owner stays scoped');

  await removeMember(f.manager, f.ws.id, f.owner);
  const hidden = (await listed()).updatedBy;
  assert.equal(Object.hasOwn(hidden, 'projectOwner'), false, 'an owner who lost access is omitted entirely');
  assert.equal(hidden.name, 'List writer');

  await addMember(f.manager, f.ws.id, f.owner, 'admin');
  assert.deepEqual((await listed()).updatedBy.projectOwner, { kind: 'human', id: f.owner.id }, 'restored access restores the scoped owner');
});

test('a project sketch an agent created names its creator with the scoped owner, and drops it when access ends', async () => {
  const f = await scene();
  const create = await f.connection.grant('map.create', 'plan', 10);
  const created = toolValue(await f.connection.tool('flux_create_map', {
    projectId: f.place.id, runtimeSessionId: f.connection.runtimeSessionId, grantId: create.id, clientCommandId: randomUUID(),
    peerRequestClass: 'plan', sources: [], title: 'Scoped list sketch',
  }));
  const sketchId = String(created.mapId);
  const listed = async (who: Person = f.reader) => {
    const page = expectStatus(await who.browser.request('GET', `/api/v1/workspaces/${f.ws.id}/sketches?projectId=${f.place.id}`), 200) as SketchPage;
    const item = page.items.find((sketch) => sketch.id === sketchId);
    assert.ok(item, 'the agent-created sketch is listed');
    return item.createdBy;
  };
  assert.deepEqual(await listed(), expectedAgent(f, { kind: 'human', id: f.owner.id }), 'the authorized owner is named while the agent is in the audience');

  expectStatus(await f.manager.browser.request('DELETE', `/api/v1/projects/${f.place.id}/grants/${f.access.id}`), 204);
  assert.deepEqual(await listed(), expectedAgent(f, { kind: 'human', id: f.owner.id }), 'the revoked agent keeps its name and its owner stays scoped');

  await removeMember(f.manager, f.ws.id, f.owner);
  const hidden = await listed();
  assert.equal(Object.hasOwn(hidden, 'projectOwner'), false, 'an owner who lost access is omitted entirely');
  assert.equal(hidden.name, 'List writer');

  await addMember(f.manager, f.ws.id, f.owner, 'admin');
  assert.deepEqual((await listed()).projectOwner, { kind: 'human', id: f.owner.id }, 'restored access restores the scoped owner');
});
