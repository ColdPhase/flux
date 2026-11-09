import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { INBOX_PATH, NEEDS_YOU_PATH, SEARCH_PATH, projectGrantsPath, projectLeavePath, projectPath, workspaceMemberPath, type InboxResponse, type NeedsYouResponse, type Project, type SearchResponse } from '@flux/contracts';
import { authorizeDelivery, authorizeEvent } from '@flux/core';
import { accessReader } from '@flux/db';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, removeFromSpace, person, project, workspace, type Person } from './support/people.js';
import { projectReferences } from './support/project-erasure-scene.js';

// F-037 (#874): the settings of one space. Who may rename it, add and remove its people, leave it and delete it (a space admin, and a
// company owner or admin who is not in the space; never a member, a guest, a company member who was not added, or a stranger),
// what deleting erases, what stays when someone leaves, that the Everyone space cannot be deleted, and that a company admin's
// search and Inbox hold only the spaces they were added to. Every refusal has its allowed control.

const code = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;

describe('space settings: who may do what', () => {
  let owner: Person; let companyAdmin: Person; let spaceAdmin: Person; let member: Person; let guest: Person; let outsider: Person; let stranger: Person;
  let wsId: string;
  /** A space made by `spaceAdmin`, with `member` and `guest` added. */
  const newSpace = async (name: string) => {
    const space = await project(spaceAdmin, wsId, name, 'restricted');
    await grant(spaceAdmin, space.id, member, 'contributor');
    await grant(spaceAdmin, space.id, guest, 'contributor');
    return space;
  };

  before(async () => {
    [owner, companyAdmin, spaceAdmin, member, guest, outsider, stranger] = await Promise.all(
      ['set-owner', 'set-admin', 'set-space-admin', 'set-member', 'set-guest', 'set-outsider', 'set-stranger'].map((label) => person(label)));
    wsId = (await workspace(owner!, 'Settings club')).id;
    await addMember(owner!, wsId, companyAdmin!, 'admin');
    await addMember(owner!, wsId, spaceAdmin!, 'member');
    await addMember(owner!, wsId, member!, 'member');
    await addMember(owner!, wsId, guest!, 'guest');
    await addMember(owner!, wsId, outsider!, 'member');
  });

  test('the creator of a space is its admin, and a guest cannot start one', async () => {
    const space = await project(spaceAdmin, wsId, 'Made by an admin', 'restricted');
    assert.equal(space.access, 'manager');
    assert.deepEqual((await pool.query('SELECT role FROM project_grants WHERE project_id = $1 AND user_id = $2', [space.id, spaceAdmin.id])).rows, [{ role: 'manager' }]);
    const refused = await guest.browser.request('POST', `/api/v1/workspaces/${wsId}/projects`, { body: { name: 'Guests do not start spaces', visibility: 'restricted' } });
    assert.equal(refused.status, 403);
  });

  test('rename: a space admin and a company admin; not a member, a guest, a company member who was not added, or a stranger', async () => {
    const space = await newSpace('Rename me');
    const rename = (who: Person, name: string) => who.browser.request('PATCH', projectPath(space.id), { body: { name } });
    assert.deepEqual([(await rename(member, 'By a member')).status, (await rename(guest, 'By a guest')).status], [403, 403]);
    assert.equal((await rename(outsider, 'By an outsider')).status, 404, 'a company member who was not added cannot know it exists');
    assert.equal((await rename(stranger, 'By a stranger')).status, 404);
    assert.equal((await rename(spaceAdmin, '   ')).status, 400, 'a name is required');
    const byAdmin = expectStatus(await rename(spaceAdmin, 'Renamed by its admin'), 200) as Project;
    assert.deepEqual([byAdmin.name, byAdmin.version], ['Renamed by its admin', space.version + 1]);
    const byCompany = expectStatus(await rename(companyAdmin, 'Renamed by the company'), 200) as Project;
    assert.equal(byCompany.name, 'Renamed by the company');
    assert.equal(byCompany.access, 'manager', 'a company admin is a manager of every space');
    assert.equal((expectStatus(await member.browser.request('GET', projectPath(space.id)), 200) as Project).name, 'Renamed by the company');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM events WHERE kind = $1 AND object_id = $2', ['project.renamed.v1', space.id])).rows[0].n, 2);
  });

  test('people: a space admin adds, changes and removes them; a member, a guest and an outsider cannot; a guest is never an admin', async () => {
    const space = await newSpace('People');
    const add = (who: Person, target: Person, role: string) => who.browser.request('POST', projectGrantsPath(space.id), { body: { principal: { kind: 'human', id: target.id }, role } });
    assert.deepEqual([(await add(member, outsider, 'contributor')).status, (await add(guest, outsider, 'contributor')).status], [403, 403]);
    assert.equal((await add(stranger, outsider, 'contributor')).status, 404);
    assert.equal((await add(outsider, outsider, 'contributor')).status, 404, 'nobody adds themselves to a space they cannot open');
    expectStatus(await add(spaceAdmin, outsider, 'contributor'), 201);
    expectStatus(await outsider.browser.request('GET', projectPath(space.id)), 200);
    expectStatus(await add(spaceAdmin, outsider, 'manager'), 201);
    assert.equal((expectStatus(await outsider.browser.request('GET', projectPath(space.id)), 200) as Project).access, 'manager', 'now an admin of the space');
    const guestAdmin = await add(spaceAdmin, guest, 'manager');
    assert.deepEqual([guestAdmin.status, code(guestAdmin)], [422, 'GUEST_NOT_SPACE_ADMIN']);
    const grants = expectStatus(await spaceAdmin.browser.request('GET', projectGrantsPath(space.id)), 200) as { id: string; principal: { id: string } }[];
    const outsiderGrant = grants.find((row) => row.principal.id === outsider.id)!;
    expectStatus(await companyAdmin.browser.request('DELETE', `${projectGrantsPath(space.id)}/${outsiderGrant.id}`), 204);
    expectStatus(await outsider.browser.request('GET', projectPath(space.id)), 404);
  });

  test('leave: members and guests leave; the last admin cannot; someone who was never added has nothing to leave; an outsider cannot know it', async () => {
    const space = await newSpace('Leave');
    const leave = (who: Person) => who.browser.request('POST', projectLeavePath(space.id));
    assert.equal((await leave(stranger)).status, 404);
    assert.equal((await leave(outsider)).status, 404, 'a company member who was not added cannot open it, so cannot leave it');
    const none = await leave(companyAdmin);
    assert.deepEqual([none.status, code(none)], [422, 'NOT_ADDED'], 'a company admin reaches every space without being in it');
    const last = await leave(spaceAdmin);
    assert.deepEqual([last.status, code(last)], [422, 'LAST_SPACE_ADMIN'], 'a space keeps an admin');
    expectStatus(await member.browser.request('GET', projectPath(space.id)), 200);
    assert.equal((await leave(member)).status, 204);
    expectStatus(await member.browser.request('GET', projectPath(space.id)), 404);
    assert.equal((await leave(guest)).status, 204);
    expectStatus(await guest.browser.request('GET', projectPath(space.id)), 404);
    // With another admin the first one may leave.
    await grant(spaceAdmin, space.id, member, 'manager');
    assert.equal((await leave(spaceAdmin)).status, 204);
    assert.equal((expectStatus(await member.browser.request('GET', projectPath(space.id)), 200) as Project).access, 'manager', 'the remaining admin keeps it');
  });

  test('a person removed from a space, or who leaves it, hears of it by its id alone, so their open tabs drop it (#862)', async () => {
    const space = await newSpace('Removed and told');
    const audiences = async (kind: string) => (await pool.query(`SELECT e.id, e.data, array_agg(a.recipient ORDER BY a.recipient) AS recipients FROM events e
      JOIN event_audience a ON a.event_id = e.id WHERE e.kind = $2 AND e.object_id = $1 GROUP BY e.id, e.data, e.seq ORDER BY e.seq`, [space.id, kind]))
      .rows as { id: string; data: Record<string, unknown>; recipients: string[] }[];
    await removeFromSpace(spaceAdmin, space.id, member);
    expectStatus(await member.browser.request('GET', projectPath(space.id)), 404);
    const [revoked] = await audiences('project.grant_revoked.v1');
    assert.ok(revoked!.recipients.includes(`human:${spaceAdmin.id}`) && !revoked!.recipients.includes(`human:${member.id}`), 'the space\'s people, decided after the grant went');
    const [ended] = await audiences('project.access_ended.v1');
    assert.deepEqual(ended!.recipients, [`human:${member.id}`], 'the removed person alone, by name');
    assert.deepEqual(ended!.data, {}, 'ids only');
    const event = (kind: string) => ({ kind, workspaceId: wsId, objectId: space.id });
    assert.equal(await authorizeDelivery({ kind: 'human', id: member.id }, event('project.access_ended.v1'), accessReader(db)), true, 'the stream delivers it from their own row');
    assert.equal(await authorizeEvent({ kind: 'human', id: member.id }, event('project.access_ended.v1'), accessReader(db)), false, 'an audience or an event looked up by id still needs the space');
    assert.equal(await authorizeDelivery({ kind: 'human', id: member.id }, event('project.grant_revoked.v1'), accessReader(db)), false, 'not someone else\'s removal, nor any other event of the space');
    assert.equal(await authorizeDelivery({ kind: 'human', id: stranger.id }, event('project.access_ended.v1'), accessReader(db)), false, 'not someone outside the company');
    assert.equal(await authorizeDelivery({ kind: 'agent', id: randomUUID() }, event('project.access_ended.v1'), accessReader(db)), false);
    // Leaving tells the person's other tabs and devices too.
    expectStatus(await guest.browser.request('POST', projectLeavePath(space.id)), 204);
    const [, left] = await audiences('project.access_ended.v1');
    assert.deepEqual(left!.recipients, [`human:${guest.id}`]);
    const [, leftRevoked] = await audiences('project.grant_revoked.v1');
    assert.ok(leftRevoked!.recipients.includes(`human:${spaceAdmin.id}`) && !leftRevoked!.recipients.includes(`human:${guest.id}`) && !leftRevoked!.recipients.includes(`human:${member.id}`));
  });

  test('a person removed from the company, or who leaves it, hears of it alone, by its id; nobody else ever has that event (#862)', async () => {
    const [removed, leaver] = await Promise.all([person('set-company-removed'), person('set-company-leaver')]);
    await addMember(owner, wsId, removed, 'member');
    await addMember(owner, wsId, leaver, 'member');
    const space = await newSpace('Left with the company');
    await grant(spaceAdmin, space.id, removed, 'contributor');
    const ended = async () => (await pool.query(`SELECT e.id, e.data, e.seq, array_agg(a.recipient ORDER BY a.recipient) AS recipients FROM events e
      JOIN event_audience a ON a.event_id = e.id WHERE e.kind = 'workspace.access_ended.v1' AND e.object_id = $1 AND e.workspace_id = $1 GROUP BY e.id, e.data, e.seq ORDER BY e.seq`, [wsId]))
      .rows as { id: string; data: Record<string, unknown>; recipients: string[] }[];
    const before = (await ended()).length;
    expectStatus(await owner.browser.request('DELETE', workspaceMemberPath(wsId, removed.id)), 204);
    expectStatus(await removed.browser.request('GET', projectPath(space.id)), 404);
    expectStatus(await leaver.browser.request('DELETE', workspaceMemberPath(wsId, leaver.id)), 204);
    const [byOwner, byThemselves] = (await ended()).slice(before);
    assert.deepEqual(byOwner!.recipients, [`human:${removed.id}`], 'the removed person alone, by name');
    assert.deepEqual(byThemselves!.recipients, [`human:${leaver.id}`], 'and the person who left, for their other tabs');
    assert.deepEqual([byOwner!.data, byThemselves!.data], [{}, {}], 'ids only');
    const event = { kind: 'workspace.access_ended.v1', workspaceId: wsId, objectId: wsId };
    assert.equal(await authorizeDelivery({ kind: 'human', id: removed.id }, event, accessReader(db)), true, 'the stream delivers it from their own row, though they are no longer a member');
    assert.equal(await authorizeEvent({ kind: 'human', id: removed.id }, event, accessReader(db)), false, 'an audience or an event looked up by id (a cursor) still needs the company');
    assert.equal(await authorizeDelivery({ kind: 'human', id: removed.id }, { ...event, kind: 'workspace.member_removed.v1' }, accessReader(db)), false, 'no other event of the company');
    assert.equal(await authorizeDelivery({ kind: 'agent', id: randomUUID() }, event, accessReader(db)), false);
    // Nobody else holds a row of it (the audiences above), so no replay from any cursor gives it to them; a cursor that names it needs the company.
    assert.equal(await authorizeEvent({ kind: 'human', id: member.id }, event, accessReader(db)), true, 'a member still reads the company, so an id lookup is the ordinary rule');
  });

  test('delete: a space admin and a company admin; not a member, a guest, an outsider or a stranger; everything in it is erased', async () => {
    const space = await newSpace('Delete me');
    // Something in every feature a person writes: a conversation, a task, a Wiki page.
    expectStatus(await spaceAdmin.browser.request('POST', `/api/v1/projects/${space.id}/conversations`, { body: { body: 'To be erased', clientMessageId: randomUUID() } }), 201);
    expectStatus(await spaceAdmin.browser.request('POST', `/api/v1/projects/${space.id}/work`, { body: { title: 'Erased with its space' } }), 201);
    expectStatus(await spaceAdmin.browser.request('POST', `/api/v1/projects/${space.id}/docs`, { body: { title: 'Erased page', body: 'Erased body' } }), 201);
    const before = await projectReferences(space.id);
    assert.ok(before.project_conversations! > 0 && before.project_work_items! > 0 && before.project_grants! > 0, `the space holds its own rows: ${JSON.stringify(before)}`);
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, ai_origin) VALUES ($1, $2, $3, 'project', $4, 'A note', false)`,
      [randomUUID(), member.id, wsId, space.id]);
    const kept = await newSpace('Kept');
    expectStatus(await spaceAdmin.browser.request('POST', `/api/v1/projects/${kept.id}/work`, { body: { title: 'Stays' } }), 201);
    const keptBefore = await projectReferences(kept.id);

    const remove = (who: Person) => who.browser.request('DELETE', projectPath(space.id));
    assert.deepEqual([(await remove(member)).status, (await remove(guest)).status], [403, 403]);
    assert.deepEqual([(await remove(outsider)).status, (await remove(stranger)).status], [404, 404]);
    expectStatus(await spaceAdmin.browser.request('GET', projectPath(space.id)), 200);
    assert.equal((await remove(spaceAdmin)).status, 204);

    assert.equal((await pool.query('SELECT count(*)::int AS n FROM projects WHERE id = $1', [space.id])).rows[0].n, 0);
    for (const [table, count] of Object.entries(await projectReferences(space.id))) assert.equal(count, 0, `${table} keeps no row of the erased space`);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE source_type = 'project' AND source_id = $1`, [space.id])).rows[0].n, 0, 'nor a notification about it');
    assert.deepEqual(await projectReferences(kept.id), keptBefore, 'another space is untouched');
    expectStatus(await member.browser.request('GET', projectPath(space.id)), 404);
    expectStatus(await spaceAdmin.browser.request('GET', `/api/v1/workspaces/${wsId}/projects`), 200);
    assert.equal((await remove(spaceAdmin)).status, 404, 'a second delete finds nothing');
    // Its people are told, so their lists drop it: the event goes to those who could open it, and only to them.
    const audience = (await pool.query(`SELECT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id WHERE e.kind = 'project.deleted.v1' AND e.object_id = $1`, [space.id]))
      .rows.map((row) => row.recipient as string).sort();
    assert.deepEqual(audience, [`human:${companyAdmin.id}`, `human:${guest.id}`, `human:${member.id}`, `human:${owner.id}`, `human:${spaceAdmin.id}`].sort(), 'not the outsider, who could never open it');
    const event = { kind: 'project.deleted.v1', workspaceId: wsId, objectId: space.id };
    assert.equal(await authorizeEvent({ kind: 'human', id: member.id }, event, accessReader(db)), true, 'delivered after the space is gone');
    assert.equal(await authorizeEvent({ kind: 'human', id: stranger.id }, event, accessReader(db)), false);
    assert.equal(await authorizeEvent({ kind: 'agent', id: randomUUID() }, event, accessReader(db)), false);

    // A company admin who is not in a space deletes it.
    const other = await newSpace('Deleted by the company');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_grants WHERE project_id = $1 AND user_id = $2', [other.id, companyAdmin.id])).rows[0].n, 0);
    assert.equal((await companyAdmin.browser.request('DELETE', projectPath(other.id))).status, 204);
    expectStatus(await spaceAdmin.browser.request('GET', projectPath(other.id)), 404);
  });

  test('a member who was removed from a space reaches it again once they become a company admin', async () => {
    const space = await newSpace('Removed then promoted');
    const [candidate] = [await person('set-removed')];
    await addMember(owner, wsId, candidate, 'member');
    await grant(spaceAdmin, space.id, candidate, 'contributor');
    await removeFromSpace(spaceAdmin, space.id, candidate);
    expectStatus(await candidate.browser.request('GET', projectPath(space.id)), 404);
    expectStatus(await owner.browser.request('PATCH', `/api/v1/workspaces/${wsId}/members/${candidate.id}`, { body: { role: 'admin' } }), 200);
    assert.equal((expectStatus(await candidate.browser.request('GET', projectPath(space.id)), 200) as Project).access, 'manager');
  });

  test('delete: the Everyone space cannot be deleted by its admin or by the company\'s admin', async () => {
    const [company] = (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows;
    const [everyone] = (await pool.query<{ id: string }>(`SELECT id FROM projects WHERE workspace_id = $1 AND visibility = 'workspace'`, [company!.id])).rows;
    const admin = await person('set-everyone-admin');
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'admin', $2)`, [company!.id, admin.id]);
    const refused = await admin.browser.request('DELETE', projectPath(everyone!.id));
    assert.deepEqual([refused.status, code(refused)], [422, 'EVERYONE_CANNOT_BE_DELETED']);
    const asSpaceAdmin = await person('set-everyone-space-admin');
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'member', $2)`, [company!.id, asSpaceAdmin.id]);
    await pool.query(`INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) VALUES ($1, $2, $3, $4, 'manager', $4)`, [randomUUID(), company!.id, everyone!.id, asSpaceAdmin.id]);
    const again = await asSpaceAdmin.browser.request('DELETE', projectPath(everyone!.id));
    assert.deepEqual([again.status, code(again)], [422, 'EVERYONE_CANNOT_BE_DELETED']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM projects WHERE id = $1', [everyone!.id])).rows[0].n, 1, 'Everyone is still there');
    // Everyone holds the whole company: nobody leaves it by hand.
    const left = await asSpaceAdmin.browser.request('POST', projectLeavePath(everyone!.id));
    assert.deepEqual([left.status, code(left)], [422, 'EVERYONE_CANNOT_BE_LEFT']);
  });
});

describe('a company admin\'s search and Inbox hold only the spaces they belong to', () => {
  let owner: Person; let companyAdmin: Person; let spaceAdmin: Person;
  let wsId: string; let space: Project;
  const word = `quasar${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const find = async (who: Person) => (expectStatus(await who.browser.request('GET', `${SEARCH_PATH}?q=${word}`), 200) as SearchResponse).items.length;
  const inbox = async (who: Person) => (expectStatus(await who.browser.request('GET', INBOX_PATH), 200) as InboxResponse).items.map((item) => item.id);
  const needsYou = async (who: Person) => (expectStatus(await who.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.map((item) => item.key);
  let note: string;

  before(async () => {
    [owner, companyAdmin, spaceAdmin] = await Promise.all(['sea-owner', 'sea-admin', 'sea-space-admin'].map((label) => person(label)));
    wsId = (await workspace(owner!, 'Search club')).id;
    await addMember(owner!, wsId, companyAdmin!, 'admin');
    await addMember(owner!, wsId, spaceAdmin!, 'member');
    space = await project(spaceAdmin!, wsId, 'Hidden from the company admin', 'restricted');
    expectStatus(await spaceAdmin!.browser.request('POST', `/api/v1/projects/${space.id}/conversations`, { body: { body: `A note about ${word}`, clientMessageId: randomUUID() } }), 201);
    note = randomUUID();
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, reason, ai_origin) VALUES ($1, $2, $3, 'project', $4, 'Someone asked about it', 'question', false)`,
      [note, companyAdmin!.id, wsId, space.id]);
  });

  test('a company admin reaches the space but does not find its content, and the space\'s admin does', async () => {
    expectStatus(await companyAdmin.browser.request('GET', projectPath(space.id)), 200);
    const listed = (expectStatus(await companyAdmin.browser.request('GET', `/api/v1/workspaces/${wsId}/projects`), 200) as { items: Project[] }).items;
    assert.equal(listed.find((item) => item.id === space.id)!.member, false, 'reachable, not a member');
    assert.equal(await find(spaceAdmin), 1, 'control: a member finds it');
    assert.equal(await find(companyAdmin), 0, 'a company admin who is not in the space does not');
  });

  test('their Inbox and Needs you leave out what is in a space they were not added to; adding themselves brings it', async () => {
    assert.ok(!(await inbox(companyAdmin)).includes(note));
    assert.ok(!(await needsYou(companyAdmin)).includes(`note:${note}`));
    // "Add me" in Settings › Company: the admin becomes a member of the space, and its admin (#903).
    expectStatus(await companyAdmin.browser.request('POST', projectGrantsPath(space.id), { body: { principal: { kind: 'human', id: companyAdmin.id }, role: 'manager' } }), 201);
    assert.ok((await inbox(companyAdmin)).includes(note), 'control: in the Inbox once they belong to it');
    assert.equal(await find(companyAdmin), 1, 'and in their search');
    expectStatus(await companyAdmin.browser.request('POST', projectLeavePath(space.id)), 204);
    assert.equal(await find(companyAdmin), 0, 'and out again when they leave');
    assert.ok(!(await inbox(companyAdmin)).includes(note));
  });
});
