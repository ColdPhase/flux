import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { ENCRYPTED_SPACES_AVAILABILITY_PATH, ENCRYPTED_WORKSPACES_PATH, companyEncryptedSpacesPath, encryptedSpacePath,
  type CreateEncryptedWorkspaceResult, type EncryptedSpaceRef, type Page, type Project, type Workspace } from '@flux/contracts';
import { db, pool } from './support/db.js';
import { joinCompany } from '@flux/core';
import { accessPorts } from '@flux/db';
import { Browser, type ClientResponse } from './support/http.js';
import { expectStatus, person, type Person } from './support/people.js';
import { codeOf, unlock } from './support/encryption.js';

// F-037, F-030 (#874, #848, C-24): an encrypted space is an encrypted workspace that belongs to the company and holds exactly one space.
// Any member of the company who is not a guest makes one; only its admins and the recovery code hold the keys; the company's owners and
// admins can see that it exists and delete it, never open it; leaving the company ends a person's place in it.

const PASSWORD = 'a long enough unlock password here';
// A recovery code the browser made: 32 characters of the alphabet, not a pattern.
const CODE = 'K7QD-2M9X-V4HB-T8WN-C3ZE-5GJR-0PFA-Y61S';
const makeCode = () => CODE.split('-').map((group) => [...group].sort(() => Math.random() - 0.5).join('')).join('-');

describe('an encrypted space of the company', () => {
  let companyId: string;
  let admin: Person;
  let ada: Person;
  let ben: Person;
  let cy: Person;
  let guest: Person;
  let stranger: Person;

  const join = async (who: Person, role: 'admin' | 'member' | 'guest') => {
    await joinCompany(who.id, { sso: true }, db, accessPorts);
    await pool.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [companyId, who.id, role]);
  };
  const create = async (who: Person, body: Record<string, unknown>) => {
    // The creation limit (five in 15 minutes) has its own test in the F-030 file.
    await pool.query('DELETE FROM encrypted_workspace_creations WHERE user_id = $1', [who.id]);
    return who.browser.request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { creationId: randomUUID(), password: PASSWORD, companyId, ...body } });
  };
  const made = (response: ClientResponse) => expectStatus(response, 201) as CreateEncryptedWorkspaceResult;
  const spaces = async (who: Person) => (expectStatus(await who.browser.request('GET', '/api/v1/workspaces'), 200) as Workspace[]).filter((item) => item.spaceOf);
  const roleIn = async (workspaceId: string, userId: string) =>
    (await pool.query<{ role: string }>('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId])).rows[0]?.role ?? null;

  before(async () => {
    await person('Encrypted Spaces First');
    companyId = (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows[0]!.id;
    [admin, ada, ben, cy, guest, stranger] = await Promise.all(['Spaces Admin', 'Spaces Ada', 'Spaces Ben', 'Spaces Cy', 'Spaces Guest', 'Spaces Stranger'].map(person));
    await join(admin, 'admin'); await join(ada, 'member'); await join(ben, 'member'); await join(cy, 'member'); await join(guest, 'guest');
  });

  test('a plain member makes one: the workspace is a space of the company, with one space named for it, no AI, the creator its admin and the chosen people members', async () => {
    const code = makeCode();
    const result = made(await create(ada, { name: 'Payroll', people: [ben.id], recoveryCode: code }));
    assert.equal(result.recoveryCode, null, 'the code the browser made does not come back');
    assert.equal(result.workspace.spaceOf, companyId);
    assert.equal(result.workspace.encryption?.state, 'unlocked');
    assert.equal(result.workspace.name, 'Payroll');
    assert.ok(result.project, 'the space is made with it');
    assert.equal(result.project.name, 'Payroll');
    assert.equal(result.project.workspaceId, result.workspace.id);
    assert.equal(result.project.ai, 'blocked', 'an encrypted space never has AI');
    assert.deepEqual([await roleIn(result.workspace.id, ada.id), await roleIn(result.workspace.id, ben.id), await roleIn(result.workspace.id, cy.id)], ['owner', 'member', null]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1', [result.workspace.id])).rows[0].n, 1);
    // The recovery code the browser made is the recovery holder's secret: it unlocks after a lock, and nothing stores it.
    expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${result.workspace.id}/lock`), 200);
    assert.equal((await unlock(cy.browser, result.workspace.id, { recoveryCode: code })).status, 404, 'a person outside it cannot even try');
    expectStatus(await unlock(ada.browser, result.workspace.id, { recoveryCode: code }), 200);
    expectStatus(await unlock(ada.browser, result.workspace.id, { password: PASSWORD }), 200);
    const rows = JSON.stringify((await pool.query('SELECT (SELECT json_agg(h) FROM workspace_holders h WHERE workspace_id = $1) AS holders', [result.workspace.id])).rows);
    assert.equal(rows.includes(code.replace(/-/g, '')) || rows.includes(code), false);
  });

  test('a retried creation ends with one space and still returns it; the same id for another name is refused', async () => {
    const creationId = randomUUID();
    const first = made(await create(ada, { name: 'Retried', creationId }));
    assert.ok(first.recoveryCode, 'without a code of its own, the server makes one and shows it once');
    const again = expectStatus(await create(ada, { name: 'Retried', creationId }), 200) as CreateEncryptedWorkspaceResult;
    assert.equal(again.recoveryCode, null);
    assert.equal(again.workspace.id, first.workspace.id);
    assert.equal(again.project?.id, first.project?.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1', [first.workspace.id])).rows[0].n, 1);
    assert.equal(codeOf(await create(ada, { name: 'Another', creationId })), 'IDEMPOTENCY_CONFLICT');
  });

  test('who may make one: a guest, a stranger and a missing company are refused, and nothing is left behind', async () => {
    const before = Number((await pool.query("SELECT count(*)::int AS n FROM workspaces WHERE encrypted AND name LIKE 'Refused %'")).rows[0].n);
    for (const who of [guest, stranger]) {
      const refused = await create(who, { name: 'Refused guest' });
      assert.equal(refused.status, 403, who.email);
      assert.equal(codeOf(refused), 'ENCRYPTED_SPACE_COMPANY_ONLY');
    }
    const noCompany = await ada.browser.request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { name: 'Refused none', creationId: randomUUID(), password: PASSWORD } });
    assert.equal(noCompany.status, 400);
    assert.equal(codeOf(noCompany), 'ENCRYPTED_SPACE_COMPANY_ONLY');
    const outsider = await create(ada, { name: 'Refused people', people: [stranger.id] });
    assert.equal(outsider.status, 409);
    assert.equal(codeOf(outsider), 'NOT_A_MEMBER');
    for (const recoveryCode of ['AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', 'short']) {
      const weak = await create(ada, { name: 'Refused code', recoveryCode });
      assert.equal(weak.status, 400, recoveryCode);
      assert.equal(codeOf(weak), 'RECOVERY_CODE_INVALID');
    }
    assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM workspaces WHERE encrypted AND name LIKE 'Refused %'")).rows[0].n), before);
    assert.equal((await new Browser().request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { name: 'x', creationId: randomUUID(), password: PASSWORD, companyId } })).status, 401);
    assert.deepEqual(expectStatus(await ada.browser.request('GET', ENCRYPTED_SPACES_AVAILABILITY_PATH), 200), { available: true });
  });

  test('the company’s admin sees that it exists and can delete it, never open it; Add me does not list it', async () => {
    const result = made(await create(ada, { name: 'Board minutes', people: [cy.id], recoveryCode: makeCode() }));
    const space = result.workspace.id;
    // Not in their lists, not readable, not changeable.
    assert.equal((await spaces(admin)).some((item) => item.id === space), false, 'it is not one of the admin’s workspaces');
    assert.equal((await admin.browser.request('GET', `/api/v1/workspaces/${space}`)).status, 404);
    assert.equal((await admin.browser.request('GET', `/api/v1/projects/${result.project!.id}`)).status, 404);
    assert.equal((await admin.browser.request('POST', `/api/v1/projects/${result.project!.id}/grants`, { body: { principal: { kind: 'human', id: admin.id }, role: 'manager' } })).status, 404, 'no Add me');
    assert.equal((await admin.browser.request('POST', `/api/v1/workspaces/${space}/members`, { body: { userId: admin.id, role: 'member' } })).status, 404);
    const listed = expectStatus(await admin.browser.request('GET', companyEncryptedSpacesPath(companyId)), 200) as EncryptedSpaceRef[];
    const entry = listed.find((item) => item.id === space);
    assert.deepEqual(entry && { name: entry.name, member: entry.member }, { name: 'Board minutes', member: false });
    assert.deepEqual(Object.keys(entry!).sort(), ['createdAt', 'id', 'member', 'name'], 'a name and a date, nothing about its people or content');
    // A plain member is not told which encrypted spaces exist; a person outside the company has no such company.
    assert.equal((await ada.browser.request('GET', companyEncryptedSpacesPath(companyId))).status, 403);
    assert.equal((await stranger.browser.request('GET', companyEncryptedSpacesPath(companyId))).status, 404);
    // Deleting: a plain member of the space and a stranger cannot; the company's admin can, and it is gone with its keys.
    for (const who of [cy, stranger]) assert.equal((await who.browser.request('DELETE', encryptedSpacePath(space))).status, 404, who.email);
    expectStatus(await admin.browser.request('DELETE', encryptedSpacePath(space)), 204);
    for (const table of ['workspaces', 'projects', 'workspace_members', 'workspace_holders', 'workspace_keys']) {
      const column = table === 'workspaces' ? 'id' : 'workspace_id';
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [space])).rows[0].n, 0, table);
    }
    assert.equal((await cy.browser.request('GET', `/api/v1/workspaces/${space}`)).status, 404);
    assert.equal((await admin.browser.request('DELETE', encryptedSpacePath(space))).status, 404, 'a second delete finds nothing');
  });

  test('a space admin deletes it too, and the company’s admin who is also in it sees it as a member', async () => {
    const result = made(await create(admin, { name: 'Admin’s own', recoveryCode: makeCode() }));
    const listed = expectStatus(await admin.browser.request('GET', companyEncryptedSpacesPath(companyId)), 200) as EncryptedSpaceRef[];
    assert.equal(listed.find((item) => item.id === result.workspace.id)?.member, true);
    const mine = made(await create(ben, { name: 'Ben’s own', recoveryCode: makeCode() }));
    expectStatus(await ben.browser.request('DELETE', encryptedSpacePath(mine.workspace.id)), 204);
    expectStatus(await admin.browser.request('DELETE', encryptedSpacePath(result.workspace.id)), 204);
  });

  test('it holds exactly one space, takes no invite link and only the company’s people', async () => {
    const result = made(await create(ada, { name: 'One only', recoveryCode: makeCode() }));
    const space = result.workspace.id;
    const second = await ada.browser.request('POST', `/api/v1/workspaces/${space}/projects`, { body: { name: 'A second', visibility: 'workspace' } });
    assert.equal(second.status, 422, second.text);
    assert.equal(codeOf(second), 'ENCRYPTED_SPACE_HOLDS_ONE');
    const invite = await ada.browser.request('POST', `/api/v1/workspaces/${space}/invites`, { body: { role: 'member', expiresInDays: 7 } });
    assert.equal(invite.status, 409, invite.text);
    assert.equal(codeOf(invite), 'ENCRYPTED_SPACE_NO_INVITES');
    const outsider = await ada.browser.request('POST', `/api/v1/workspaces/${space}/members`, { body: { userId: stranger.id, role: 'member' } });
    assert.equal(outsider.status, 409, outsider.text);
    assert.equal(codeOf(outsider), 'NOT_A_MEMBER');
    expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${space}/members`, { body: { userId: cy.id, role: 'member' } }), 201);
    const listed = expectStatus(await cy.browser.request('GET', `/api/v1/workspaces/${space}/projects`), 200) as Page<Project>;
    assert.deepEqual(listed.items.map((item) => item.name), ['One only']);
  });

  test('leaving the company ends a person’s place in its encrypted spaces; the only admin of one cannot leave first', async () => {
    const leaver = await person('Spaces Leaver');
    const founder = await person('Spaces Founder');
    await join(leaver, 'member'); await join(founder, 'member');
    const result = made(await create(founder, { name: 'Leaver’s place', people: [leaver.id], recoveryCode: makeCode() }));
    const space = result.workspace.id;
    const second = made(await create(founder, { name: 'Second place', recoveryCode: makeCode() })).workspace.id;
    expectStatus(await founder.browser.request('POST', `/api/v1/workspaces/${space}/members`, { body: { userId: ben.id, role: 'admin' } }), 201);
    assert.equal(await roleIn(space, leaver.id), 'member');
    expectStatus(await admin.browser.request('DELETE', `/api/v1/workspaces/${companyId}/members/${leaver.id}`), 204);
    assert.equal(await roleIn(space, leaver.id), null, 'gone from the space with the company');
    assert.equal(await roleIn(companyId, leaver.id), null);
    // The founder is the space's only owner and holds its only unlock password: the removal is refused whole, naming the space, and the way
    // out is the company admin's own: delete the space (C-24). Nothing was changed by the refusal.
    const refused = await admin.browser.request('DELETE', `/api/v1/workspaces/${companyId}/members/${founder.id}`);
    assert.equal(refused.status, 409, refused.text);
    assert.equal(codeOf(refused), 'ENCRYPTED_SPACE_LAST_KEYHOLDER');
    assert.deepEqual([...(refused.json as { spaces: string[] }).spaces].sort(), ['Leaver’s place', 'Second place'], 'every space where they are alone is named, not only the first');
    assert.match((refused.json as { error: string }).error, /Ask them to hand/);
    assert.equal(await roleIn(companyId, founder.id), 'member', 'nothing changed');
    assert.equal(await roleIn(space, founder.id), 'owner');
    expectStatus(await admin.browser.request('DELETE', encryptedSpacePath(space)), 204);
    expectStatus(await admin.browser.request('DELETE', encryptedSpacePath(second)), 204);
    expectStatus(await admin.browser.request('DELETE', `/api/v1/workspaces/${companyId}/members/${founder.id}`), 204);
    assert.equal(await roleIn(companyId, founder.id), null, 'with the space gone, the removal goes through');
  });

  test('the parent of an encrypted space is the company: another encrypted space, a stranger\'s workspace and a made-up id are refused', async () => {
    const outer = made(await create(ada, { name: 'Outer', people: [ben.id], recoveryCode: makeCode() }));
    // The review of #976: a member of an encrypted space named its workspace as "the company" and made a space the company's admins cannot see.
    for (const who of [ada, ben]) {
      const nested = await create(who, { name: 'Nested', companyId: outer.workspace.id });
      assert.equal(nested.status, 403, `${who.email}: ${nested.text}`);
      assert.equal(codeOf(nested), 'ENCRYPTED_SPACE_COMPANY_ONLY');
    }
    assert.equal((await create(ada, { name: 'Nowhere', companyId: randomUUID() })).status, 403);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM workspaces WHERE name IN ('Nested', 'Nowhere')")).rows[0].n, 0);
    // The database says no as well, whoever writes the link.
    const other = made(await create(ada, { name: 'Other', recoveryCode: makeCode() }));
    await assert.rejects(pool.query('UPDATE workspaces SET company_workspace_id = $1 WHERE id = $2', [outer.workspace.id, other.workspace.id]), /never to another encrypted space/);
    // In a test deployment an isolated workspace stands in for the company; a deployment has none, so only the company is the parent there.
    const isolated = expectStatus(await ada.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Stand-in company' } }), 201) as Workspace;
    const standIn = made(await create(ada, { name: 'In the stand-in', companyId: isolated.id, recoveryCode: makeCode() }));
    assert.equal(standIn.workspace.spaceOf, isolated.id);
    // Deleting the outer space takes no other space with it.
    expectStatus(await ada.browser.request('DELETE', encryptedSpacePath(outer.workspace.id)), 204);
    assert.equal(await roleIn(standIn.workspace.id, ada.id), 'owner');
  });

  test('guests are in no encrypted space: not at creation, not added, not promoted, and becoming a company guest ends the place', async () => {
    const refused = await create(ada, { name: 'With a guest', people: [guest.id] });
    assert.equal(refused.status, 409);
    assert.equal(codeOf(refused), 'ENCRYPTED_SPACE_NO_GUESTS');
    const result = made(await create(ada, { name: 'Keyholders only', people: [cy.id], recoveryCode: makeCode() }));
    const space = result.workspace.id;
    const added = await ada.browser.request('POST', `/api/v1/workspaces/${space}/members`, { body: { userId: guest.id, role: 'member' } });
    assert.equal(added.status, 409, added.text);
    assert.equal(codeOf(added), 'ENCRYPTED_SPACE_NO_GUESTS');
    const asGuest = await ada.browser.request('PATCH', `/api/v1/workspaces/${space}/members/${cy.id}`, { body: { role: 'guest' } });
    assert.equal(asGuest.status, 409, asGuest.text);
    assert.equal(codeOf(asGuest), 'ENCRYPTED_SPACE_NO_GUESTS');
    // Cy is an admin of the space; the company makes Cy a guest: the place ends, with the key change of removing an admin.
    expectStatus(await ada.browser.request('PATCH', `/api/v1/workspaces/${space}/members/${cy.id}`, { body: { role: 'member' } }), 200);
    expectStatus(await admin.browser.request('PATCH', `/api/v1/workspaces/${companyId}/members/${cy.id}`, { body: { role: 'guest' } }), 200);
    assert.equal(await roleIn(companyId, cy.id), 'guest');
    assert.equal(await roleIn(space, cy.id), null, 'no longer in the encrypted space');
    await pool.query("UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2", [companyId, cy.id]);
  });

  test('bringing someone back into an encrypted space asks what adding does: in the company now, and not a guest (review of #976, round 2)', async () => {
    const [rita, gus, tom] = await Promise.all(['Spaces Rita', 'Spaces Gus', 'Spaces Tom'].map(person));
    for (const who of [rita, gus, tom]) await join(who, 'member');
    const space = made(await create(ada, { name: 'Restore rules', people: [rita.id, gus.id, tom.id], recoveryCode: makeCode() })).workspace.id;
    const restore = (who: Person) => ada.browser.request('POST', `/api/v1/workspaces/${space}/removed-people/${who.id}/restore`);
    for (const who of [rita, gus, tom]) expectStatus(await ada.browser.request('DELETE', `/api/v1/workspaces/${space}/members/${who.id}`), 204);
    // Rita leaves the company, Gus becomes its guest, Tom stays: only Tom comes back.
    expectStatus(await admin.browser.request('DELETE', `/api/v1/workspaces/${companyId}/members/${rita.id}`), 204);
    expectStatus(await admin.browser.request('PATCH', `/api/v1/workspaces/${companyId}/members/${gus.id}`, { body: { role: 'guest' } }), 200);
    const gone = await restore(rita);
    assert.equal(gone.status, 409, gone.text);
    assert.equal(codeOf(gone), 'NOT_A_MEMBER');
    const guestBack = await restore(gus);
    assert.equal(guestBack.status, 409, guestBack.text);
    assert.equal(codeOf(guestBack), 'ENCRYPTED_SPACE_NO_GUESTS');
    assert.deepEqual([await roleIn(space, rita.id), await roleIn(space, gus.id)], [null, null], 'neither is in the space again, so neither can read it');
    expectStatus(await restore(tom), 201);
    assert.equal(await roleIn(space, tom.id), 'member');
  });
});
