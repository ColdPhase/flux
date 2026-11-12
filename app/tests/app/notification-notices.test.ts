import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { dmMessagesPath, workspaceDmsPath, type InboxItem } from '@flux/contracts';
import { localMinutes } from '@flux/core';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';
import { StreamClient } from './support/stream.js';

// The open tab's notice (#1243): the real worker stores the notification and, when it interrupts its person (the level, quiet hours and
// mutes, as push), announces it on the live stream to that person alone as `dm.notice.v1`, with the notification's id. The one-item read
// names who it comes from, for the card's face.

const prefs = async (someone: Person, change: object) => expectStatus(await someone.browser.request('PATCH', '/api/v1/notification-preferences', { body: change }), 200);
const send = async (from: Person, dmId: string, body: string) =>
  expectStatus(await from.browser.request('POST', dmMessagesPath(dmId), { body: { body, clientMessageId: randomUUID() } }), 201);
async function generatorCaughtUp() {
  const target = Number((await pool.query('SELECT max(seq) AS seq FROM events')).rows[0].seq);
  await waitFor(async () => Number((await pool.query("SELECT seq FROM notification_cursor WHERE id = 'generator'")).rows[0].seq) >= target, 'the generator to catch up');
}
function quietNow() {
  const start = (localMinutes(new Date(), 'UTC') + 1440 - 30) % 1440;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { enabled: true, start: clock(start), end: clock((start + 120) % 1440), timeZone: 'UTC' };
}

describe('the notice on an open tab (#1243)', () => {
  test('a direct message is announced to its recipient alone, by the notification id, and the item names its sender; quiet hours and a mute hold it', async () => {
    const ada = await person('notice-ada');
    const jonas = await person('notice-jonas');
    const ws = await workspace(ada, 'Notices');
    await addMember(ada, ws.id, jonas, 'member');
    const dm = expectStatus(await jonas.browser.request('POST', workspaceDmsPath(ws.id), { body: { participantIds: [ada.id] } }), 201) as { id: string };

    const adaTab = await StreamClient.connect(ada.browser);
    const jonasTab = await StreamClient.connect(jonas.browser);
    await Promise.all([adaTab.ready(), jonasTab.ready()]);
    try {
      await send(jonas, dm.id, 'Can you check the probe readings before Friday?');
      const notice = await adaTab.event(dm.id, 'dm.notice.v1', 10_000);
      const item = expectStatus(await ada.browser.request('GET', `/api/v1/inbox/${notice.id}`), 200) as InboxItem;
      assert.equal(item.reason, 'dm');
      assert.equal(item.source.id, dm.id);
      assert.deepEqual(item.from, { kind: 'human', name: 'notice-jonas' }, 'the item names its sender');
      assert.match(item.body, /probe readings/);

      await generatorCaughtUp();
      assert.equal(jonasTab.events.filter((event) => event.kind.endsWith('.notice.v1')).length, 0, 'the sender is never told');
      expectStatus(await jonas.browser.request('GET', `/api/v1/inbox/${notice.id}`), 404);

      // Quiet hours: the Inbox keeps the row, the tab is not interrupted.
      await prefs(ada, { quietHours: quietNow() });
      await send(jonas, dm.id, 'Still there?');
      await generatorCaughtUp();
      const rows = Number((await pool.query(`SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND reason = 'dm'`, [ada.id])).rows[0].n);
      assert.equal(rows, 2, 'both messages are in the Inbox');
      assert.equal(adaTab.events.filter((event) => event.kind === 'dm.notice.v1').length, 1, 'no notice during quiet hours');

      // The level Nothing: no notice either.
      await prefs(ada, { level: 'nothing', quietHours: { enabled: false } });
      await send(jonas, dm.id, 'One more');
      await generatorCaughtUp();
      assert.equal(adaTab.events.filter((event) => event.kind === 'dm.notice.v1').length, 1, 'no notice at Nothing');

      // Back to Only what needs me: announced again.
      await prefs(ada, { level: 'needsYou' });
      await send(jonas, dm.id, 'Found it, thanks');
      await adaTab.until(() => adaTab.events.filter((event) => event.kind === 'dm.notice.v1').length === 2 || null, 10_000, 'the second notice');
    } finally {
      await Promise.all([adaTab.close(), jonasTab.close()]);
    }
  });
});
