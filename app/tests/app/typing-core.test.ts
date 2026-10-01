import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTypingCommand, TypingPresence, type TypingPulse } from '@flux/core';
import type { TypingContext } from '@flux/contracts';

const a: TypingContext = { kind: 'conversation', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const b: TypingContext = { kind: 'conversation', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
const pulse = (changes: Partial<TypingPulse> = {}): TypingPulse => ({ connectionId: 'connection1', actorId: 'human1', sessionId: 'session1', context: a, sequence: 1, active: true, expiresAt: 5000, ...changes });
function store(limits = { contexts: 128, perContext: 512, entries: 4096 }) {
  const state = new TypingPresence(limits); state.watch(a); state.setAvailable(true); return state;
}

test('typing closed input rejects forged identity/text recursively, without echoing private values', () => {
  assert.deepEqual(normalizeTypingCommand({ type: 'watch', context: { ...a, id: a.id.toUpperCase() } }), { type: 'watch', context: a });
  for (const field of ['author', 'session', 'text', 'expiresAt', 'name']) {
    assert.throws(() => normalizeTypingCommand({ type: 'active', active: true, [field]: 'secret-draft' }), (error: unknown) => error instanceof Error && !error.message.includes('secret-draft'));
    assert.throws(() => normalizeTypingCommand({ type: 'watch', context: { ...a, [field]: 'secret-draft' } }));
  }
  for (const malformed of [null, [], { type: 'active', active: 1 }, { type: 'leave', context: a }, { type: 'watch', context: { kind: 'project', id: a.id } }]) assert.throws(() => normalizeTypingCommand(malformed));
});

test('coalesced newer B withdraws A before unwatched B filtering; late A never resurrects', () => {
  const state = store(); state.accept(pulse(), 0, 0);
  assert.equal(state.candidates(a, 0, 0).pulses.length, 1);
  // A stop has been coalesced out by the transport: the B update must remove A itself.
  assert.equal(state.accept(pulse({ context: b, sequence: 3, expiresAt: 5500 }), 500, 500), false);
  assert.deepEqual(state.candidates(a, 500, 500).pulses, []);
  state.accept(pulse({ sequence: 2, expiresAt: 5200 }), 500, 500);
  assert.deepEqual(state.candidates(a, 500, 500).pulses, []);
  assert.equal(state.work.entries, 1);
});

test('a stop survives delayed active, different-session substitution and database clock reversal', () => {
  const state = store(); state.accept(pulse(), 0, 0);
  state.accept(pulse({ active: false, sequence: 3, expiresAt: 5500 }), 500, 500);
  assert.equal(state.accept(pulse({ sequence: 2, expiresAt: 5200 }), 500, 600), false);
  assert.equal(state.accept(pulse({ sequence: 4, sessionId: 'other-session', expiresAt: 5600 }), 600, 700), false);
  assert.equal(state.accept(pulse({ sequence: 4, expiresAt: 5400 }), 400, 800), false);
  assert.deepEqual(state.candidates(a, 400, 800).pulses, []);
  // Monotonic retention expires even though database wall time has moved backwards.
  assert.equal(state.candidates(a, 100, 5500).pulses.length, 0);
  assert.equal(state.work.entries, 0);
});

test('listener loss/reconnect clears presence and invalidates pending revision; no replay', () => {
  const state = store(); state.accept(pulse(), 0, 0);
  const revision = state.candidates(a, 0, 0).revision;
  state.setAvailable(false);
  assert.notEqual(state.revision, revision);
  assert.equal(state.candidates(a, 0, 0).availability, 'unavailable');
  assert.equal(state.accept(pulse({ sequence: 2 }), 0, 0), false);
  state.setAvailable(true);
  assert.deepEqual(state.candidates(a, 0, 0).pulses, []);
  assert.equal(state.work.entries, 0);
});

test('context saturation is unknown, preserves sequence fences, and bounds moving connections', () => {
  const state = store({ contexts: 2, perContext: 1, entries: 3 }); state.watch(b);
  state.accept(pulse(), 0, 0);
  state.accept(pulse({ connectionId: 'connection2', actorId: 'human2', sessionId: 'session2', context: b }), 0, 0);
  assert.equal(state.accept(pulse({ context: b, sequence: 2, expiresAt: 5100 }), 100, 100), false);
  assert.deepEqual(state.candidates(a, 100, 100).pulses, []);
  assert.equal(state.candidates(b, 100, 100).availability, 'unavailable');
  assert.equal(state.work.entries, 2);
  state.accept(pulse(), 100, 100);
  assert.deepEqual(state.candidates(a, 100, 100).pulses, []);
  assert.equal(state.accept(pulse({ context: b, sequence: 3, expiresAt: 5200 }), 200, 200), false);
  assert.equal(state.work.entries, 2);
});

test('global saturation cannot silently evict a stop then replay older activity; recovery drains', () => {
  const state = store({ contexts: 1, perContext: 2, entries: 1 });
  state.accept(pulse(), 0, 0);
  state.accept(pulse({ active: false, sequence: 3, expiresAt: 5100 }), 100, 100);
  state.accept(pulse({ connectionId: 'connection2', actorId: 'human2', sessionId: 'session2', expiresAt: 5200 }), 200, 200);
  assert.equal(state.candidates(a, 200, 200).availability, 'unavailable');
  assert.equal(state.work.entries, 1);
  state.accept(pulse({ sequence: 2, expiresAt: 5000 }), 200, 200);
  assert.equal(state.work.entries, 1);
  assert.equal(state.candidates(a, 5200, 5200).availability, 'ready');
  assert.equal(state.work.entries, 0);
  assert.equal(state.accept(pulse({ sequence: 4, expiresAt: 10_300 }), 5300, 5300), true);
});

test('unwatched foreign contexts never allocate state; bounded watchers retain until last leave', () => {
  const state = store({ contexts: 1, perContext: 2, entries: 2 });
  assert.equal(state.watch(b), false);
  for (let i = 0; i < 1000; i++) state.accept(pulse({ connectionId: `foreign-${i}`, context: b }), 0, 0);
  assert.equal(state.work.entries, 0);
  state.watch(a); state.accept(pulse(), 0, 0); state.leave(a);
  assert.equal(state.candidates(a, 0, 0).pulses.length, 1);
  state.leave(a);
  assert.equal(state.candidates(a, 0, 0).availability, 'unavailable');
  state.watch(a);
  assert.deepEqual(state.candidates(a, 0, 0).pulses, []);
  state.accept(pulse({ sequence: 1 }), 0, 0);
  assert.deepEqual(state.candidates(a, 0, 0).pulses, []);
});

test('expiry, caller mutation and invalid sequence cannot extend a pulse or alter its native scope', () => {
  const state = store(); const update = pulse(); state.accept(update, 0, 0);
  update.context = b; update.actorId = 'forged';
  const candidates = state.candidates(a, 0, 0); candidates.pulses[0]!.context = b;
  assert.equal(state.candidates(a, 0, 0).pulses[0]!.actorId, 'human1');
  for (const sequence of [NaN, Infinity, -1, 0, 1.5]) assert.equal(state.accept(pulse({ sequence }), 0, 0), false);
  assert.equal(state.accept(pulse({ sequence: 2, expiresAt: 6000 }), 0, 0), false);
  assert.deepEqual(state.candidates(a, 5000, 1000).pulses, []);
  assert.equal(state.work.entries, 0);
});
