import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PREFERENCES, InvalidInputError, applyPreferenceChange } from '@flux/core';

// The two sound switches (founder decision, 2026-11-12, #1243): messages off and calls on by default, each changed on its own.

test('the sound switches start as messages off and calls on, change one at a time, and refuse anything but true or false', () => {
  assert.equal(DEFAULT_PREFERENCES.soundMessages, false);
  assert.equal(DEFAULT_PREFERENCES.soundCalls, true);
  const on = applyPreferenceChange({ ...DEFAULT_PREFERENCES }, { sound: { messages: true } });
  assert.deepEqual([on.soundMessages, on.soundCalls], [true, true]);
  const off = applyPreferenceChange(on, { sound: { calls: false } });
  assert.deepEqual([off.soundMessages, off.soundCalls], [true, false]);
  assert.throws(() => applyPreferenceChange(off, { sound: { messages: 1 as never } }), (error: unknown) => error instanceof InvalidInputError && error.code === 'INVALID_SOUND');
  assert.throws(() => applyPreferenceChange(off, { sound: null as never }), (error: unknown) => error instanceof InvalidInputError && error.code === 'INVALID_SOUND');
});
