import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { Draft, Page, Project, ProjectGrant, ProjectPerson, Workspace, WorkspaceMember, WorkspaceRole } from '@flux/contracts';
import { Browser, register, uniqueEmail, type ClientResponse } from './support/http.js';

// Workspace, project, grant and draft policy through the running API (issue #29, AC-2/AC-3).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

const password = 'correct horse battery staple';

interface Person {
  id: string;
  email: string;
  browser: Browser;
}

async function person(label: string): Promise<Person> {
  const email = uniqueEmail(label);
  const { browser } = await register(email, password, label);
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200);
  return { id: (me.json as { user: { id: string } }).user.id, email, browser };
}

function expect(response: ClientResponse, status: number, message?: string) {
  assert.equal(response.status, status, `${message ?? 'status'}: ${response.text}`);
  return response.json;
}

async function workspace(owner: Person, name = 'Tide'): Promise<Workspace> {
  return expect(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name } }), 201) as Workspace;
}

async function addMember(actor: Person, workspaceId: string, member: Person, role: WorkspaceRole) {
  return expect(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/members`, { body: { email: member.email, role } }), 201) as WorkspaceMember;
}

async function project(actor: Person, workspaceId: string, name: string, visibility: 'workspace' | 'restricted'): Promise<Project> {
  return expect(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/projects`, { body: { name, visibility } }), 201) as Project;
}

async function grant(actor: Person, projectId: string, grantee: Person, role: 'contributor' | 'viewer' | 'denied'): Promise<ProjectGrant> {
  return expect(await actor.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: grantee.id }, role } }), 201) as ProjectGrant;
}

async function draft(actor: Person, workspaceId: string, title: string, projectId?: string): Promise<Draft> {
  return expect(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/drafts`, { body: projectId ? { title, projectId } : { title } }), 201) as Draft;
}

/**
 * If-Match for the actor's current view of a draft. A draft the actor cannot read gets a
 * placeholder version: authorization is decided before the precondition, so the request
 * still answers 404/403 and never reveals whether the version matched.
 */
async function ifMatch(actor: Person, draftId: string) {
  const current = await actor.browser.request('GET', `/api/v1/drafts/${draftId}`);
  return { 'if-match': current.status === 200 ? current.headers.get('etag')! : '"1"' };
}

async function share(actor: Person, draftId: string, scope: 'private' | 'project' | 'workspace', projectId?: string) {
  return actor.browser.request('POST', `/api/v1/drafts/${draftId}/share`, { body: projectId ? { scope, projectId } : { scope }, headers: await ifMatch(actor, draftId) });
}

async function patch(actor: Person, draftId: string, body: Record<string, unknown>) {
  return actor.browser.request('PATCH', `/api/v1/drafts/${draftId}`, { body, headers: await ifMatch(actor, draftId) });
}

async function move(actor: Person, draftId: string, body: { projectId: string | null; visibility: string }) {
  return actor.browser.request('POST', `/api/v1/drafts/${draftId}/move`, { body, headers: await ifMatch(actor, draftId) });
}

async function drafts(actor: Person, workspaceId: string, query = '') {
  return actor.browser.request('GET', `/api/v1/workspaces/${workspaceId}/drafts${query}`);
}

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
    ws = await workspace(owner);
    await addMember(owner, ws.id, admin, 'admin');
    await addMember(owner, ws.id, member, 'member');
    await addMember(owner, ws.id, other, 'member');
    await addMember(owner, ws.id, guest, 'guest');
  });

  test('the creator owns a new workspace and non-members cannot see it', async () => {
    assert.equal(ws.role, 'owner');
    const members = expect(await owner.browser.request('GET', `/api/v1/workspaces/${ws.id}/members`), 200) as WorkspaceMember[];
    assert.deepEqual(new Set(members.map((m) => `${m.userId}:${m.role}`)), new Set([
      `${owner.id}:owner`, `${admin.id}:admin`, `${member.id}:member`, `${other.id}:member`, `${guest.id}:guest`,
    ]));
    expect(await outsider.browser.request('GET', `/api/v1/workspaces/${ws.id}`), 404, 'outsider reads workspace');
    expect(await drafts(outsider, ws.id), 404, 'outsider lists drafts');
    expect(await outsider.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects`), 404, 'outsider lists projects');
    expect(await outsider.browser.request('POST', `/api/v1/workspaces/${ws.id}/drafts`, { body: { title: 'intrusion' } }), 404, 'outsider creates draft');
    const listed = expect(await outsider.browser.request('GET', '/api/v1/workspaces'), 200) as Workspace[];
    assert.equal(listed.some((w) => w.id === ws.id), false);
    expect(await guest.browser.request('GET', `/api/v1/workspaces/${ws.id}/members`), 403, 'guest cannot list members');
    expect(await new Browser().request('GET', `/api/v1/workspaces/${ws.id}`), 401, 'anonymous');
    expect(await new Browser().request('GET', `/api/v1/drafts/${randomUUID()}`), 401, 'anonymous draft');
    expect(await owner.browser.request('GET', '/api/v1/drafts/not-a-uuid'), 404, 'malformed id');
    expect(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'x' }, origin: 'https://evil.example' }), 403, 'foreign origin');
  });

  test('a new draft is private: other members, admins and guests cannot see it', async () => {
    const secret = await draft(member, ws.id, 'Unredacted support report');
    assert.equal(secret.visibility, 'private');
    assert.deepEqual(secret.owner, { kind: 'human', id: member.id });
    expect(await member.browser.request('GET', `/api/v1/drafts/${secret.id}`), 200);
    for (const viewer of [other, admin, owner, guest, outsider]) {
      expect(await viewer.browser.request('GET', `/api/v1/drafts/${secret.id}`), 404, 'private draft read');
      expect(await patch(viewer, secret.id, { title: 'edited' }), 404, 'private draft write');
      expect(await share(viewer, secret.id, 'workspace'), 404, 'private draft share');
    }
    const listed = expect(await drafts(other, ws.id), 200) as Page<Draft>;
    assert.equal(listed.items.some((d) => d.id === secret.id), false);
  });

  test('sharing to a restricted project reveals the draft only to project grantees', async () => {
    const restricted = await project(owner, ws.id, 'Support escalations', 'restricted');
    await grant(owner, restricted.id, member, 'contributor');
    await grant(owner, restricted.id, guest, 'viewer');
    const report = await draft(member, ws.id, 'Redacted report', restricted.id);
    expect(await guest.browser.request('GET', `/api/v1/drafts/${report.id}`), 404, 'still private');
    const shared = expect(await share(member, report.id, 'project'), 200) as Draft;
    assert.equal(shared.visibility, 'project');
    assert.equal(shared.version, 2);
    expect(await guest.browser.request('GET', `/api/v1/drafts/${report.id}`), 200, 'guest grantee');
    expect(await admin.browser.request('GET', `/api/v1/drafts/${report.id}`), 200, 'admin manages every project');
    expect(await other.browser.request('GET', `/api/v1/drafts/${report.id}`), 404, 'member without grant');
    expect(await outsider.browser.request('GET', `/api/v1/drafts/${report.id}`), 404, 'outsider');
    expect(await share(member, report.id, 'workspace'), 422, 'restricted project cannot go workspace-wide');
  });

  test('a restricted project is invisible to a member without a grant in get, list and count', async () => {
    const hidden = await project(owner, ws.id, 'Hidden budget', 'restricted');
    const open = await project(owner, ws.id, 'Open roadmap', 'workspace');
    const inside = await draft(owner, ws.id, 'Budget line', hidden.id);
    expect(await share(owner, inside.id, 'project'), 200);
    expect(await other.browser.request('GET', `/api/v1/projects/${hidden.id}`), 404, 'get hidden');
    expect(await other.browser.request('GET', `/api/v1/projects/${hidden.id}/grants`), 404, 'grants of hidden');
    expect(await other.browser.request('GET', `/api/v1/projects/${open.id}`), 200, 'get open');
    const mine = expect(await other.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects?limit=100`), 200) as Page<Project>;
    const all = expect(await owner.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects?limit=100`), 200) as Page<Project>;
    assert.equal(mine.items.some((p) => p.id === hidden.id), false);
    assert.equal(mine.items.find((p) => p.id === open.id)?.access, 'contributor');
    assert.equal(all.items.find((p) => p.id === hidden.id)?.access, 'manager');
    const restrictedCount = all.items.filter((p) => p.visibility === 'restricted').length;
    assert.equal(mine.total, all.total - restrictedCount, 'count excludes restricted projects');
    assert.equal(mine.items.length, mine.total);
    const filtered = expect(await drafts(other, ws.id, `?projectId=${hidden.id}`), 200) as Page<Draft>;
    assert.equal(filtered.total, 0);
    assert.deepEqual(filtered.items, []);
  });

  test('a viewer can read but not write; a contributor can write', async () => {
    const docs = await project(owner, ws.id, 'Export docs', 'restricted');
    await grant(owner, docs.id, other, 'viewer');
    const spec = await draft(owner, ws.id, 'Export spec', docs.id);
    expect(await share(owner, spec.id, 'project'), 200);
    expect(await other.browser.request('GET', `/api/v1/drafts/${spec.id}`), 200, 'viewer reads');
    const denied = expect(await patch(other, spec.id, { body: 'viewer edit' }), 403, 'viewer writes') as { code: string };
    assert.equal(denied.code, 'FORBIDDEN');
    expect(await other.browser.request('POST', `/api/v1/workspaces/${ws.id}/drafts`, { body: { title: 'into docs', projectId: docs.id } }), 403, 'viewer adds to project');
    expect(await share(other, spec.id, 'private'), 403, 'viewer cannot re-share');
    expect(await other.browser.request('GET', `/api/v1/projects/${docs.id}/grants`), 403, 'viewer cannot manage grants');
    await grant(owner, docs.id, other, 'contributor');
    const edited = expect(await patch(other, spec.id, { body: 'contributor edit' }), 200) as Draft;
    assert.equal(edited.body, 'contributor edit');
    assert.equal(edited.version, 3);
    const grants = expect(await owner.browser.request('GET', `/api/v1/projects/${docs.id}/grants`), 200) as ProjectGrant[];
    assert.deepEqual(grants.map((g) => [g.principal.id, g.role]), [[other.id, 'contributor']], 'grant replaced, not duplicated');
  });

  test('a guest sees only explicitly granted projects and no workspace-wide drafts', async () => {
    const lobby = await project(owner, ws.id, 'Lobby', 'workspace');
    const portal = await project(owner, ws.id, 'Customer portal', 'restricted');
    await grant(owner, portal.id, guest, 'contributor');
    const announcement = await draft(owner, ws.id, 'Team announcement');
    expect(await share(owner, announcement.id, 'workspace'), 200);
    expect(await member.browser.request('GET', `/api/v1/drafts/${announcement.id}`), 200, 'member sees workspace draft');
    expect(await guest.browser.request('GET', `/api/v1/drafts/${announcement.id}`), 404, 'guest does not');
    expect(await guest.browser.request('GET', `/api/v1/projects/${lobby.id}`), 404, 'guest and workspace project');
    const projects = expect(await guest.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects`), 200) as Page<Project>;
    assert.ok(projects.items.every((p) => p.visibility === 'restricted'), 'guest lists only granted projects');
    assert.ok(projects.items.some((p) => p.id === portal.id));
    assert.equal(projects.total, projects.items.length);
    const note = await draft(guest, ws.id, 'Guest note', portal.id);
    expect(await share(guest, note.id, 'workspace'), 403, 'guest cannot share workspace-wide');
    expect(await share(guest, note.id, 'project'), 200, 'guest contributor shares into project');
    expect(await guest.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Guest project' } }), 403, 'guest creates project');
    expect(await guest.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { email: outsider.email, role: 'member' } }), 403, 'guest adds member');
    const listed = expect(await drafts(guest, ws.id, '?limit=100'), 200) as Page<Draft>;
    assert.ok(listed.items.every((d) => d.owner.id === guest.id || d.visibility === 'project'));
    assert.equal(listed.items.some((d) => d.id === announcement.id), false);
  });

  test('owners and admins differ in authority over members', async () => {
    const team = await workspace(owner, 'Authority');
    await addMember(owner, team.id, admin, 'admin');
    await addMember(owner, team.id, member, 'member');
    expect(await admin.browser.request('POST', `/api/v1/workspaces/${team.id}/members`, { body: { email: guest.email, role: 'guest' } }), 201, 'admin adds guest');
    expect(await admin.browser.request('POST', `/api/v1/workspaces/${team.id}/members`, { body: { email: other.email, role: 'owner' } }), 403, 'admin grants owner');
    expect(await admin.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${owner.id}`, { body: { role: 'member' } }), 403, 'admin demotes owner');
    expect(await admin.browser.request('DELETE', `/api/v1/workspaces/${team.id}/members/${owner.id}`), 403, 'admin removes owner');
    expect(await admin.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${guest.id}`, { body: { role: 'member' } }), 200, 'admin promotes guest');
    expect(await member.browser.request('POST', `/api/v1/workspaces/${team.id}/members`, { body: { email: other.email, role: 'member' } }), 403, 'member adds member');
    expect(await member.browser.request('POST', `/api/v1/workspaces/${team.id}/projects`, { body: { name: 'Member project' } }), 403, 'member creates project');
    expect(await admin.browser.request('POST', `/api/v1/workspaces/${team.id}/projects`, { body: { name: 'Admin project', visibility: 'restricted' } }), 201, 'admin creates project');
    expect(await owner.browser.request('DELETE', `/api/v1/workspaces/${team.id}/members/${owner.id}`), 409, 'last owner cannot leave');
    expect(await owner.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${owner.id}`, { body: { role: 'admin' } }), 409, 'last owner cannot step down');
    expect(await owner.browser.request('POST', `/api/v1/workspaces/${team.id}/members`, { body: { email: member.email, role: 'member' } }), 409, 'duplicate member');
    expect(await owner.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${admin.id}`, { body: { role: 'owner' } }), 200, 'owner promotes admin to owner');
    expect(await owner.browser.request('PATCH', `/api/v1/workspaces/${team.id}/members/${owner.id}`, { body: { role: 'admin' } }), 200, 'second owner allows stepping down');
    const privateToMember = await draft(member, team.id, 'Member only');
    expect(await admin.browser.request('GET', `/api/v1/drafts/${privateToMember.id}`), 404, 'owners do not see private drafts either');
  });

  test('cross-workspace share, move and link are rejected', async () => {
    const second = await workspace(outsider, 'Other company');
    await addMember(outsider, second.id, owner, 'member');
    const foreign = await project(outsider, second.id, 'Foreign project', 'workspace');
    const local = await project(owner, ws.id, 'Local project', 'workspace');
    const item = await draft(owner, ws.id, 'Stay home', local.id);
    const crossMove = expect(await move(owner, item.id, { projectId: foreign.id, visibility: 'project' }), 422, 'move') as { code: string };
    assert.equal(crossMove.code, 'CROSS_WORKSPACE');
    expect(await share(owner, item.id, 'project', foreign.id), 422, 'share');
    expect(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/drafts`, { body: { title: 'link', projectId: foreign.id } }), 422, 'create link');
    expect(await member.browser.request('POST', `/api/v1/workspaces/${ws.id}/drafts`, { body: { title: 'link', projectId: foreign.id } }), 404, 'invisible foreign project');
    const outsiderGrant = await owner.browser.request('POST', `/api/v1/projects/${local.id}/grants`, { body: { principal: { kind: 'human', id: outsider.id }, role: 'viewer' } });
    expect(outsiderGrant, 422, 'grant to a non-member');
    const stored = await pool.query('SELECT workspace_id, project_id FROM drafts WHERE id = $1', [item.id]);
    assert.deepEqual(stored.rows[0], { workspace_id: ws.id, project_id: local.id }, 'rejected commands left the draft unchanged');
    const moved = expect(await move(owner, item.id, { projectId: null, visibility: 'workspace' }), 200) as Draft;
    assert.equal(moved.projectId, null);
    assert.equal(moved.visibility, 'workspace');
    expect(await move(owner, item.id, { projectId: null, visibility: 'project' }), 400, 'project visibility needs a project');
  });

  test('removing a membership or a grant applies on the very next request', async () => {
    const team = await workspace(owner, 'Revocation');
    await addMember(owner, team.id, member, 'member');
    const room = await project(owner, team.id, 'War room', 'restricted');
    await grant(owner, room.id, member, 'viewer');
    const wide = await draft(owner, team.id, 'All hands');
    expect(await share(owner, wide.id, 'workspace'), 200);
    const narrow = await draft(owner, team.id, 'Incident', room.id);
    expect(await share(owner, narrow.id, 'project'), 200);
    expect(await member.browser.request('GET', `/api/v1/drafts/${narrow.id}`), 200);

    const grants = expect(await owner.browser.request('GET', `/api/v1/projects/${room.id}/grants`), 200) as ProjectGrant[];
    expect(await owner.browser.request('DELETE', `/api/v1/projects/${room.id}/grants/${grants[0]!.id}`), 204);
    expect(await member.browser.request('GET', `/api/v1/drafts/${narrow.id}`), 404, 'grant revoked');
    expect(await member.browser.request('GET', `/api/v1/projects/${room.id}`), 404, 'project hidden again');

    await grant(owner, room.id, member, 'viewer');
    expect(await member.browser.request('GET', `/api/v1/drafts/${wide.id}`), 200);
    expect(await owner.browser.request('DELETE', `/api/v1/workspaces/${team.id}/members/${member.id}`), 204);
    expect(await member.browser.request('GET', `/api/v1/drafts/${wide.id}`), 404, 'workspace draft after removal');
    expect(await member.browser.request('GET', `/api/v1/drafts/${narrow.id}`), 404, 'project draft after removal');
    expect(await member.browser.request('GET', `/api/v1/workspaces/${team.id}`), 404, 'workspace after removal');
    expect(await drafts(member, team.id), 404, 'draft list after removal');
    const left = await pool.query('SELECT count(*)::int AS count FROM project_grants WHERE workspace_id = $1 AND user_id = $2', [team.id, member.id]);
    assert.equal(left.rows[0].count, 0, 'membership removal deleted its grants');
  });

  test('list counts and pages exclude rows the caller cannot see', async () => {
    const team = await workspace(owner, 'Pagination');
    await addMember(owner, team.id, member, 'member');
    const hidden: string[] = [];
    const shared: string[] = [];
    for (let i = 0; i < 5; i += 1) hidden.push((await draft(owner, team.id, `private ${i}`)).id);
    for (let i = 0; i < 3; i += 1) {
      const item = await draft(owner, team.id, `shared ${i}`);
      expect(await share(owner, item.id, 'workspace'), 200);
      shared.push(item.id);
    }
    const first = expect(await drafts(member, team.id, '?limit=2&offset=0'), 200) as Page<Draft>;
    const second = expect(await drafts(member, team.id, '?limit=2&offset=2'), 200) as Page<Draft>;
    assert.equal(first.total, 3);
    assert.equal(second.total, 3);
    assert.equal(first.items.length, 2);
    assert.equal(second.items.length, 1);
    const seen = [...first.items, ...second.items].map((d) => d.id);
    assert.deepEqual(new Set(seen), new Set(shared));
    assert.ok(seen.every((id) => !hidden.includes(id)));
    const everything = expect(await drafts(owner, team.id, '?limit=100'), 200) as Page<Draft>;
    assert.equal(everything.total, 8);
    expect(await drafts(member, team.id, '?limit=0'), 400, 'limit bounds');
    expect(await drafts(member, team.id, '?limit=101'), 400, 'limit bounds');
  });

  test('an explicit deny wins over membership and admin roles', async () => {
    const team = await workspace(owner, 'Deny');
    await addMember(owner, team.id, admin, 'admin');
    await addMember(owner, team.id, member, 'member');
    const open = await project(owner, team.id, 'Open floor', 'workspace');
    const item = await draft(owner, team.id, 'Floor plan', open.id);
    expect(await share(owner, item.id, 'project'), 200);
    expect(await member.browser.request('GET', `/api/v1/drafts/${item.id}`), 200);
    await grant(owner, open.id, member, 'denied');
    await grant(owner, open.id, admin, 'denied');
    for (const denied of [member, admin]) {
      expect(await denied.browser.request('GET', `/api/v1/projects/${open.id}`), 404, 'denied project');
      expect(await denied.browser.request('GET', `/api/v1/drafts/${item.id}`), 404, 'denied draft');
      expect(await denied.browser.request('GET', `/api/v1/projects/${open.id}/grants`), 404, 'denied admin cannot lift own deny');
    }
    const workspaceWide = await draft(owner, team.id, 'Workspace note', open.id);
    expect(await share(owner, workspaceWide.id, 'workspace'), 200);
    expect(await member.browser.request('GET', `/api/v1/drafts/${workspaceWide.id}`), 404, 'deny also hides workspace-visible drafts of that project');
    const listed = expect(await drafts(member, team.id, '?limit=100'), 200) as Page<Draft>;
    assert.equal(listed.total, 0);
  });

  test('a project names exactly the people who can read it, for everyone who can read it (#117)', async () => {
    const team = await workspace(owner, 'Audience');
    await addMember(owner, team.id, admin, 'admin');
    await addMember(owner, team.id, member, 'member');
    await addMember(owner, team.id, other, 'member');
    await addMember(owner, team.id, guest, 'guest');
    const closed = await project(owner, team.id, 'Closed room', 'restricted');
    await grant(owner, closed.id, member, 'viewer');
    await grant(owner, closed.id, guest, 'contributor');
    await grant(owner, closed.id, admin, 'denied');
    const people = (who: Person, id = closed.id) => who.browser.request('GET', `/api/v1/projects/${id}/people`);
    const listed = expect(await people(guest), 200, 'a guest with a grant reads the audience') as ProjectPerson[];
    const byId = new Map(listed.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(owner.id)?.access, 'manager');
    assert.equal(byId.get(member.id)?.access, 'viewer');
    assert.equal(byId.get(guest.id)?.access, 'contributor');
    assert.equal(byId.has(admin.id), false, 'a denied admin is not in the audience');
    assert.equal(byId.has(other.id), false, 'a member without a grant cannot read a restricted project');
    assert.equal(listed.length, 3);
    assert.ok(listed.every((entry) => entry.kind === 'human' && typeof entry.name === 'string'));
    expect(await people(member), 200, 'a viewer reads the audience');
    expect(await people(other), 404, 'someone who cannot read the project learns nothing');
    expect(await people(admin), 404, 'deny wins for the audience too');
    expect(await people(outsider), 404);
    const open = await project(owner, team.id, 'Open floor', 'workspace');
    const everyone = (expect(await people(other, open.id), 200) as ProjectPerson[]).map((entry) => entry.id).sort();
    assert.deepEqual(everyone, [owner.id, admin.id, member.id, other.id].sort(), 'members read a workspace-visible project; a guest without a grant does not');
    await grant(owner, open.id, other, 'denied');
    expect(await people(other, open.id), 404, 'a new deny applies on the very next request');
    assert.equal((expect(await people(member, open.id), 200) as ProjectPerson[]).some((entry) => entry.id === other.id), false);
  });
});
