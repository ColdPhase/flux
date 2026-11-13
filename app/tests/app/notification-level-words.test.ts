import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTIFICATION_LEVELS, NOTIFICATION_REASONS } from '@flux/contracts';
import { channelsOf } from '@flux/core';
import { LEVEL_REASONS, LEVELS, REASON_WORDS } from '../../apps/web/src/notifications/levels.js';

// Settings › Notifications › Tell me about (#1173): the line under each level names what reaches the person at that level by push and
// email, no more and no less. The rules are core's (`channelsOf`); the words are the settings page's.

const sent = (level: (typeof NOTIFICATION_LEVELS)[number]) => NOTIFICATION_REASONS.filter((reason) => channelsOf({ level, emailMe: true })[reason].push);

test('each level names exactly the reasons that interrupt at that level', () => {
  for (const level of NOTIFICATION_LEVELS) assert.deepEqual([...LEVEL_REASONS[level]].sort(), [...sent(level)].sort(), level);
  // Email goes to no reason that push does not reach, so naming what pushes names what is emailed too.
  for (const level of NOTIFICATION_LEVELS) {
    for (const reason of NOTIFICATION_REASONS) if (channelsOf({ level, emailMe: true })[reason].email) assert.ok(LEVEL_REASONS[level].includes(reason), `${level} emails ${reason}`);
  }
});

test('the lines say it in words, every reason once', () => {
  const line = (id: string) => LEVELS.find((level) => level.id === id)!.detail;
  assert.deepEqual(LEVELS.map((level) => level.id), [...NOTIFICATION_LEVELS]);
  assert.equal(line('needsYou'), 'Questions, mentions, messages to you, tasks that need you, decisions about your work, invitations to work together and agents waiting for you');
  assert.equal(line('everything'), 'Also every reply in conversations you are part of and calls started in your spaces');
  assert.equal(line('nothing'), 'No push or email. Everything still waits in the Inbox');
  for (const reason of LEVEL_REASONS.needsYou) assert.ok(line('needsYou').toLowerCase().includes(REASON_WORDS[reason]), reason);
  // Nothing is promised that is not sent: no word of a reason that does not interrupt at Only what needs me.
  for (const reason of NOTIFICATION_REASONS.filter((item) => !LEVEL_REASONS.needsYou.includes(item))) assert.ok(!line('needsYou').includes(REASON_WORDS[reason]), reason);
  for (const words of ['blocked', 'Decisions,']) assert.ok(!line('needsYou').includes(words), `the line does not promise "${words}"`);
  // F-036 item 10 (#1186): an agent waiting for your OK is one of the reasons Only what needs me sends, and its words say so.
  assert.ok(LEVEL_REASONS.needsYou.includes('approval'));
  assert.ok(line('needsYou').endsWith('and agents waiting for you'));
});
