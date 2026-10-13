import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { admit, emptyRoom, enroll, stateCharge } from '../../apps/server/src/editing/codec/codec.mjs';
import { AdmissionBudget } from '../../apps/server/src/editing/codec/admission-budget.mjs';
import { CAPS } from '../../apps/server/src/editing/codec/caps.mjs';
import type { CodecEnvelope, CodecState } from '../../apps/server/src/editing/codec/types.js';

// #228 Gate 4: an admission measures the state it produced once and returns that charge, so the API
// thread binds and caches the state without serializing the whole growing state again. The charge
// must be exactly stateCharge of the result, across inserts, deletions, replacements and no-ops.
test('the charge an admission returns is exactly stateCharge of its result state, change after change', () => {
  const doc = new Y.Doc();
  let state = enroll(emptyRoom('room', 'generation', 'workspace'), 'actor-a', doc.clientID, true) as CodecState;
  Y.applyUpdate(doc, Buffer.from(state.checkpoint, 'base64'), 'confirmed');
  const text = doc.getText('body');
  let charge = stateCharge(state);
  let seed = 7;
  const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
  const pieces = ['a', 'Keep the field notes "quoted"\n', '\\path\t', '😀', 'ö', 'x'.repeat(300), '\u0001'];
  let changed = 0;
  for (let step = 1; step <= 160; step++) {
    const updates: Uint8Array[] = [];
    const record = (bytes: Uint8Array) => updates.push(Uint8Array.from(bytes));
    doc.on('update', record);
    try {
      doc.transact(() => {
        const length = text.length;
        const kind = random(4);
        if (length && kind === 0) text.delete(random(length), 1 + random(Math.min(3, length)));
        else if (length && kind === 1) { const at = random(length); text.delete(at, 1); text.insert(at, pieces[random(pieces.length)]!); }
        else text.insert(length ? random(length + 1) : 0, pieces[random(pieces.length)]!);
      });
    } finally { doc.off('update', record); }
    if (!updates.length) continue;
    const envelope: CodecEnvelope = { workspace: 'workspace', kind: 'wiki', room: 'room', generation: 'generation', actor: 'actor-a',
      operation: 'text', uuid: `operation-${step}`, replica: doc.clientID, parameters: null };
    const result = admit(state, envelope, Y.mergeUpdates(updates), true, charge);
    assert.equal(result.charge, stateCharge(result.state), `step ${step}`);
    if (!result.receiptOnly) changed++;
    state = result.state; charge = result.charge;
  }
  assert.ok(changed > 100 && state.nodes.length > 5 && state.deleted.length > 50, `the history grew: ${changed} ${state.nodes.length} ${state.deleted.length}`);
});

test('a given input charge is the one checked against the room cap', () => {
  const doc = new Y.Doc();
  const state = enroll(emptyRoom('room', 'generation', 'workspace'), 'actor-a', doc.clientID, true) as CodecState;
  Y.applyUpdate(doc, Buffer.from(state.checkpoint, 'base64'), 'confirmed');
  const updates: Uint8Array[] = [];
  doc.on('update', (bytes: Uint8Array) => updates.push(Uint8Array.from(bytes)));
  doc.getText('body').insert(0, 'x');
  const envelope: CodecEnvelope = { workspace: 'workspace', kind: 'wiki', room: 'room', generation: 'generation', actor: 'actor-a',
    operation: 'text', uuid: 'operation-1', replica: doc.clientID, parameters: null };
  assert.throws(() => admit(state, envelope, Y.mergeUpdates(updates), true, CAPS.roomCacheBytes + 1), /ROOM_CACHE_LIMIT/);
  assert.equal(admit(state, envelope, Y.mergeUpdates(updates), true, -1).charge !== undefined, true, 'an invalid charge is measured instead');
});

test('a known charge binds as given; without one the budget serializes the state as before', () => {
  const state = emptyRoom('room', 'generation', 'workspace') as CodecState;
  const budget = new AdmissionBudget();
  const bound = (knownCharge?: number) => {
    const lease = budget.reservePending(new Uint8Array(4));
    try { budget.bind(lease, state, knownCharge); return lease.charge; } finally { budget.release(lease); }
  };
  assert.equal(bound(), stateCharge(state));
  assert.equal(bound(stateCharge(state)), stateCharge(state));
  assert.equal(bound(-1), stateCharge(state), 'an invalid known charge is ignored');
  assert.throws(() => bound(CAPS.roomCacheBytes + 1), /ROOM_CACHE_LIMIT/, 'a known charge still respects the reservation');
  assert.equal(budget.bytes, 0);
});
