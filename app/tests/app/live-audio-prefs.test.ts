import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIO_KEY, DEFAULT_PREFS, clampVolume, meterLevel, meterWord, missingDeviceNote, normalizePrefs, personSound, readPrefs, resolveDevice,
  voiceLevel, withPerson, writePrefs, type AudioPrefs, type PrefsStorage,
} from '../../apps/web/src/live/audio-prefs.js';

function store(initial?: string): PrefsStorage & { value: string | null } {
  const box = { value: initial ?? null };
  return Object.assign(box, {
    getItem: () => box.value,
    setItem: (_key: string, value: string) => { box.value = value; },
  });
}

test('a new device starts at 100 % with noise, echo and gain handling on', () => {
  const prefs = readPrefs(store());
  assert.deepEqual(prefs, DEFAULT_PREFS);
  assert.equal(prefs.micVolume, 100);
  assert.equal(prefs.autoGain, true);
});

test('volumes are whole percents inside their range; anything else falls back', () => {
  assert.equal(clampVolume(120.4), 120);
  assert.equal(clampVolume(-5), 0);
  assert.equal(clampVolume(900), 200);
  assert.equal(clampVolume(150, 100), 100);
  assert.equal(clampVolume('loud'), 100);
  assert.equal(clampVolume(Number.NaN, 200, 80), 80);
  const prefs = normalizePrefs({ micVolume: 999, masterVolume: 150, noiseSuppression: 'yes', micId: 7 });
  assert.equal(prefs.micVolume, 200);
  assert.equal(prefs.masterVolume, 100);
  assert.equal(prefs.noiseSuppression, true);
  assert.equal(prefs.micId, null);
});

test('settings survive a write and a read, and a damaged or blocked store never throws', () => {
  const box = store();
  const chosen: AudioPrefs = { ...DEFAULT_PREFS, micId: 'mic-b', micLabel: 'USB microphone', micVolume: 120, echoCancellation: false, speakerId: 'spk-2', masterVolume: 60 };
  assert.equal(writePrefs(box, withPerson(chosen, 'u_nia', { volume: 80 })), true);
  assert.ok(box.value?.includes('mic-b'));
  const back = readPrefs(box);
  assert.equal(back.micId, 'mic-b');
  assert.equal(back.micVolume, 120);
  assert.equal(back.echoCancellation, false);
  assert.equal(back.masterVolume, 60);
  assert.deepEqual(personSound(back, 'u_nia'), { volume: 80, muted: false });

  assert.deepEqual(readPrefs(store('{not json')), DEFAULT_PREFS);
  assert.deepEqual(readPrefs(store('[1,2]')), DEFAULT_PREFS);
  const blocked: PrefsStorage = { getItem: () => { throw new DOMException('blocked', 'SecurityError'); }, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
  assert.deepEqual(readPrefs(blocked), DEFAULT_PREFS);
  assert.equal(writePrefs(blocked, chosen), false);
  assert.deepEqual(readPrefs(null), DEFAULT_PREFS);
  assert.equal(AUDIO_KEY, 'flux.live.audio');
});

test('a person at 100 % who is not muted has no entry, and the newest changes are kept', () => {
  let prefs = withPerson(DEFAULT_PREFS, 'a', { volume: 150 });
  assert.deepEqual(prefs.people, { a: { volume: 150, muted: false } });
  prefs = withPerson(prefs, 'a', { volume: 100 });
  assert.deepEqual(prefs.people, {});
  prefs = withPerson(prefs, 'b', { muted: true });
  assert.deepEqual(personSound(prefs, 'b'), { volume: 100, muted: true });
  assert.deepEqual(personSound(prefs, 'nobody'), { volume: 100, muted: false });
  for (let index = 0; index < 230; index++) prefs = withPerson(prefs, `p${index}`, { volume: 50 });
  assert.equal(Object.keys(prefs.people).length, 200);
  assert.ok(prefs.people.p229);
  assert.equal(prefs.people.p0, undefined);
  assert.equal(Object.keys(normalizePrefs(JSON.parse(JSON.stringify(prefs))).people).length, 200);
});

test('a voice plays at the master volume times the person volume, silent when muted, and never above what the output can reach', () => {
  const prefs: AudioPrefs = { ...DEFAULT_PREFS, masterVolume: 50, people: { nia: { volume: 160, muted: false }, kai: { volume: 80, muted: true } } };
  assert.equal(voiceLevel(prefs, 'nia'), 0.8);
  assert.equal(voiceLevel(prefs, 'kai'), 0);
  assert.equal(voiceLevel(prefs, 'someone'), 0.5);
  const loud: AudioPrefs = { ...prefs, masterVolume: 100 };
  assert.equal(voiceLevel(loud, 'nia'), 1.6);
  assert.equal(voiceLevel(loud, 'nia', 1), 1);
});

test('a remembered device that is gone falls back to the default and says so; before the list is known the choice is kept', () => {
  const list = [{ id: 'default', label: 'Default' }, { id: 'a', label: 'Headphones' }];
  assert.deepEqual(resolveDevice(list, 'a'), { id: 'a', missing: false });
  assert.deepEqual(resolveDevice(list, 'gone'), { id: null, missing: true });
  assert.deepEqual(resolveDevice(list, null), { id: null, missing: false });
  assert.deepEqual(resolveDevice(list, 'default'), { id: null, missing: false });
  assert.deepEqual(resolveDevice([], 'a'), { id: 'a', missing: false });
  assert.deepEqual(resolveDevice([{ id: '', label: '' }], 'a'), { id: 'a', missing: false });
  assert.equal(missingDeviceNote('speakers', 'Headphones'), '“Headphones” was disconnected. Sound plays through the default output.');
  assert.equal(missingDeviceNote('speakers', null), 'The speakers or headphones were disconnected. Sound plays through the default output.');
  assert.equal(missingDeviceNote('microphone', 'USB microphone'), '“USB microphone” was disconnected. Flux uses the default microphone.');
});

test('the meter shows the capture times the volume and says one word', () => {
  assert.equal(meterLevel(0, 100), 0);
  assert.equal(meterLevel(0.5, 0), 0);
  assert.ok(meterLevel(0.1, 100) > meterLevel(0.01, 100));
  assert.ok(meterLevel(0.05, 200) > meterLevel(0.05, 100));
  assert.equal(meterLevel(1, 200), 1);
  assert.equal(meterWord(meterLevel(0.0005, 100)), 'Quiet');
  assert.equal(meterWord(meterLevel(0.05, 100)), 'Speaking');
  assert.equal(meterWord(meterLevel(0.05, 0)), 'Quiet');
});
