import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Page, Project, ProjectGrant, ProjectPerson, Sketch, Workspace, WorkspaceMember } from '@flux/contracts';
import { pool } from './support/db.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, removeFromSpace, person, project, workspace, type Person } from './support/people.js';

// Workspace, project, grant and map policy through the running API (issue #29, AC-2/AC-3).

/** A map in a space, made by `actor`; the map is the object whose audience these tests follow. */
async function mapIn(actor: Person, workspaceId: string, title: string, projectId: string) {
  return expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/sketches`, { body: { title, scope: 'project', projectId } }), 201, 'create map') as Sketch;
}

async function maps(actor: Person, workspaceId: string, query = '') {
  return actor.browser.request('GET', `/api/v1/workspaces/${workspaceId}/sketches${query}`);
}

const readMap = (actor: Person, sketchId: string) => actor.browser.request('GET', `/api/v1/sketches/${sketchId}`);

describe('workspace access policy over HTTP', () => {
  let owner: Person;
  let admin: Person;
  let member: Person;
  let other: Person;
  let guest: Person;
  let outsider: Person;
  let ws: Workspace;

  before(async () => {
    [owner, admin, member, other, guest, outsider] = await Promise.all(['owner', 'admin', 'member', 'other', 'guest', 'outsider'].map(person));
    ws = await workspace(owner, 'Tide');
    await addMember(owner, ws.id, admin, 'admin');
    await addMember(owner, ws.id, member, 'member');
    await addMember(owner, ws.id, other, 'member');
    await addMember(owner, ws.id, guest, 'guest');
  });

  test('the creator owns a new workspace and non-members cannot see it', async () => {
    assert.equal(ws.role, 'owner');
    const members = expectStatus(await owner.browser.request('GET', `/api/v1/workspaces/${ws.id}/members`), 200) as WorkspaceMember[];
    assert.deepEqual(new Set(members.map((m) => `${m.userId}:${m.role}`)), new Set([
      `${owner.id}:owner`, `${admin.id}:admin`, `${member.id}:member`, `${other.id}:member`, `${guest.id}:guest`,
    ]));
    expectStatus(await outsider.browser.request('GET', `/api/v1/workspaces/${ws.id}`), 404, 'outsider reads workspace');
    expectStatus(await maps(outsider, ws.id), 404, 'outsider lists maps');
    expectStatus(await outsider.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects`), 404, 'outsider lists projects');
    expectStatus(await outsider.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'intrusion', scope: 'private' } }), 404, 'outsider creates a map');
    const listed = expectStatus(await outsider.browser.request('GET', '/api/v1/workspaces'), 200) as Workspace[];
    assert.equal(listed.some((w) => w.id === ws.id), false);
    expectStatus(await guest.browser.request('GET', `/api/v1/workspaces/${ws.id}/members`), 403, 'guest cannot list members');
    expectStatus(await new Browser().request('GET', `/api/v1/workspaces/${ws.id}`), 401, 'anonymous');
    expectStatus(await new Browser().request('GET', `/api/v1/sketches/${randomUUID()}`), 401, 'anonymous map');
    expectStatus(await owner.browser.request('GET', '/api/v1/sketches/not-a-uuid'), 404, 'malformed id');
    expectStatus(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'x' }, origin: 'https://evil.example' }), 403, 'foreign origin');
  });

  test('a private map is its author\'s alone: other members, admins and guests cannot see it', async () => {
    const secret = expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'Unredacted support report', scope: 'private' } }), 201, 'create private map') as Sketch;
    assert.equal(secret.scope, 'private');
    assert.deepEqual({ kind: secret.createdBy.kind, id: secret.createdBy.id }, { kind: 'human', id: member.id });
    expectStatus(await readMap(member, secret.id), 200);
    for (const viewer of [other, admin, owner, guest, outsider]) {
      expectStatus(await readMap(viewer, secret.id), 404, 'private map read');
    }
    const listed = expectStatus(await maps(other, ws.id), 200) as Page<Sketch>;
    assert.equal(listed.items.some((d) => d.id === secret.id), false);
  });

  test('a map in a restricted project is read only by the project\'s people and the company\'s admins', async () => {
    const restricted = await project(owner, ws.id, 'Support escalations', 'restricted');
    await grant(owner, restricted.id, member, 'contributor');
    await grant(owner, restricted.id, guest, 'contributor');
    const report = await mapIn(member, ws.id, 'Redacted report', restricted.id);
    expectStatus(await readMap(guest, report.id), 200, 'guest grantee');
    expectStatus(await readMap(admin, report.id), 200, 'admin manages every project');
    expectStatus(await readMap(other, report.id), 404, 'member without grant');
    expectStatus(await readMap(outsider, report.id), 404, 'outsider');
  });

  test('a restricted project is invisible to a member without a grant in get, list and count', async () => {
    const hidden = await project(owner, ws.id, 'Hidden budget', 'restricted');
    const open = await project(owner, ws.id, 'Open roadmap', 'workspace');
    const inside = await mapIn(owner, ws.id, 'Budget line', hidden.id);
    expectStatus(await readMap(other, inside.id), 404, 'get a map in the hidden project');
    expectStatus(await other.browser.request('GET', `/api/v1/projects/${hidden.id}`), 404, 'get hidden');
    expectStatus(await other.browser.request('GET', `/api/v1/projects/${hidden.id}/grants`), 404, 'grants of hidden');
    expectStatus(await other.browser.request('GET', `/api/v1/projects/${open.id}`), 200, 'get open');
    const mine = expectStatus(await other.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects?limit=100`), 200) as Page<Project>;
    const all = expectStatus(await owner.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects?limit=100`), 200) as Page<Project>;
    assert.equal(mine.items.some((p) => p.id === hidden.id), false);
    assert.equal(mine.items.find((p) => p.id === open.id)?.access, 'contributor');
    assert.equal(all.items.find((p) => p.id === hidden.id)?.access, 'manager');
    const restrictedCount = all.items.filter((p) => p.visibility === 'restricted').length;
    assert.equal(mine.total, all.total - restrictedCount, 'count excludes restricted projects');
    assert.equal(mine.items.length, mine.total);
    const filtered = expectStatus(await maps(other, ws.id, `?projectId=${hidden.id}`), 200) as Page<Sketch>;
    assert.equal(filtered.total, 0);
    assert.deepEqual(filtered.items, []);
  });

  test('a member writes in the space; managing it stays with its admins', async () => {
    const docs = await project(owner, ws.id, 'Export docs', 'restricted');
    await grant(owner, docs.id, other, 'contributor');
    const spec = await mapIn(owner, ws.id, 'Export spec', docs.id);
    expectStatus(await readMap(other, spec.id), 200, 'member reads');
    const edited = expectStatus(await other.browser.request('PATCH', `/api/v1/sketches/${spec.id}`, { body: { title: 'member edit' }, headers: { 'if-match': `"${spec.version}"` } }), 200) as Sketch;
    assert.equal(edited.title, 'member edit');
    assert.equal(edited.version, spec.version + 1);
    await mapIn(other, ws.id, 'into docs', docs.id);
    expectStatus(await other.browser.request('GET', `/api/v1/projects/${docs.id}/grants`), 403, 'member cannot manage grants');
    await grant(owner, docs.id, other, 'contributor');
    const grants = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${docs.id}/grants`), 200) as ProjectGrant[];
    // F-037: the creator's own admin grant comes with the space.
    assert.deepEqual(grants.filter((g) => g.principal.id !== owner.id).map((g) => [g.principal.id, g.role]), [[other.id, 'contributor']], 'grant replaced, not duplicated');
  });

  test('a guest sees only explicitly granted projects', async () => {
    const lobby = await project(owner, ws.id, 'Lobby', 'workspace');
    const portal = await project(owner, ws.id, 'Customer portal', 'restricted');
    await grant(owner, portal.id, guest, 'contributor');
    const announcement = await mapIn(owner, ws.id, 'Team announcement', lobby.id);
    expectStatus(await readMap(member, announcement.id), 200, 'member sees a map in a workspace project');
    expectStatus(await readMap(guest, announcement.id), 404, 'guest does not');
    expectStatus(await guest.browser.request('GET', `/api/v1/projects/${lobby.id}`), 404, 'guest and workspace project');
    const projects = expectStatus(await guest.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects`), 200) as Page<Project>;
    assert.ok(projects.items.every((p) => p.visibility === 'restricted'), 'guest lists only granted projects');
    assert.ok(projects.items.some((p) => p.id === portal.id));
    assert.equal(projects.total, projects.items.length);
    await mapIn(guest, ws.id, 'Guest map', portal.id);
    expectStatus(await guest.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Guest project' } }), 403, 'guest creates project');
    expectStatus(await guest.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { email: outsider.email, role: 'member' } }), 403, 'guest adds member');
    const listed = expectStatus(await maps(guest, ws.id, '?limit=100'), 200) as Page<Sketch>;
    assert.ok(listed.items.every((d) => d.projectId !== lobby.id), 'no map of a workspace project');
    assert.equal(listed.items.some((d) => d.id === announcement.id), false);
  });

  test('owners and admins differ in authority over members', async () => {
    const team = await workspace(owner, 'Authority');
    await addMember(owner, team.id, admin, 'admin');
    await addMember(owner, team.id, member, 'member');
    expectStatus(await admin.browser.request('POST', `/api/v1/workspaces/${team.id}/members`, { body: { email: guest.email, role: 'guest' } }), 201, 'admin adds guest');
    expectStatus(await admin.browser.request('POST', `/api/v1/workspaces/${team.id}/members`, { body: { email: other.email, role: 'owner' } }), 403, 'admin grants owner');
    expectStatus(await admin.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${owner.id}`, { body: { role: 'member' } }), 403, 'admin demotes owner');
    expectStatus(await admin.browser.request('DELETE', `/api/v1/workspaces/${team.id}/members/${owner.id}`), 403, 'admin removes owner');
    expectStatus(await admin.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${guest.id}`, { body: { role: 'member' } }), 200, 'admin promotes guest');
    expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${team.id}/members`, { body: { email: other.email, role: 'member' } }), 403, 'member adds member');
    // F-037: a member starts spaces (and is their admin); guests do not.
    expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${team.id}/projects`, { body: { name: 'Member project' } }), 201, 'member creates a space');
    expectStatus(await admin.browser.request('POST', `/api/v1/workspaces/${team.id}/projects`, { body: { name: 'Admin project', visibility: 'restricted' } }), 201, 'admin creates project');
    expectStatus(await owner.browser.request('DELETE', `/api/v1/workspaces/${team.id}/members/${owner.id}`), 409, 'last owner cannot leave');
    expectStatus(await owner.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${owner.id}`, { body: { role: 'admin' } }), 409, 'last owner cannot step down');
    expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${team.id}/members`, { body: { email: member.email, role: 'member' } }), 409, 'duplicate member');
    expectStatus(await owner.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${admin.id}`, { body: { role: 'owner' } }), 200, 'owner promotes admin to owner');
    expectStatus(await owner.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${owner.id}`, { body: { role: 'admin' } }), 200, 'second owner allows stepping down');
    const privateToMember = expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${team.id}/sketches`, { body: { title: 'Member only', scope: 'private' } }), 201) as Sketch;
    expectStatus(await readMap(admin, privateToMember.id), 404, 'owners do not see private maps either');
  });

  test('a map in a space of another company is refused', async () => {
    const second = await workspace(outsider, 'Other company');
    await addMember(outsider, second.id, owner, 'member');
    const foreign = await project(outsider, second.id, 'Foreign project', 'workspace');
    const local = await project(owner, ws.id, 'Local project', 'workspace');
    const item = await mapIn(owner, ws.id, 'Stay home', local.id);
    expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'link', scope: 'project', projectId: foreign.id } }), 422, 'create link');
    expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'link', scope: 'project', projectId: foreign.id } }), 404, 'invisible foreign project');
    const outsiderGrant = await owner.browser.request('POST', `/api/v1/projects/${local.id}/grants`, { body: { principal: { kind: 'human', id: outsider.id }, role: 'contributor' } });
    expectStatus(outsiderGrant, 422, 'grant to a non-member');
    const stored = await pool.query('SELECT workspace_id, project_id FROM sketches WHERE id = $1', [item.id]);
    assert.deepEqual(stored.rows[0], { workspace_id: ws.id, project_id: local.id }, 'rejected commands left the map unchanged');
  });

  test('removing a membership or a grant applies on the very next request', async () => {
    const team = await workspace(owner, 'Revocation');
    await addMember(owner, team.id, member, 'member');
    const room = await project(owner, team.id, 'War room', 'restricted');
    await grant(owner, room.id, member, 'contributor');
    const lobby = await project(owner, team.id, 'Lobby', 'workspace');
    const wide = await mapIn(owner, team.id, 'All hands', lobby.id);
    const narrow = await mapIn(owner, team.id, 'Incident', room.id);
    expectStatus(await readMap(member, narrow.id), 200);

    const grants = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${room.id}/grants`), 200) as ProjectGrant[];
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${room.id}/grants/${grants.find((g) => g.principal.id === member.id)!.id}`), 204);
    expectStatus(await readMap(member, narrow.id), 404, 'grant revoked');
    expectStatus(await member.browser.request('GET', `/api/v1/projects/${room.id}`), 404, 'project hidden again');

    await grant(owner, room.id, member, 'contributor');
    expectStatus(await readMap(member, wide.id), 200);
    expectStatus(await owner.browser.request('DELETE', `/api/v1/workspaces/${team.id}/members/${member.id}`), 204);
    expectStatus(await readMap(member, wide.id), 404, 'workspace project map after removal');
    expectStatus(await readMap(member, narrow.id), 404, 'restricted project map after removal');
    expectStatus(await member.browser.request('GET', `/api/v1/workspaces/${team.id}`), 404, 'workspace after removal');
    expectStatus(await maps(member, team.id), 404, 'map list after removal');
    const left = await pool.query('SELECT count(*)::int AS count FROM project_grants WHERE workspace_id = $1 AND user_id = $2', [team.id, member.id]);
    assert.equal(left.rows[0].count, 0, 'membership removal deleted its grants');
  });

  test('list counts and pages exclude rows the caller cannot see', async () => {
    const team = await workspace(owner, 'Pagination');
    await addMember(owner, team.id, member, 'member');
    const closed = await project(owner, team.id, 'Closed', 'restricted');
    const open = await project(owner, team.id, 'Open', 'workspace');
    const hidden: string[] = [];
    const shared: string[] = [];
    for (let i = 0; i < 5; i += 1) hidden.push((await mapIn(owner, team.id, `closed ${i}`, closed.id)).id);
    for (let i = 0; i < 3; i += 1) shared.push((await mapIn(owner, team.id, `open ${i}`, open.id)).id);
    const first = expectStatus(await maps(member, team.id, '?limit=2&offset=0'), 200) as Page<Sketch>;
    const second = expectStatus(await maps(member, team.id, '?limit=2&offset=2'), 200) as Page<Sketch>;
    assert.equal(first.total, 3);
    assert.equal(second.total, 3);
    assert.equal(first.items.length, 2);
    assert.equal(second.items.length, 1);
    const seen = [...first.items, ...second.items].map((d) => d.id);
    assert.deepEqual(new Set(seen), new Set(shared));
    assert.ok(seen.every((id) => !hidden.includes(id)));
    const everything = expectStatus(await maps(owner, team.id, '?limit=100'), 200) as Page<Sketch>;
    assert.equal(everything.total, 8);
    expectStatus(await maps(member, team.id, '?limit=0'), 400, 'limit bounds');
    expectStatus(await maps(member, team.id, '?limit=101'), 400, 'limit bounds');
  });

  test('a space has two roles, and nothing keeps a company admin out of one (#903)', async () => {
    const team = await workspace(owner, 'Two roles');
    await addMember(owner, team.id, admin, 'admin');
    await addMember(owner, team.id, member, 'member');
    const room = await project(owner, team.id, 'Closed floor', 'restricted');
    const item = await mapIn(owner, team.id, 'Floor plan', room.id);
    for (const role of ['viewer', 'denied']) {
      expectStatus(await owner.browser.request('POST', `/api/v1/projects/${room.id}/grants`, { body: { principal: { kind: 'human', id: member.id }, role } }), 400, role);
    }
    expectStatus(await admin.browser.request('GET', `/api/v1/projects/${room.id}`), 200, 'an admin reaches a space without a grant');
    expectStatus(await readMap(admin, item.id), 200, 'and its maps');
    await grant(owner, room.id, admin, 'contributor');
    await removeFromSpace(owner, room.id, admin);
    expectStatus(await admin.browser.request('GET', `/api/v1/projects/${room.id}`), 200, 'removing the grant takes them off its people, not out of the space');
    expectStatus(await member.browser.request('GET', `/api/v1/projects/${room.id}`), 404, 'a member who was not added sees nothing');
  });

  test('a project names exactly the people who can read it, for everyone who can read it (#117)', async () => {
    const team = await workspace(owner, 'Audience');
    await addMember(owner, team.id, admin, 'admin');
    await addMember(owner, team.id, member, 'member');
    await addMember(owner, team.id, other, 'member');
    await addMember(owner, team.id, guest, 'guest');
    const closed = await project(owner, team.id, 'Closed room', 'restricted');
    await grant(owner, closed.id, member, 'contributor');
    await grant(owner, closed.id, guest, 'contributor');
    const people = (who: Person, id = closed.id) => who.browser.request('GET', `/api/v1/projects/${id}/people`);
    const listed = expectStatus(await people(guest), 200, 'a guest with a grant reads the audience') as ProjectPerson[];
    const byId = new Map(listed.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(owner.id)?.access, 'manager');
    assert.equal(byId.get(member.id)?.access, 'contributor');
    assert.equal(byId.get(guest.id)?.access, 'contributor');
    assert.equal(byId.has(admin.id), false, 'a company admin reaches the space but is not one of its people until added');
    assert.equal(byId.has(other.id), false, 'a member without a grant cannot read a restricted project');
    assert.equal(listed.length, 3);
    assert.ok(listed.every((entry) => entry.kind === 'human' && typeof entry.name === 'string'));
    expectStatus(await people(member), 200, 'a member reads the audience');
    expectStatus(await people(other), 404, 'someone who cannot read the project learns nothing');
    expectStatus(await people(admin), 200, 'a company admin reads it too');
    expectStatus(await people(outsider), 404);
    const open = await project(owner, team.id, 'Open floor', 'workspace');
    const everyone = (expectStatus(await people(other, open.id), 200) as ProjectPerson[]).map((entry) => entry.id).sort();
    assert.deepEqual(everyone, [owner.id, admin.id, member.id, other.id].sort(), 'members read a workspace-visible project; a guest without a grant does not');
    await removeFromSpace(owner, closed.id, member);
    expectStatus(await people(member), 404, 'a removal applies on the very next request');
    assert.equal((expectStatus(await people(guest), 200) as ProjectPerson[]).some((entry) => entry.id === member.id), false);
  });
});
