import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { Project, Workspace } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// A project's goal (#272 F-023 FF-6) through the running API: who may set it, the version
// precondition, normalising, the length limit and clearing.

async function setGoal(actor: Person, projectId: string, goal: unknown, version: number | null) {
  return actor.browser.request('PATCH', `/api/v1/projects/${projectId}`, { body: { goal }, headers: version === null ? {} : { 'if-match': `"${version}"` } });
}

describe('project goal over HTTP', () => {
  let owner: Person;
  let contributor: Person;
  let viewer: Person;
  let member: Person;
  let outsider: Person;
  let ws: Workspace;
  let room: Project;

  before(async () => {
    [owner, contributor, viewer, member, outsider] = await Promise.all(['owner', 'contributor', 'viewer', 'member', 'outsider'].map(person));
    ws = await workspace(owner, 'Garden');
    await addMember(owner, ws.id, contributor, 'member');
    await addMember(owner, ws.id, viewer, 'member');
    await addMember(owner, ws.id, member, 'member');
    room = await project(owner, ws.id, 'Sensors', 'restricted');
    await grant(owner, room.id, contributor, 'contributor');
    await grant(owner, room.id, viewer, 'viewer');
  });

  test('a new project has no goal, and reading it returns its version as an ETag', async () => {
    const response = await owner.browser.request('GET', `/api/v1/projects/${room.id}`);
    const read = expectStatus(response, 200) as Project;
    assert.equal(read.goal, null);
    assert.equal(response.headers.get('etag'), `"${read.version}"`);
  });

  test('a change needs the version the person saw', async () => {
    expectStatus(await setGoal(owner, room.id, 'Know when the beds need water', null), 428);
  });

  test('an editor sets the goal; spaces are tidied and the version moves on', async () => {
    const before = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${room.id}`), 200) as Project;
    const saved = expectStatus(await setGoal(contributor, room.id, '  Know when   the beds\nneed water ', before.version), 200) as Project;
    assert.equal(saved.goal, 'Know when the beds need water');
    assert.equal(saved.version, before.version + 1);
    const read = expectStatus(await viewer.browser.request('GET', `/api/v1/projects/${room.id}`), 200) as Project;
    assert.equal(read.goal, 'Know when the beds need water', 'every reader sees it');
  });

  test('a stale version is refused with the current project, and nothing changes', async () => {
    const current = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${room.id}`), 200) as Project;
    const refused = await setGoal(owner, room.id, 'Something else', current.version - 1);
    const body = expectStatus(refused, 409) as { code: string; currentVersion: number; current: Project };
    assert.deepEqual([body.code, body.currentVersion, body.current.goal], ['VERSION_CONFLICT', current.version, current.goal]);
    const after = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${room.id}`), 200) as Project;
    assert.equal(after.goal, current.goal);
  });

  test('readers without edit rights cannot change it, and people outside never learn it exists', async () => {
    const current = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${room.id}`), 200) as Project;
    expectStatus(await setGoal(viewer, room.id, 'Mine now', current.version), 403);
    expectStatus(await setGoal(member, room.id, 'Mine now', current.version), 404);
    expectStatus(await setGoal(outsider, room.id, 'Mine now', current.version), 404);
  });

  test('a goal is one line of at most 200 characters, and an empty one clears it', async () => {
    let current = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${room.id}`), 200) as Project;
    expectStatus(await setGoal(owner, room.id, 'x'.repeat(201), current.version), 400);
    expectStatus(await setGoal(owner, room.id, ['two', 'lines'], current.version), 400);
    const longest = expectStatus(await setGoal(owner, room.id, 'é'.repeat(200), current.version), 200) as Project;
    assert.equal([...longest.goal!].length, 200);
    current = longest;
    const cleared = expectStatus(await setGoal(owner, room.id, '   ', current.version), 200) as Project;
    assert.equal(cleared.goal, null);
    const again = expectStatus(await setGoal(owner, room.id, null, cleared.version), 200) as Project;
    assert.equal(again.version, cleared.version, 'clearing an empty goal changes nothing');
  });
});
