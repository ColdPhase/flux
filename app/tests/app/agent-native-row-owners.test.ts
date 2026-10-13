import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NamedPrincipal, ProjectPerson, WorkDetailProjection, WorkItem, WorkReferenceRows } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, removeMember, workspace, type Person } from './support/people.js';

/** A self- or workspace-owned agent with one task, read by a viewer through the public native work reads (#339 AC-2). */
async function scene(ownerKind: 'self' | 'workspace' = 'self') {
  const [manager, owner, reader] = await Promise.all(['Native manager', 'Native owner', 'Native reader'].map(person));
  const ws = await workspace(manager, 'Retained agent owners');
  await addMember(manager, ws.id, owner, 'member');
  await addMember(manager, ws.id, reader, 'guest');
  const place = await project(manager, ws.id, 'Retained work', 'restricted');
  await grant(manager, place.id, owner, 'contributor');
  await grant(manager, place.id, reader, 'viewer');
  const agent = expectStatus(await (ownerKind === 'self' ? owner : manager).browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, {
    body: { name: 'Retained analyst', owner: ownerKind },
  }), 201) as { id: string };
  const access = expectStatus(await manager.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
    body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
  }), 201) as { id: string };
  const task = expectStatus(await manager.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
    body: { title: 'Keep the retained owner', owner: { kind: 'agent', id: agent.id } },
  }), 201) as WorkItem;
  /** The overview's linked-row read: the task's native row as this viewer sees it. */
  const rowOwner = async (who: Person = reader): Promise<NamedPrincipal> => {
    const { items } = expectStatus(await who.browser.request('GET', `/api/v1/projects/${place.id}/work-reference-rows?objects=work:${task.id}`), 200) as WorkReferenceRows;
    const [row] = items;
    assert.ok(row?.kind === 'work' && row.owner?.kind === 'agent', 'the task row names its agent owner');
    return row.owner!;
  };
  /** The task's detail read, which the Work details sheet presents. */
  const detailOwner = async (who: Person = reader): Promise<NamedPrincipal | null> => {
    const { object } = expectStatus(await who.browser.request('GET', `/api/v1/projects/${place.id}/work-objects/work/${task.id}`), 200) as WorkDetailProjection;
    assert.equal(object.kind, 'work');
    return object.kind === 'work' ? object.owner : null;
  };
  return { manager, owner, reader, ws, place, agent, access, task, rowOwner, detailOwner };
}

test('a revoked agent keeps its name and its owner stays scoped while that human still has project access', async () => {
  const f = await scene();
  assert.deepEqual((await f.rowOwner()).projectOwner, { kind: 'human', id: f.owner.id }, 'the authorized owner is named while the agent is in the audience');

  expectStatus(await f.manager.browser.request('DELETE', `/api/v1/projects/${f.place.id}/grants/${f.access.id}`), 204);
  const people = expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.place.id}/people`), 200) as ProjectPerson[];
  assert.equal(people.some((item) => item.id === f.agent.id), false, 'the revoked agent is not restored to the audience');
  assert.ok(people.some((item) => item.kind === 'human' && item.id === f.owner.id));
  const retained = await f.rowOwner();
  assert.equal(retained.name, 'Retained analyst', 'the revoked agent keeps its display name');
  assert.deepEqual(retained.projectOwner, { kind: 'human', id: f.owner.id }, 'the overview row keeps the scoped owner');
  assert.deepEqual(await f.detailOwner(), { kind: 'agent', id: f.agent.id, name: 'Retained analyst', projectOwner: { kind: 'human', id: f.owner.id } },
    'the task detail carries the same scoped owner');

  await grant(f.manager, f.place.id, f.owner, 'denied');
  const hidden = await f.rowOwner();
  assert.equal(Object.hasOwn(hidden, 'projectOwner'), false, 'an owner without project access is omitted entirely');
  assert.equal(hidden.name, 'Retained analyst');
  assert.equal(Object.hasOwn((await f.detailOwner())!, 'projectOwner'), false, 'the detail omits it too');

  await grant(f.manager, f.place.id, f.owner, 'contributor');
  assert.deepEqual((await f.rowOwner()).projectOwner, { kind: 'human', id: f.owner.id }, 'restored access restores the scoped owner');

  await removeMember(f.manager, f.ws.id, f.owner);
  assert.equal(Object.hasOwn(await f.rowOwner(), 'projectOwner'), false, 'a former workspace member is not named');
});

test('a revoked workspace-owned agent keeps the workspace relation', async () => {
  const f = await scene('workspace');
  assert.deepEqual((await f.rowOwner()).projectOwner, { kind: 'workspace' });
  expectStatus(await f.manager.browser.request('DELETE', `/api/v1/projects/${f.place.id}/grants/${f.access.id}`), 204);
  assert.deepEqual((await f.rowOwner()).projectOwner, { kind: 'workspace' }, 'a retained workspace-owned agent stays attributed to the workspace');
});
