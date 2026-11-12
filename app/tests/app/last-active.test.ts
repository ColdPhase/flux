import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ME_LAST_ACTIVE_PATH, ME_PATH, ME_TIME_ZONE_PATH, projectPeoplePath, type MeResponse, type ProjectPerson, type Project, type WorkspaceMember } from '@flux/contracts';
import { personLastActive } from '@flux/db';
import { db, pool } from './support/db.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { StreamClient } from './support/stream.js';
import { waitFor } from './support/wait.js';

// When a person was last active (#1225, C-58): written at most once a minute by a signed-in session and the live stream, shown rounded to whoever
// may read the person in a list, never to a guest beyond the spaces they are in, and gone for someone who turned it off.

const lastActive = async (who: Person) => (await pool.query<{ at: Date | null }>('SELECT last_active_at AS at FROM auth_users WHERE id = $1', [who.id])).rows[0]!.at;
const seed = (who: Person, sqlInterval: string | null) => pool.query(`UPDATE auth_users SET last_active_at = ${sqlInterval === null ? 'NULL' : `now() - interval '${sqlInterval}'`} WHERE id = $1`, [who.id]);
const members = async (who: Person, workspaceId: string) => expectStatus(await who.browser.request('GET', `/api/v1/workspaces/${workspaceId}/members`), 200) as WorkspaceMember[];
const people = async (who: Person, spaceId: string) => expectStatus(await who.browser.request('GET', projectPeoplePath(spaceId)), 200) as ProjectPerson[];
const row = (list: ProjectPerson[], who: Person) => list.find((entry) => entry.id === who.id)!;

describe('the time is written at most once a minute and by the live stream', () => {
  let tab: Person; let opened: number; let stream: StreamClient;

  before(async () => {
    // Started first: the last test waits out the minute while the others run. This person makes no request after the seed below.
    tab = await person('la-tab');
    stream = await StreamClient.connect(tab.browser);
    await stream.ready();
    opened = Date.now();
    await seed(tab, '10 minutes');
  });
  after(() => stream.close());

  test('the first request of a signed-in person writes it, and no further request writes again within the minute', async () => {
    const fresh = await person('la-gate');
    const first = await waitFor(async () => lastActive(fresh), 'the first request to write the time');
    assert.ok(Date.now() - first.getTime() < 60_000, 'it is the time of that request');
    // Erased by hand, ten more requests pass the gate's lookup and none writes: the per-person gate holds for the minute.
    await seed(fresh, null);
    for (let n = 0; n < 10; n += 1) expectStatus(await fresh.browser.request('GET', ME_PATH), 200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await lastActive(fresh), null, 'a request inside the minute writes nothing');
  });

  test('the statement itself writes only a time older than a minute, so a second API process cannot write more', async () => {
    const who = await person('la-statement');
    await waitFor(async () => lastActive(who), 'the first request to write the time');
    const touch = () => personLastActive(db).touch(who.id);
    await seed(who, null);
    assert.equal(await touch(), true, 'no time yet: written');
    const written = await lastActive(who);
    assert.equal(await touch(), false, 'one younger than a minute: not written');
    assert.deepEqual(await lastActive(who), written);
    await seed(who, '59 seconds');
    assert.equal(await touch(), false, '59 seconds old: not written');
    await seed(who, '2 minutes');
    assert.equal(await touch(), true, 'two minutes old: written');
    assert.ok(Date.now() - (await lastActive(who))!.getTime() < 10_000);
  });

  test('an open tab keeps it current: the stream\'s keep-alive writes it when the minute is over, with no request from the person', async () => {
    const waitMs = Math.max(0, opened + 63_000 - Date.now());
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const at = await waitFor(async () => { const value = await lastActive(tab); return value && Date.now() - value.getTime() < 30_000 ? value : null; }, 'the open stream to write the time', 10_000);
    assert.ok(at.getTime() > Date.now() - 30_000);
  });
});

describe('who sees it, and how it is rounded', () => {
  let owner: Person; let admin: Person; let member: Person; let other: Person; let guest: Person; let outsider: Person; let loner: Person;
  let wsId: string; let shared: Project; let guestOnly: Project; let everyone: Project;

  before(async () => {
    [owner, admin, member, other, guest, outsider, loner] = await Promise.all(['la-owner', 'la-admin', 'la-member', 'la-other', 'la-guest', 'la-outsider', 'la-loner'].map((label) => person(label)));
    wsId = (await workspace(owner, 'Last active club')).id;
    await addMember(owner, wsId, admin, 'admin');
    for (const who of [member, other, outsider, loner]) await addMember(owner, wsId, who, 'member');
    await addMember(owner, wsId, guest, 'guest');
    shared = await project(admin, wsId, 'Shared space', 'restricted');
    await grant(admin, shared.id, member, 'contributor');
    await grant(admin, shared.id, other, 'contributor');
    await grant(admin, shared.id, guest, 'contributor');
    guestOnly = await project(admin, wsId, 'Where loner is', 'restricted');
    await grant(admin, guestOnly.id, loner, 'contributor');
    everyone = await project(owner, wsId, 'Open to the company', 'workspace');
  });

  test('a member reads each person\'s time rounded: to the minute under an hour, to the hour under a day, to the reader\'s day from a day on', async () => {
    await pool.query("UPDATE auth_users SET last_active_at = now() - interval '12 minutes 41 seconds' WHERE id = $1", [other.id]);
    await pool.query("UPDATE auth_users SET last_active_at = now() - interval '2 hours 20 minutes 5 seconds' WHERE id = $1", [guest.id]);
    await pool.query("UPDATE auth_users SET last_active_at = now() - interval '3 days 7 hours 9 minutes' WHERE id = $1", [admin.id]);
    const listed = await people(member, shared.id);

    const minutes = new Date(row(listed, other).lastActiveAt!);
    assert.equal(minutes.getUTCSeconds() + minutes.getUTCMilliseconds(), 0, 'under an hour: the minute, never the second');
    const ago = (Date.now() - minutes.getTime()) / 60_000;
    assert.ok(ago >= 12.5 && ago < 14, `12 min 41 s ago reads as ${ago.toFixed(2)} minutes: rounded older, never newer`);

    const hours = new Date(row(listed, guest).lastActiveAt!);
    assert.equal(hours.getUTCMinutes() + hours.getUTCSeconds() + hours.getUTCMilliseconds(), 0, 'under a day: the hour');
    assert.ok(Date.now() - hours.getTime() >= (2 * 60 + 20) * 60_000);

    const expected = (await pool.query<{ day: string }>("SELECT to_char(last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM auth_users WHERE id = $1", [admin.id])).rows[0]!.day;
    assert.equal(row(listed, admin).lastActiveAt, expected, 'a day or more: only the day, in the reader\'s zone (UTC until their browser says)');
  });

  test('the day is the reader\'s own: a reader in Auckland is told the day where they are', async () => {
    await pool.query("UPDATE auth_users SET last_active_at = (date_trunc('day', (now() - interval '3 days') AT TIME ZONE 'UTC') + interval '23 hours 30 minutes') AT TIME ZONE 'UTC' WHERE id = $1", [other.id]);
    const utcDay = (await pool.query<{ day: string }>("SELECT to_char(last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM auth_users WHERE id = $1", [other.id])).rows[0]!.day;
    const auckland = (await pool.query<{ day: string }>("SELECT to_char(last_active_at AT TIME ZONE 'Pacific/Auckland', 'YYYY-MM-DD') AS day FROM auth_users WHERE id = $1", [other.id])).rows[0]!.day;
    assert.notEqual(utcDay, auckland, 'the fixture is a moment that is another day in Auckland');
    assert.equal(row(await people(member, shared.id), other).lastActiveAt, utcDay);
    expectStatus(await member.browser.request('PUT', ME_TIME_ZONE_PATH, { body: { timeZone: 'Pacific/Auckland' } }), 204);
    assert.equal(row(await people(member, shared.id), other).lastActiveAt, auckland);
    expectStatus(await member.browser.request('PUT', ME_TIME_ZONE_PATH, { body: { timeZone: 'UTC' } }), 204);
  });

  test('the company\'s people carry it too, for everyone who may read that list; a guest cannot read it', async () => {
    await pool.query("UPDATE auth_users SET last_active_at = now() - interval '25 minutes' WHERE id = $1", [other.id]);
    for (const reader of [member, admin, owner]) {
      const listed = await members(reader, wsId);
      assert.ok(listed.find((entry) => entry.userId === other.id)?.lastActiveAt, 'a member, an admin and the owner see it');
    }
    assert.equal((await guest.browser.request('GET', `/api/v1/workspaces/${wsId}/members`)).status, 403, 'a guest does not read the company\'s people');
  });

  test('a guest sees it only for the people of the spaces they were added to', async () => {
    await pool.query("UPDATE auth_users SET last_active_at = now() - interval '25 minutes' WHERE id = ANY($1)", [[other.id, loner.id, outsider.id]]);
    const seen = await people(guest, shared.id);
    assert.deepEqual(seen.filter((entry) => entry.kind === 'human').map((entry) => entry.id).sort(), [admin.id, guest.id, member.id, other.id].sort());
    assert.ok(row(seen, other).lastActiveAt, 'a person of the guest\'s own space');
    // Another space the guest is not in: no read at all, so nothing about loner or outsider.
    assert.equal((await guest.browser.request('GET', projectPeoplePath(guestOnly.id))).status, 404);
    assert.equal((await guest.browser.request('GET', projectPeoplePath(everyone.id))).status, 404, 'a company space the guest was not added to');
    assert.ok(!seen.some((entry) => entry.id === loner.id || entry.id === outsider.id));
  });

  test('an outsider of a space reads nothing about its people', async () => {
    assert.equal((await outsider.browser.request('GET', projectPeoplePath(shared.id))).status, 404);
  });

  test('an agent has no time: it shows its own state', async () => {
    const created = expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${wsId}/agents`, { body: { name: 'La agent', owner: 'self' } }), 201) as { id: string };
    const listed = await people(other, shared.id);
    const agent = listed.find((entry) => entry.id === created.id)!;
    assert.equal(agent.kind, 'agent');
    assert.equal(agent.lastActiveAt, undefined);
    assert.ok(!('lastActiveAt' in agent));
  });

  test('someone who has not been active has no time to show', async () => {
    await seed(other, null);
    assert.equal(row(await people(member, shared.id), other).lastActiveAt, undefined);
    assert.equal((await members(member, wsId)).find((entry) => entry.userId === other.id)?.lastActiveAt, undefined);
  });
});

describe('"Show when I was last active"', () => {
  let owner: Person; let reader: Person; let subject: Person;
  let wsId: string; let space: Project;
  const shown = async () => row(await people(reader, space.id), subject).lastActiveAt;
  const me = async (who: Person) => (expectStatus(await who.browser.request('GET', ME_PATH), 200) as MeResponse).user.showLastActive;

  before(async () => {
    [owner, reader, subject] = await Promise.all(['la-s-owner', 'la-s-reader', 'la-s-subject'].map((label) => person(label)));
    wsId = (await workspace(owner, 'Switch club')).id;
    for (const who of [reader, subject]) await addMember(owner, wsId, who, 'member');
    space = await project(owner, wsId, 'Switch space', 'workspace');
  });

  test('it is on by default, and the person\'s own account says so', async () => {
    assert.equal(await me(subject), true);
    await seed(subject, '4 minutes');
    assert.ok(await shown());
  });

  test('off erases the time held, hides the line from every list, and nothing writes it while it is off', async () => {
    expectStatus(await subject.browser.request('PUT', ME_LAST_ACTIVE_PATH, { body: { show: false } }), 204);
    assert.equal(await me(subject), false);
    assert.equal(await lastActive(subject), null, 'the time Flux held is gone');
    assert.equal(await shown(), undefined, 'the space\'s people carry none');
    assert.equal((await members(reader, wsId)).find((entry) => entry.userId === subject.id)?.lastActiveAt, undefined, 'the company\'s people carry none');
    assert.equal(await personLastActive(db).touch(subject.id), false, 'not even a statement that is allowed to write does');
    for (let n = 0; n < 5; n += 1) expectStatus(await subject.browser.request('GET', ME_PATH), 200);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await lastActive(subject), null, 'a person who is using Flux leaves no time while it is off');
  });

  test('on again starts from now', async () => {
    expectStatus(await subject.browser.request('PUT', ME_LAST_ACTIVE_PATH, { body: { show: true } }), 204);
    assert.equal(await me(subject), true);
    const at = await shown();
    assert.ok(at && Date.now() - new Date(at).getTime() < 5 * 60_000, 'shown as active now');
  });

  test('the switch takes a boolean and a signed-in person only', async () => {
    assert.equal((await subject.browser.request('PUT', ME_LAST_ACTIVE_PATH, { body: { show: 'no' } })).status, 400);
    assert.equal((await subject.browser.request('PUT', ME_LAST_ACTIVE_PATH, { body: {} })).status, 400);
    assert.equal((await new Browser().request('PUT', ME_LAST_ACTIVE_PATH, { body: { show: false } })).status, 401);
  });
});
