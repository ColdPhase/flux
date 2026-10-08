import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectPerson } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, removeMember, workspace } from './support/people.js';

test('agent owner labels use only the current project audience, including guest reads and revocation', async () => {
  const [manager, owner, guest, hidden, outsider] = await Promise.all(['Owner manager', 'Riley Owner', 'Guest reader', 'Hidden member', 'Outside reader'].map(person));
  const ws = await workspace(manager, 'Scoped agent labels');
  for (const member of [owner, hidden]) await addMember(manager, ws.id, member, 'member');
  await addMember(manager, ws.id, guest, 'guest');
  const place = await project(manager, ws.id, 'Only project audience', 'restricted');
  await grant(manager, place.id, owner, 'contributor');
  await grant(manager, place.id, guest, 'viewer');
  const create = async (actor: typeof owner, name: string, own: string) => expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, {
    body: { name, owner: own },
  }), 201) as { id: string };
  const agent = await create(owner, 'Riley coding agent', 'self');
  const shared = await create(manager, 'Workspace agent', 'workspace');
  for (const id of [agent.id, shared.id]) expectStatus(await manager.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
    body: { principal: { kind: 'agent', id }, role: 'contributor' },
  }), 201);
  const path = `/api/v1/projects/${place.id}/people`;
  const read = async () => expectStatus(await guest.browser.request('GET', path), 200) as ProjectPerson[];
  let listed = await read();
  assert.deepEqual(listed.find((item) => item.id === agent.id)?.agentOwner, { kind: 'human', id: owner.id, name: 'Riley Owner' });
  assert.deepEqual(listed.find((item) => item.id === shared.id)?.agentOwner, { kind: 'workspace' });
  assert.equal(listed.some((item) => item.id === hidden.id), false);
  assert.ok(listed.filter((item) => item.kind === 'human').every((item) => item.agentOwner === undefined));
  expectStatus(await guest.browser.request('GET', `/api/v1/workspaces/${ws.id}/members`), 403);
  expectStatus(await outsider.browser.request('GET', path), 404);
  await grant(manager, place.id, owner, 'denied');
  listed = await read();
  assert.equal(listed.some((item) => item.id === owner.id || item.id === agent.id), false, 'owner deny also hides its agent under existing policy');
  await grant(manager, place.id, owner, 'contributor');
  assert.ok((await read()).some((item) => item.id === agent.id));
  expectStatus(await owner.browser.request('DELETE', `/api/v1/agents/${agent.id}`), 200);
  assert.equal((await read()).some((item) => item.id === agent.id), false, 'revoked agent is absent');
  await removeMember(manager, ws.id, owner);
  assert.equal((await read()).some((item) => item.id === owner.id), false);
  await grant(manager, place.id, guest, 'denied');
  expectStatus(await guest.browser.request('GET', path), 404, 'reader revocation takes effect on the next read');
});
