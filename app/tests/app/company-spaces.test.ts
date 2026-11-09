import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { ENCRYPTED_WORKSPACES_PATH, IDENTITY_CAPABILITIES_PATH, type IdentityCapabilities, type Project, type RemovedPerson, type Workspace } from '@flux/contracts';
import { buildNotificationEmail, COMPANY_NAME, EVERYONE_SPACE_NAME, getProject, joinCompany, listProjects, type Principal } from '@flux/core';
import { accessPorts } from '@flux/db';
import Fastify from 'fastify';
import { workspaceRoutes } from '../../apps/server/src/access/workspaces.js';
import { createAuth } from '../../apps/server/src/identity/auth.js';
import { loadIdentityConfig } from '../../apps/server/src/identity/index.js';
import { createOauthRequests } from '../../apps/server/src/identity/oauth-flow.js';
import type { AccessContext } from '../../apps/server/src/access/context.js';
import { db, insertedHuman, pool } from './support/db.js';
import { Browser } from './support/http.js';
import { expectStatus, person, type Person } from './support/people.js';

// F-037 (#874): one Flux is one company. The first account sets it up, as its owner, with the Everyone space; with single
// sign-on every later account joins it on its first sign-in, and without single sign-on only an invite link (or an admin
// adding an existing account) brings someone in. A person sees only the spaces they were added to, and Everyone holds the
// whole company.

const raw = (response: { json: unknown }) => (response.json as { code?: string }).code;
const company = async () => (await pool.query<{ id: string; name: string }>('SELECT id, name FROM workspaces WHERE company')).rows;
const roleIn = async (workspaceId: string, userId: string) =>
  (await pool.query<{ role: string }>('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId])).rows[0]?.role ?? null;

describe('the one company and its Everyone space', () => {
  let companyId: string;

  before(async () => {
    // A sign-up on this server: the first one ever made the company.
    await person('Company Ada');
    const rows = await company();
    assert.equal(rows.length, 1, 'exactly one company');
    companyId = rows[0]!.id;
  });

  test('setup made exactly one company, with an owner and one Everyone space whose creator is its admin', async () => {
    const owners = (await pool.query<{ user_id: string }>("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [companyId])).rows;
    assert.ok(owners.length >= 1, 'the company has an owner');
    const everyone = (await pool.query<{ id: string; name: string; created_by: string }>(
      "SELECT id, name, created_by FROM projects WHERE workspace_id = $1 AND visibility = 'workspace'", [companyId])).rows;
    assert.deepEqual(everyone.map((row) => row.name), [EVERYONE_SPACE_NAME]);
    const grant = (await pool.query<{ role: string }>('SELECT role FROM project_grants WHERE project_id = $1 AND user_id = $2', [everyone[0]!.id, everyone[0]!.created_by])).rows;
    assert.deepEqual(grant.map((row) => row.role), ['manager'], 'the person who set the company up is the first admin of Everyone');
  });

  test('a later password sign-up joins no company by itself, and setting up again makes no second company', async () => {
    const late = await person('Company Late');
    if (await roleIn(companyId, late.id) === null) {
      // Without single sign-on nobody joins by signing up: a link from an admin brings them in.
      assert.equal(await joinCompany(late.id, { sso: false }, db, accessPorts), null);
      assert.equal(await roleIn(companyId, late.id), null);
      const listed = expectStatus(await late.browser.request('GET', '/api/v1/workspaces'), 200) as Workspace[];
      assert.equal(listed.some((item) => item.company), false);
    }
    assert.equal((await company()).length, 1);
  });

  test('with single sign-on a new account joins the company as a member, once, and sees Everyone and nothing else', async () => {
    const [sso, other] = [await insertedHuman('company-sso'), await insertedHuman('company-sso-2')];
    // Two sign-ins at the same moment, after setup: both join the one company, no second company appears.
    const joined = await Promise.all([joinCompany(sso.id, { sso: true }, db, accessPorts), joinCompany(other.id, { sso: true }, db, accessPorts)]);
    assert.deepEqual(joined, ['joined', 'joined']);
    assert.equal((await company()).length, 1);
    assert.equal(await roleIn(companyId, sso.id), 'member');
    assert.equal(await joinCompany(sso.id, { sso: true }, db, accessPorts), null, 'a repeated call changes nothing');
    const spaces = await listProjects(sso, companyId, {}, db, accessPorts);
    const everyone = spaces.items.find((item) => item.visibility === 'workspace');
    assert.equal(everyone?.name, EVERYONE_SPACE_NAME);
    assert.equal(everyone?.access, 'contributor', 'every member is in Everyone');
    assert.ok(spaces.items.every((item) => item.visibility === 'workspace'), 'a new member sees only Everyone');
  });
});

// Setup itself under a race: the company this server already has steps aside for one test, and comes back after it.
describe('two first sign-ups on a new server', () => {
  test('make one company with one owner and one Everyone space', async () => {
    const [existing] = await company();
    const people = await Promise.all(Array.from({ length: 6 }, (_, index) => insertedHuman(`company-race-${index}`)));
    await pool.query('UPDATE workspaces SET company = false WHERE id = $1', [existing!.id]);
    try {
      const results = await Promise.all(people.map((one) => joinCompany(one.id, { sso: true }, db, accessPorts)));
      assert.deepEqual(results.filter((result) => result === 'created').length, 1, 'one of them set it up');
      assert.deepEqual(results.filter((result) => result === 'joined').length, 5, 'the others joined it');
      const [made, ...more] = await company();
      assert.deepEqual(more, [], 'one company');
      const owners = await pool.query("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [made!.id]);
      assert.equal(owners.rowCount, 1, 'one owner');
      const everyone = await pool.query("SELECT id FROM projects WHERE workspace_id = $1 AND visibility = 'workspace'", [made!.id]);
      assert.equal(everyone.rowCount, 1, 'one Everyone');
    } finally {
      await pool.query('DELETE FROM workspaces WHERE company');
      await pool.query('UPDATE workspaces SET company = true WHERE id = $1', [existing!.id]);
    }
  });
});

describe('nobody creates a workspace on a real server', () => {
  test('POST /api/v1/workspaces exists only on a test deployment, and renaming the company exists on both', async () => {
    const routes = async (testDeployment: boolean) => {
      const app = Fastify();
      workspaceRoutes(app, { workspaceScope: () => ({ type: 'workspace', id: '' }) } as unknown as AccessContext, { testDeployment });
      await app.ready();
      const found = { create: app.hasRoute({ method: 'POST', url: '/api/v1/workspaces' }), rename: app.hasRoute({ method: 'PATCH', url: '/api/v1/workspaces/:workspaceId' }) };
      await app.close();
      return found;
    };
    assert.deepEqual(await routes(false), { create: false, rename: true });
    assert.deepEqual(await routes(true), { create: true, rename: true });
  });
});

describe('spaces show only to the people added to them', () => {
  let owner: Person;
  let member: Person;
  let guest: Person;
  let ws: Workspace;

  before(async () => {
    [owner, member, guest] = await Promise.all(['Spaces Owner', 'Spaces Member', 'Spaces Guest'].map(person));
    ws = expectStatus(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Spaces co' } }), 201) as Workspace;
    for (const [who, role] of [[member, 'member'], [guest, 'guest']] as const) {
      expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { email: who.email, role } }), 201);
    }
  });

  const asPrincipal = (who: Person): Principal => ({ kind: 'human', id: who.id });

  test('a member starts a space and is its admin; others see it only once added, as a member or an admin', async () => {
    const space = expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Payroll' } }), 201) as Project;
    assert.deepEqual([space.visibility, space.access], ['restricted', 'manager']);
    // The company's owners and admins can change every space.
    assert.equal((await getProject(asPrincipal(owner), space.id, db, accessPorts)).access, 'manager');
    // The guest was not added: no space, not even its name.
    await assert.rejects(getProject(asPrincipal(guest), space.id, db, accessPorts), (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND');
    expectStatus(await member.browser.request('POST', `/api/v1/projects/${space.id}/grants`, { body: { principal: { kind: 'human', id: guest.id }, role: 'contributor' } }), 201);
    assert.equal((await getProject(asPrincipal(guest), space.id, db, accessPorts)).access, 'contributor');
    // An agent is never a space admin.
    const bot = expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Helper', owner: 'self' } }), 201) as { id: string };
    expectStatus(await member.browser.request('POST', `/api/v1/projects/${space.id}/grants`, { body: { principal: { kind: 'agent', id: bot.id }, role: 'manager' } }), 400);
  });

  test('guests start no spaces, and only owners and admins rename the company', async () => {
    expectStatus(await guest.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Guest space' } }), 403);
    expectStatus(await member.browser.request('PATCH', `/api/v1/workspaces/${ws.id}`, { body: { name: 'Renamed by a member' } }), 403);
    const renamed = expectStatus(await owner.browser.request('PATCH', `/api/v1/workspaces/${ws.id}`, { body: { name: 'Spaces company' } }), 200) as Workspace;
    assert.deepEqual([renamed.name, renamed.version], ['Spaces company', ws.version + 1]);
  });
});

// The company's real rules (F-037): these run in the one company, where a real server's people are.
describe('in the company', () => {
  let companyId: string;
  let admin: Person;
  let member: Person;
  let colleague: Person;
  let guest: Person;
  let everyoneId: string;

  const join = async (who: Person, role: 'admin' | 'member' | 'guest') => {
    await joinCompany(who.id, { sso: true }, db, accessPorts);
    await pool.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [companyId, who.id, role]);
  };

  before(async () => {
    companyId = (await company())[0]!.id;
    [admin, member, colleague, guest] = await Promise.all(['Company Admin', 'Company Member', 'Company Colleague', 'Company Guest'].map(person));
    await join(admin, 'admin'); await join(member, 'member'); await join(colleague, 'member'); await join(guest, 'guest');
    everyoneId = (await pool.query<{ id: string }>("SELECT id FROM projects WHERE workspace_id = $1 AND visibility = 'workspace'", [companyId])).rows[0]!.id;
  });

  const newSpace = async (who: Person, name: string) =>
    expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${companyId}/projects`, { body: { name } }), 201) as Project;
  const setGrant = (who: Person, spaceId: string, target: Person, role: string) =>
    who.browser.request('POST', `/api/v1/projects/${spaceId}/grants`, { body: { principal: { kind: 'human', id: target.id }, role } });

  test('any member of the company who is not a guest makes an encrypted space; an account nobody invited and a guest are refused (C-24)', async () => {
    const stranger = await person('Encrypted Stranger');
    const create = (who: Person) => who.browser.request('POST', ENCRYPTED_WORKSPACES_PATH,
      { body: { name: 'Shadow company', creationId: randomUUID(), password: 'a long enough unlock password here', companyId } });
    for (const who of [stranger, guest]) {
      const refused = await create(who);
      assert.equal(refused.status, 403, who.email);
      assert.equal(raw(refused), 'ENCRYPTED_SPACE_COMPANY_ONLY');
    }
    assert.equal((await pool.query("SELECT 1 FROM workspaces WHERE name = 'Shadow company'")).rowCount, 0);
    const made = expectStatus(await create(member), 201) as { workspace: { id: string }; project: { id: string } | null };
    assert.ok(made.workspace.id && made.project, 'a plain member made it, with its one space');
  });

  test('nothing keeps a company admin out of a space: a space admin who is a plain member can add one and remove one, and they still open it (#903)', async () => {
    const space = await newSpace(member, 'Kept private');
    expectStatus(await admin.browser.request('GET', `/api/v1/projects/${space.id}`), 200, 'the company admin opens it without being added');
    const added = expectStatus(await setGrant(member, space.id, admin, 'contributor'), 201, 'adding them to the space stays open') as { id: string };
    expectStatus(await member.browser.request('DELETE', `/api/v1/projects/${space.id}/grants/${added.id}`), 204, 'so does removing them from its people');
    expectStatus(await admin.browser.request('GET', `/api/v1/projects/${space.id}`), 200, 'the company admin still opens it');
  });

  test('Everyone is the only space that holds the whole company', async () => {
    const second = await member.browser.request('POST', `/api/v1/workspaces/${companyId}/projects`, { body: { name: 'Second everyone', visibility: 'workspace' } });
    assert.equal(second.status, 422, second.text);
    assert.equal(raw(second), 'SPACE_NOT_FOR_EVERYONE');
    expectStatus(await member.browser.request('GET', `/api/v1/projects/${everyoneId}`), 200);
  });

  test('a guest is no space admin, and someone who becomes a guest stops being one', async () => {
    const space = await newSpace(colleague, 'Guest rules');
    const refused = await setGrant(colleague, space.id, guest, 'manager');
    assert.equal(refused.status, 422, refused.text);
    assert.equal(raw(refused), 'GUEST_NOT_SPACE_ADMIN');
    expectStatus(await admin.browser.request('PATCH', `/api/v1/workspaces/${companyId}/members/${colleague.id}`, { body: { role: 'guest' }, headers: { 'idempotency-key': randomUUID() } }), 200);
    const held = (await pool.query<{ role: string }>('SELECT role FROM project_grants WHERE project_id = $1 AND user_id = $2', [space.id, colleague.id])).rows;
    assert.deepEqual(held.map((row) => row.role), ['contributor']);
    expectStatus(await admin.browser.request('PATCH', `/api/v1/workspaces/${companyId}/members/${colleague.id}`, { body: { role: 'member' }, headers: { 'idempotency-key': randomUUID() } }), 200);
  });

  test('a company admin reaches every space but belongs only to the ones they were added to', async () => {
    const space = await newSpace(member, 'Not the admin’s');
    const listed = await listProjects({ kind: 'human', id: admin.id }, companyId, { limit: 100 }, db, accessPorts);
    const seen = new Map(listed.items.map((item) => [item.id, item.member]));
    assert.equal(seen.get(space.id), false, 'it can be reached, and it is not theirs');
    assert.equal(seen.get(everyoneId), true, 'every member is in Everyone');
    expectStatus(await setGrant(admin, space.id, admin, 'contributor'), 201, 'they add themselves');
    const again = await listProjects({ kind: 'human', id: admin.id }, companyId, { limit: 100 }, db, accessPorts);
    assert.equal(again.items.find((item) => item.id === space.id)?.member, true);
    const theirs = await listProjects({ kind: 'human', id: member.id }, companyId, { limit: 100 }, db, accessPorts);
    assert.ok(theirs.items.every((item) => item.member === true), 'for everyone else, what they see is what they belong to');
  });

  test('someone removed stays out on a provider sign-in until an admin restores them: back in Everyone, and other spaces by hand', async () => {
    const space = await newSpace(admin, 'Before leaving');
    const leaver = await person('Company Leaver');
    await join(leaver, 'member');
    expectStatus(await setGrant(admin, space.id, leaver, 'contributor'), 201);
    expectStatus(await admin.browser.request('DELETE', `/api/v1/workspaces/${companyId}/members/${leaver.id}`), 204);

    const listed = expectStatus(await admin.browser.request('GET', `/api/v1/workspaces/${companyId}/removed-people`), 200) as RemovedPerson[];
    assert.deepEqual(listed.filter((entry) => entry.userId === leaver.id).map((entry) => entry.email), [leaver.email]);
    expectStatus(await member.browser.request('GET', `/api/v1/workspaces/${companyId}/removed-people`), 403, 'not for a member');
    assert.equal(await joinCompany(leaver.id, { sso: true }, db, accessPorts), null, 'signing in with the provider does not bring them back');
    assert.equal(await roleIn(companyId, leaver.id), null);

    expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${companyId}/removed-people/${leaver.id}/restore`), 403, 'only an admin restores');
    expectStatus(await admin.browser.request('POST', `/api/v1/workspaces/${companyId}/removed-people/${leaver.id}/restore`), 201);
    assert.equal(await roleIn(companyId, leaver.id), 'member');
    expectStatus(await leaver.browser.request('GET', `/api/v1/projects/${everyoneId}`), 200, 'in Everyone again');
    expectStatus(await leaver.browser.request('GET', `/api/v1/projects/${space.id}`), 404, 'other spaces come back by hand');
    const after = expectStatus(await admin.browser.request('GET', `/api/v1/workspaces/${companyId}/removed-people`), 200) as RemovedPerson[];
    assert.equal(after.some((entry) => entry.userId === leaver.id), false, 'off the list');
    expectStatus(await admin.browser.request('POST', `/api/v1/workspaces/${companyId}/removed-people/${leaver.id}/restore`), 404, 'nobody to restore');
  });

  test('with verified sign-up the company is set up when the address is verified, so a mistyped address leaves no owner nobody can be', async () => {
    const sent: { text: string }[] = [];
    const config = loadIdentityConfig({ ...process.env, FLUX_SIGNUP: 'verified', FLUX_SMTP_URL: 'smtp://mail.example.test:25', FLUX_MAIL_FROM: 'flux@example.test' });
    const auth = createAuth({ db, config, mailer: { send: async (mail) => { sent.push(mail); }, close: () => undefined }, oauthRequests: createOauthRequests() });
    const [existing] = await company();
    const email = `company-verified-${randomUUID()}@example.test`;
    await pool.query('UPDATE workspaces SET company = false WHERE id = $1', [existing!.id]);
    try {
      await auth.api.signUpEmail({ body: { name: 'Verified First', email, password: 'a long enough password for this' } });
      assert.deepEqual(await company(), [], 'an address nobody proved sets up nothing');
      const token = /token=([^&\s]+)/.exec(sent.at(-1)!.text)?.[1];
      assert.ok(token, sent.at(-1)!.text);
      await auth.api.verifyEmail({ query: { token: decodeURIComponent(token) } });
      const made = await company();
      assert.equal(made.length, 1, 'the first verified account set it up');
      const owner = (await pool.query<{ email: string }>(`SELECT u.email FROM workspace_members m JOIN auth_users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND m.role = 'owner'`, [made[0]!.id])).rows;
      assert.deepEqual(owner.map((row) => row.email), [email]);
    } finally {
      await pool.query('DELETE FROM workspaces WHERE company');
      await pool.query('UPDATE workspaces SET company = true WHERE id = $1', [existing!.id]);
      await pool.query('DELETE FROM auth_users WHERE email = $1', [email]);
    }
  });

  test('a password account joins on its first provider sign-in, however it came to exist', async () => {
    const linked = await person('Company Linked');
    assert.equal(await roleIn(companyId, linked.id), null);
    assert.equal(await joinCompany(linked.id, { sso: true }, db, accessPorts), 'joined');
    assert.equal(await roleIn(companyId, linked.id), 'member');
  });

  test('the sign-in page and email carry the company’s name once it has one', async () => {
    const read = async () => (expectStatus(await new Browser().request('GET', IDENTITY_CAPABILITIES_PATH), 200) as IdentityCapabilities).company;
    const before = (await company())[0]!.name;
    try {
      await pool.query('UPDATE workspaces SET name = $2 WHERE id = $1', [companyId, COMPANY_NAME]);
      assert.equal(await read(), null, 'the name setup gave it says nothing');
      await pool.query('UPDATE workspaces SET name = $2 WHERE id = $1', [companyId, 'Riverside Makers']);
      assert.equal(await read(), 'Riverside Makers');
    } finally { await pool.query('UPDATE workspaces SET name = $2 WHERE id = $1', [companyId, before]); }
    const mail = { origin: 'https://flux.example.org', to: 'a@example.org', emailId: 'e1', notificationId: 'n1', token: 't' };
    assert.match(buildNotificationEmail({ ...mail, company: 'Riverside Makers' }).text, /in Flux at Riverside Makers\./);
    assert.match(buildNotificationEmail(mail).text, /new for you in Flux\./);
  });
});
