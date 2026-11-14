import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { COMPANY_NAME, NEW_PERSON_DAYS, readFirstSteps, type FirstStepRows } from '@flux/core';
import { ME_PHOTO_PATH, projectConversationsPath, type FirstSteps, type WorkspaceRole } from '@flux/contracts';
import { pool } from './support/db.js';
import { png } from './support/pictures.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';

// Home's first-steps card (founder decisions 2026-11-13, #1438): which steps are left for a new person, by company role; Hide and finishing are for good.

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function rows(role: WorkspaceRole | null, facts: Partial<{ name: string; hidden: boolean; invited: boolean; ai: boolean; wrote: boolean; photo: boolean; everyone: string | null; joinedDaysAgo: number; joined: { userId: string; name: string }[] }> = {}) {
  const read: string[] = [];
  const hid: string[] = [];
  const port: FirstStepRows = {
    company: async () => (role ? { id: 'c', name: facts.name ?? COMPANY_NAME, role, joinedAt: daysAgo(facts.joinedDaysAgo ?? 0), everyoneSpaceId: facts.everyone === undefined ? 'e' : facts.everyone, hidden: facts.hidden ?? false } : null),
    invitedAnyone: async () => { read.push('invited'); return facts.invited ?? false; },
    aiConnected: async () => { read.push('ai'); return facts.ai ?? false; },
    wroteMessage: async () => { read.push('wrote'); return facts.wrote ?? false; },
    hasPhoto: async () => { read.push('photo'); return facts.photo ?? false; },
    joinedPeople: async () => facts.joined ?? [],
    hide: async (userId) => { hid.push(userId); },
  };
  return { port, read, hid };
}

async function stepsOf(who: Person) {
  return expectStatus(await who.browser.request('GET', '/api/v1/me/first-steps'), 200) as FirstSteps;
}
async function doneAt(who: Person) {
  return (await pool.query<{ first_steps_hidden_at: Date | null }>('SELECT first_steps_hidden_at FROM auth_users WHERE id = $1', [who.id])).rows[0]!.first_steps_hidden_at;
}
async function setPhoto(who: Person) {
  const response = await fetch(new URL(ME_PHOTO_PATH, who.browser.base), { method: 'PUT', headers: { 'content-type': 'image/png', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: Buffer.from(png(64, 64)) });
  assert.equal(response.status, 200, 'sets a photo');
}

describe('#1438 first steps', () => {
  test('rows by role: owner and admin name, invite, connect AI; a member writes, adds a photo and may turn notifications on', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const { port, read } = rows(role);
      assert.deepEqual(await readFirstSteps('u', port), { steps: ['name_company', 'invite_people', 'connect_ai'], joined: [], offerPush: false, everyoneSpaceId: 'e' });
      assert.deepEqual(read.sort(), ['ai', 'invited'], 'a member\'s facts are not read for an admin');
    }
    const member = rows('member');
    assert.deepEqual(await readFirstSteps('u', member.port), { steps: ['first_message', 'photo'], joined: [], offerPush: true, everyoneSpaceId: 'e' });
    assert.deepEqual(member.read.sort(), ['photo', 'wrote']);
  });

  test('each row leaves when done; a guest, someone outside a company and a hidden card get none', async () => {
    assert.deepEqual((await readFirstSteps('u', rows('owner', { name: 'Riverside Makers', invited: true, ai: true }).port)).steps, []);
    assert.deepEqual((await readFirstSteps('u', rows('owner', { name: 'Riverside Makers' }).port)).steps, ['invite_people', 'connect_ai']);
    assert.deepEqual((await readFirstSteps('u', rows('member', { wrote: true }).port)).steps, ['photo']);
    assert.deepEqual((await readFirstSteps('u', rows('member', { everyone: null }).port)).steps, ['photo'], 'no Everyone to write in');
    for (const port of [rows('guest').port, rows(null).port, rows('member', { hidden: true }).port]) {
      assert.deepEqual(await readFirstSteps('u', port), { steps: [], joined: [], offerPush: false, everyoneSpaceId: null });
    }
  });

  test('only a new person has a card: one who joined long ago gets none, however much is undone, and nothing is read for them', async () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const old = rows(role, { joinedDaysAgo: NEW_PERSON_DAYS + 1 });
      assert.deepEqual(await readFirstSteps('u', old.port), { steps: [], joined: [], offerPush: false, everyoneSpaceId: null }, `${role} who joined ${NEW_PERSON_DAYS + 1} days ago`);
      assert.deepEqual([old.read, old.hid], [[], []], 'no fact is read and nothing is marked for someone who is not new');
      const recent = rows(role, { joinedDaysAgo: NEW_PERSON_DAYS - 1 });
      assert.ok((await readFirstSteps('u', recent.port)).steps.length > 0, `${role} who joined ${NEW_PERSON_DAYS - 1} days ago is still new`);
    }
  });

  test('notifications never make a card: a member with nothing left gets no offerPush, and a step left is the only way to it', async () => {
    const done = rows('member', { wrote: true, photo: true });
    assert.deepEqual(await readFirstSteps('u', done.port), { steps: [], joined: [], offerPush: false, everyoneSpaceId: 'e' });
    assert.equal((await readFirstSteps('u', rows('member', { wrote: true }).port)).offerPush, true, 'beside a step that is left');
    assert.equal((await readFirstSteps('u', rows('member', { everyone: null, photo: true }).port)).offerPush, false, 'no step left (there is no Everyone to write in)');
  });

  test('a card with no step left is done for good: marked once, for the person, and never read again once marked', async () => {
    const owner = rows('owner', { name: 'Riverside Makers', invited: true, ai: true });
    assert.deepEqual(await readFirstSteps('ada', owner.port), { steps: [], joined: [], offerPush: false, everyoneSpaceId: 'e' });
    assert.deepEqual(owner.hid, ['ada']);
    const member = rows('member', { wrote: true, photo: true });
    await readFirstSteps('gus', member.port);
    assert.deepEqual(member.hid, ['gus']);
    // A step left marks nothing; a marked (or hidden) card is not read at all, however undone its steps became.
    const left = rows('member', { wrote: true });
    await readFirstSteps('gus', left.port);
    assert.deepEqual(left.hid, []);
    const marked = rows('member', { hidden: true });
    assert.deepEqual(await readFirstSteps('gus', marked.port), { steps: [], joined: [], offerPush: false, everyoneSpaceId: null });
    assert.deepEqual([marked.read, marked.hid], [[], []]);
  });

  test('on the route a new member finishes the card once and it never returns, even when a step becomes undone', async () => {
    await person('Steps first');
    const owner = await person('Steps owner');
    const company = await workspace(owner, 'Steps Makers');
    const everyone = await project(owner, company.id, 'Everyone', 'workspace');
    const gus = await person('Steps Gus');
    await addMember(owner, company.id, gus, 'member');
    assert.deepEqual(await stepsOf(gus), { steps: ['first_message', 'photo'], joined: [], offerPush: true, everyoneSpaceId: everyone.id });
    assert.equal(await doneAt(gus), null);
    expectStatus(await gus.browser.request('POST', projectConversationsPath(everyone.id), { body: { body: 'Hello from Gus', clientMessageId: randomUUID() } }), 201);
    assert.deepEqual(await stepsOf(gus), { steps: ['photo'], joined: [], offerPush: true, everyoneSpaceId: everyone.id });
    assert.equal(await doneAt(gus), null, 'a step left marks nothing');
    await setPhoto(gus);
    assert.deepEqual(await stepsOf(gus), { steps: [], joined: [], offerPush: false, everyoneSpaceId: everyone.id }, 'nothing left: no card and no notifications row');
    const finished = await doneAt(gus);
    assert.ok(finished instanceof Date, 'the card is done for good, for every device');
    expectStatus(await gus.browser.request('DELETE', ME_PHOTO_PATH), 204);
    assert.deepEqual(await stepsOf(gus), { steps: [], joined: [], offerPush: false, everyoneSpaceId: null }, 'a photo removed later does not bring the card back');
    assert.equal((await doneAt(gus))!.getTime(), finished.getTime(), 'the first time is kept');
  });

  test('on the route a member who joined long ago gets no card, with a step undone or not, and a new one still does', async () => {
    await person('Steps first');
    const owner = await person('Steps old owner');
    const company = await workspace(owner, 'Steps Old Makers');
    const everyone = await project(owner, company.id, 'Everyone', 'workspace');
    const [old, almost] = [await person('Steps Old Ivy'), await person('Steps Almost Ola')];
    for (const who of [old, almost]) await addMember(owner, company.id, who, 'member');
    for (const [who, days] of [[old, NEW_PERSON_DAYS + 5], [almost, NEW_PERSON_DAYS - 1]] as const) {
      await pool.query(`UPDATE workspace_members SET created_at = now() - make_interval(days => $3) WHERE workspace_id = $1 AND user_id = $2`, [company.id, who.id, days]);
    }
    assert.deepEqual(await stepsOf(old), { steps: [], joined: [], offerPush: false, everyoneSpaceId: null }, 'a long-standing member on a new device: no card, no notifications row');
    assert.equal(await doneAt(old), null, 'reading marks nothing for someone who is not new');
    assert.deepEqual(await stepsOf(almost), { steps: ['first_message', 'photo'], joined: [], offerPush: true, everyoneSpaceId: everyone.id });
  });

  test("the route answers the person's own steps, and Hide is for good", async () => {
    const ada = await person('Ada Steps');
    const first = expectStatus(await ada.browser.request('GET', '/api/v1/me/first-steps'), 200) as { steps: string[]; offerPush: boolean };
    assert.ok(Array.isArray(first.steps) && typeof first.offerPush === 'boolean');
    expectStatus(await ada.browser.request('POST', '/api/v1/me/first-steps/hide', { headers: { 'idempotency-key': randomUUID() } }), 204);
    assert.deepEqual(expectStatus(await ada.browser.request('GET', '/api/v1/me/first-steps'), 200), { steps: [], joined: [], offerPush: false, everyoneSpaceId: null });
    const hidden = (await pool.query<{ first_steps_hidden_at: Date | null }>('SELECT first_steps_hidden_at FROM auth_users WHERE id = $1', [ada.id])).rows[0]!;
    assert.ok(hidden.first_steps_hidden_at instanceof Date);
    // A second Hide keeps the first time.
    expectStatus(await ada.browser.request('POST', '/api/v1/me/first-steps/hide', { headers: { 'idempotency-key': randomUUID() } }), 204);
    const again = (await pool.query<{ first_steps_hidden_at: Date }>('SELECT first_steps_hidden_at FROM auth_users WHERE id = $1', [ada.id])).rows[0]!;
    assert.equal(again.first_steps_hidden_at.getTime(), hidden.first_steps_hidden_at!.getTime());
  });
});

describe('#1438 / #1424: the people who joined with the owner\'s links', () => {
  const nia = { userId: 'nia', name: 'Nia Lindqvist' };

  test('they take the place of "Invite people" once a link was made, only beside a step that is left, and never for a member', async () => {
    const lead = rows('owner', { name: 'Riverside Makers', invited: true, joined: [nia] });
    assert.deepEqual(await readFirstSteps('u', lead.port), { steps: ['connect_ai'], joined: [nia], offerPush: false, everyoneSpaceId: 'e' });
    // The card is the steps: with none left it is done for good, and nobody who joined keeps it alive or brings it back.
    const done = rows('owner', { name: 'Riverside Makers', invited: true, ai: true, joined: [nia] });
    assert.deepEqual(await readFirstSteps('u', done.port), { steps: [], joined: [], offerPush: false, everyoneSpaceId: 'e' });
    assert.deepEqual(done.hid, ['u'], 'marked done, as before');
    // No link made yet: nobody can have joined with one, and the step is still "Invite people".
    assert.deepEqual((await readFirstSteps('u', rows('owner', { joined: [nia] }).port)).joined, []);
    assert.deepEqual((await readFirstSteps('u', rows('member', { joined: [nia] }).port)).joined, [], 'a member made no links');
  });

  test('on the route: one row per person who used a link of this owner, newest first, until a direct message is opened with them', async () => {
    await person('Joined first');
    const owner = await person('Joined owner');
    const other = await person('Joined other admin');
    const company = await workspace(owner, 'Joined Makers');
    await project(owner, company.id, 'Everyone', 'workspace');
    await addMember(owner, company.id, other, 'admin');
    const headers = () => ({ 'idempotency-key': randomUUID() });
    const linkOf = async (who: Person, role: WorkspaceRole) => (expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${company.id}/invites`, { body: { role }, headers: headers() }), 201) as { link: string }).link.split('#')[1]!;
    const join = async (name: string, token: string) => {
      const joiner = await person(name);
      expectStatus(await joiner.browser.request('POST', '/api/v1/invites/accept', { body: { token }, headers: headers() }), 200);
      return joiner;
    };
    assert.deepEqual((await stepsOf(owner)).joined, [], 'nobody has joined yet');
    const first = await join('Joined Nia', await linkOf(owner, 'member'));
    // A link of another admin is that admin's, not the owner's.
    await join('Joined Stranger', await linkOf(other, 'member'));
    await pool.query(`UPDATE workspace_invites SET accepted_at = now() - interval '1 hour' WHERE accepted_by = $1`, [first.id]);
    const second = await join('Joined Ola', await linkOf(owner, 'guest'));
    const read = await stepsOf(owner);
    assert.deepEqual(read.steps, ['connect_ai'], 'the link was made, so "Invite people" is done');
    assert.deepEqual(read.joined, [{ userId: second.id, name: 'Joined Ola' }, { userId: first.id, name: 'Joined Nia' }], 'newest first; a guest too; not the other admin\'s');
    // Opening the direct message is what says hello was started: that person leaves, the other stays.
    expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${company.id}/dms`, { body: { participantIds: [second.id] }, headers: headers() }), 201);
    assert.deepEqual((await stepsOf(owner)).joined, [{ userId: first.id, name: 'Joined Nia' }]);
    // A person who left the company is no one to greet.
    expectStatus(await owner.browser.request('DELETE', `/api/v1/workspaces/${company.id}/members/${first.id}`), 204);
    assert.deepEqual((await stepsOf(owner)).joined, []);
  });
});
