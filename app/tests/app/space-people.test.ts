import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { projectGrantsPath, projectLeavePath, projectPeoplePath, type Project, type ProjectGrant, type ProjectPerson } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// F-037 (#874), review of #895: the people of a space are the people it was added to, for everyone who can open it (P2-3, P2-4); a space always
// keeps an admin on space-level actions, by every route (P2-5, C-16); and a new space can start with any person of the company (D-3).

const code = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;

describe('the people of a space', () => {
  let owner: Person; let companyAdmin: Person; let spaceAdmin: Person; let member: Person; let guest: Person; let outsider: Person;
  let wsId: string; let space: Project;
  const people = async (who: Person, id = space.id) => (expectStatus(await who.browser.request('GET', projectPeoplePath(id)), 200) as ProjectPerson[]);

  before(async () => {
    [owner, companyAdmin, spaceAdmin, member, guest, outsider] = await Promise.all(['pp-owner', 'pp-admin', 'pp-space-admin', 'pp-member', 'pp-guest', 'pp-outsider'].map((label) => person(label)));
    wsId = (await workspace(owner, 'People club')).id;
    await addMember(owner, wsId, companyAdmin, 'admin');
    for (const other of [spaceAdmin, member, outsider]) await addMember(owner, wsId, other, 'member');
    await addMember(owner, wsId, guest, 'guest');
    space = await project(spaceAdmin, wsId, 'Added people only', 'restricted');
    await grant(spaceAdmin, space.id, member, 'contributor');
    await grant(spaceAdmin, space.id, guest, 'contributor');
  });

  test('an admin, a member and a guest read the same list: the people added to the space; a company admin who was not added is not in it', async () => {
    const expected = [guest.id, member.id, spaceAdmin.id].sort();
    for (const [label, who] of [['space admin', spaceAdmin], ['member', member], ['guest', guest], ['company admin who was not added', companyAdmin], ['owner who was not added', owner]] as const) {
      const listed = (await people(who)).filter((row) => row.kind === 'human');
      assert.deepEqual(listed.map((row) => row.id).sort(), expected, `${label} reads the people added to the space`);
    }
    const roles = Object.fromEntries((await people(member)).map((row) => [row.id, row.access]));
    assert.deepEqual(roles, { [spaceAdmin.id]: 'manager', [member.id]: 'contributor', [guest.id]: 'contributor' });
    expectStatus(await outsider.browser.request('GET', projectPeoplePath(space.id)), 404);
  });

  test('a company admin who is added is listed, as an admin; an agent is listed with its owner, and not when its owner was not added', async () => {
    const own = await project(spaceAdmin, wsId, 'With agents', 'restricted');
    await grant(spaceAdmin, own.id, member, 'contributor');
    const memberAgent = expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${wsId}/agents`, { body: { name: 'Member agent', owner: 'self' } }), 201) as { id: string };
    const ownerAgent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${wsId}/agents`, { body: { name: 'Owner agent', owner: 'self' } }), 201) as { id: string };
    const listed = await people(spaceAdmin, own.id);
    assert.ok(listed.some((row) => row.kind === 'agent' && row.id === memberAgent.id && row.agentOwner?.id === member.id), 'an agent of a listed person is listed');
    assert.ok(!listed.some((row) => row.id === ownerAgent.id), 'the agent of an owner who was not added is not');
    assert.ok(!listed.some((row) => row.id === owner.id || row.id === companyAdmin.id));
    await grant(spaceAdmin, own.id, companyAdmin, 'manager');
    const after = await people(member, own.id);
    assert.equal(after.find((row) => row.id === companyAdmin.id)?.access, 'manager', 'added, the company admin is one of its admins');
  });

  test('in Everyone-style spaces (open to the company) the whole company is listed, a guest only when added', async () => {
    const open = await project(owner, wsId, 'Open to everyone', 'workspace');
    const listed = (await people(member, open.id)).filter((row) => row.kind === 'human').map((row) => row.id);
    assert.ok([owner.id, companyAdmin.id, spaceAdmin.id, member.id, outsider.id].every((id) => listed.includes(id)));
    assert.ok(!listed.includes(guest.id), 'a guest who was not added is not in it');
  });
});

describe('a space always keeps an admin (C-16)', () => {
  let owner: Person; let companyAdmin: Person; let first: Person; let second: Person; let member: Person;
  let wsId: string;
  const grantOf = async (spaceId: string, who: Person) => (expectStatus(await owner.browser.request('GET', projectGrantsPath(spaceId)), 200) as ProjectGrant[]).find((row) => row.principal.id === who.id)!;
  const set = (actor: Person, spaceId: string, target: Person, role: string) => actor.browser.request('POST', projectGrantsPath(spaceId), { body: { principal: { kind: 'human', id: target.id }, role } });
  const freshSpace = async (name: string, creator = first) => { const made = await project(creator, wsId, name, 'restricted'); await grant(creator, made.id, member, 'contributor'); return made; };
  const refused = (response: { status: number; json: unknown }) => assert.deepEqual([response.status, code(response)], [422, 'LAST_SPACE_ADMIN']);

  before(async () => {
    [owner, companyAdmin, first, second, member] = await Promise.all(['la-owner', 'la-admin', 'la-first', 'la-second', 'la-member'].map((label) => person(label)));
    wsId = (await workspace(owner, 'Last admin club')).id;
    await addMember(owner, wsId, companyAdmin, 'admin');
    for (const other of [first, second, member]) await addMember(owner, wsId, other, 'member');
  });

  test('the last admin cannot step down, remove themselves, leave, or be removed or demoted by a company admin; every refusal has its allowed control', async () => {
    const space = await freshSpace('Alone at the top');
    refused(await set(first, space.id, first, 'contributor'));
    refused(await set(first, space.id, first, 'viewer'));
    refused(await set(first, space.id, first, 'denied'));
    refused(await set(companyAdmin, space.id, first, 'contributor'));
    refused(await set(companyAdmin, space.id, first, 'denied'));
    const own = await grantOf(space.id, first);
    refused(await first.browser.request('DELETE', `/api/v1/projects/${space.id}/grants/${own.id}`));
    refused(await companyAdmin.browser.request('DELETE', `/api/v1/projects/${space.id}/grants/${own.id}`));
    refused(await first.browser.request('POST', projectLeavePath(space.id)));
    assert.equal((await grantOf(space.id, first)).role, 'manager', 'nothing changed');
    // The allowed controls: setting the same role again, and an admin who is not the last.
    expectStatus(await set(first, space.id, first, 'manager'), 201);
    expectStatus(await set(first, space.id, second, 'manager'), 201);
    expectStatus(await set(first, space.id, first, 'contributor'), 201);
    assert.equal((await grantOf(space.id, first)).role, 'contributor');
    refused(await set(second, space.id, second, 'contributor'));
    refused(await set(companyAdmin, space.id, second, 'contributor'));
    expectStatus(await first.browser.request('GET', `/api/v1/projects/${space.id}`), 200);
  });

  test('with another admin the first one leaves; a plain member leaves and is removed as before', async () => {
    const space = await freshSpace('Two admins');
    await grant(first, space.id, second, 'manager');
    assert.equal((await first.browser.request('POST', projectLeavePath(space.id))).status, 204);
    assert.equal((await member.browser.request('POST', projectLeavePath(space.id))).status, 204);
    refused(await second.browser.request('POST', projectLeavePath(space.id)));
  });

  test('removing the last admin from the company, or making them a guest, is not blocked; a company admin then adds themselves', async () => {
    const left = await freshSpace('Admin leaves the company', second);
    const guestAdmin = await freshSpace('Admin becomes a guest');
    assert.equal((await owner.browser.request('PATCH', `/api/v1/workspaces/${wsId}/members/${first.id}`, { body: { role: 'guest' } })).status, 200, 'making them a guest is allowed');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_grants WHERE project_id = $1 AND role = 'manager'`, [guestAdmin.id])).rows[0].n, 0, 'the space has no admin by grant now');
    expectStatus(await set(companyAdmin, guestAdmin.id, companyAdmin, 'manager'), 201);
    assert.equal((await owner.browser.request('DELETE', `/api/v1/workspaces/${wsId}/members/${second.id}`)).status, 204, 'removing the last admin of another space from the company is allowed');
    expectStatus(await set(companyAdmin, left.id, companyAdmin, 'manager'), 201);
    assert.equal((expectStatus(await companyAdmin.browser.request('GET', `/api/v1/projects/${left.id}`), 200) as Project).access, 'manager');
  });
});

describe('a new space starts with any person of the company (D-3)', () => {
  test('a plain member adds the company owner and another member; they are in the space as members', async () => {
    const [owner, creator, other] = await Promise.all(['ns-owner', 'ns-creator', 'ns-other'].map((label) => person(label)));
    const wsId = (await workspace(owner, 'New space club')).id;
    await addMember(owner, wsId, creator, 'member');
    await addMember(owner, wsId, other, 'member');
    const made = expectStatus(await creator.browser.request('POST', `/api/v1/workspaces/${wsId}/projects`,
      { body: { name: 'With the owner', visibility: 'restricted', people: [owner.id, other.id] } }), 201) as Project;
    const roles = Object.fromEntries((await pool.query('SELECT user_id, role FROM project_grants WHERE project_id = $1', [made.id])).rows.map((row) => [row.user_id, row.role]));
    assert.deepEqual(roles, { [creator.id]: 'manager', [owner.id]: 'contributor', [other.id]: 'contributor' });
    assert.deepEqual((expectStatus(await creator.browser.request('GET', projectPeoplePath(made.id)), 200) as ProjectPerson[]).map((row) => row.id).sort(), [creator.id, other.id, owner.id].sort());
  });
});
