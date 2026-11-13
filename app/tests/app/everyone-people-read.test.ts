import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ME_PHOTO_PATH, projectGrantsPath, projectPeoplePath, workspaceMembersPath, type ProjectGrant, type ProjectPerson, type WorkspaceMember } from '@flux/contracts';
import { pool } from './support/db.js';
import { signIn } from './support/http.js';
import { png } from './support/pictures.js';
import { addMember, expectStatus, grant, password, person, removeMember, type Person } from './support/people.js';

// #1272: Everyone › Settings › People said its people could not be read on a real instance. Its two reads (the company's people and the space's
// grants) are read here on the company's own Everyone space (the one setup made, not a space made later), with the data a company gathers: an
// admin, a dozen members, a guest added to Everyone and one who is not, a member made a guest after being an admin of Everyone, people with a
// photo, a time zone, a recent and an old last-active time and one who hides it, agents, a person who was removed and a pending invite. Each
// read answers 200 for the company's owner, an admin and a member who is one of Everyone's admins, again and again.
test('the people of the company\'s Everyone space read cleanly for its admins with the data a real company has', async () => {
  await person('Everyone read first');
  const { rows: [company] } = await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company');
  const { rows: [everyone] } = await pool.query<{ id: string }>("SELECT id FROM projects WHERE workspace_id = $1 AND visibility = 'workspace'", [company!.id]);
  const { rows: [ownerRow] } = await pool.query<{ id: string; email: string }>(
    "SELECT u.id, u.email FROM workspace_members m JOIN auth_users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role = 'owner' ORDER BY m.created_at LIMIT 1", [company!.id]);
  const signedIn = await signIn(ownerRow!.email, password);
  assert.equal(signedIn.response.status, 200, 'the company owner signs in');
  const owner: Person = { id: ownerRow!.id, email: ownerRow!.email, browser: signedIn.browser };

  const [admin, spaceAdmin, demoted, guestIn, guestOut, removed, ...members] = await Promise.all(
    ['ev-admin', 'ev-space-admin', 'ev-demoted', 'ev-guest-in', 'ev-guest-out', 'ev-removed', ...Array.from({ length: 12 }, (_, i) => `ev-member-${i + 1}`)].map((label) => person(label)));
  await addMember(owner, company!.id, admin!, 'admin');
  for (const who of [spaceAdmin!, demoted!, removed!, ...members]) await addMember(owner, company!.id, who, 'member');
  for (const who of [guestIn!, guestOut!]) await addMember(owner, company!.id, who, 'guest');
  await grant(owner, everyone!.id, spaceAdmin!, 'manager');
  await grant(owner, everyone!.id, demoted!, 'manager');
  await grant(owner, everyone!.id, guestIn!, 'contributor');
  expectStatus(await owner.browser.request('PATCH', `${workspaceMembersPath(company!.id)}/${demoted!.id}`, { body: { role: 'guest' } }), 200);
  await removeMember(owner, company!.id, removed!);
  expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${company!.id}/invites`, { body: { role: 'member' }, headers: { 'idempotency-key': randomUUID() } }), 201);
  for (const who of [owner, members[0]!, members[1]!]) {
    const response = await fetch(new URL(ME_PHOTO_PATH, who.browser.base), { method: 'PUT', headers: { 'content-type': 'image/png', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: png(64, 64) });
    assert.equal(response.status, 200, `${who.email} sets a photo`);
  }
  for (const who of [owner, members[2]!]) expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${company!.id}/agents`, { body: { name: `Agent of ${who.email.slice(0, 12)}`, owner: 'self' } }), 201);
  await pool.query("UPDATE auth_users SET time_zone = 'Europe/Warsaw', last_active_at = now() - interval '3 minutes' WHERE id = $1", [owner.id]);
  await pool.query("UPDATE auth_users SET time_zone = 'Pacific/Kiritimati', last_active_at = now() - interval '5 hours' WHERE id = $1", [admin!.id]);
  await pool.query("UPDATE auth_users SET last_active_at = now() - interval '40 days' WHERE id = $1", [members[3]!.id]);
  await pool.query("UPDATE auth_users SET show_last_active = false, last_active_at = now() WHERE id = $1", [members[4]!.id]);
  await pool.query("UPDATE auth_users SET time_zone = 'Not/AZone' WHERE id = $1", [spaceAdmin!.id]);

  for (const [label, who] of [['owner', owner], ['admin', admin!], ['member who is an admin of Everyone', spaceAdmin!]] as const) {
    for (let round = 0; round < 5; round += 1) {
      const [membersRead, grantsRead, peopleRead] = await Promise.all([
        who.browser.request('GET', workspaceMembersPath(company!.id)), who.browser.request('GET', projectGrantsPath(everyone!.id)), who.browser.request('GET', projectPeoplePath(everyone!.id)),
      ]);
      const listed = expectStatus(membersRead, 200, `${label} reads the company's people`) as WorkspaceMember[];
      const grants = expectStatus(grantsRead, 200, `${label} reads Everyone's grants`) as ProjectGrant[];
      const people = expectStatus(peopleRead, 200, `${label} reads Everyone's people`) as ProjectPerson[];
      assert.ok(!listed.some((row) => row.userId === removed!.id), 'a removed person is not listed');
      assert.equal(listed.find((row) => row.userId === demoted!.id)?.role, 'guest');
      assert.ok(!grants.some((row) => row.principal.id === demoted!.id && row.role === 'manager'), 'a person made a guest is no admin of Everyone');
      assert.ok(people.some((row) => row.id === guestIn!.id) && !people.some((row) => row.id === guestOut!.id), 'a guest is in Everyone only when added');
    }
  }
});
