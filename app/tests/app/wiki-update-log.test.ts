import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { admit, emptyRoom, enroll, ledgerDelta, rebuild } from '../../apps/server/src/editing/codec/codec.mjs';
import type { CodecEnvelope, CodecLedgerDelta, CodecState } from '../../apps/server/src/editing/codec/types.js';

// Founder direction 2026-10-09 (B1): a commit appends its update and the ledger entries it added;
// the state at the head is a snapshot plus that log. These are the pure codec properties.
interface Entry { sequence: number; bytes: Uint8Array; ledger: CodecLedgerDelta }
const code = (wanted: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === wanted;
const envelope = (actor: string, replica: number, uuid: string): CodecEnvelope =>
  ({ workspace: 'w', kind: 'wiki', room: 'r', generation: 'g', actor, operation: 'text', uuid, replica, parameters: null });
function admitted(state: CodecState, value: CodecEnvelope, bytes: Uint8Array) {
  const result = admit(state, value, bytes, true) as { state: CodecState; receipt: { semanticNoop: boolean } };
  return result;
}

/** A 10k room with two writers making seeded random inserts, deletions and replacements. */
function session(steps: number, seed = 7) {
  // mulberry32: a small seeded generator with exact 32-bit integer arithmetic.
  let random = seed;
  const next = (limit: number) => {
    random = (random + 0x6d2b79f5) | 0;
    let value = Math.imul(random ^ (random >>> 15), 1 | random);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) % Math.max(1, limit);
  };
  const server = new Y.Doc(); server.getText('body').insert(0, 'A'.repeat(9_999) + 'B');
  let state = enroll(emptyRoom('r', 'g', 'w'), 'server', server.clientID, true);
  state = admitted(state, envelope('server', server.clientID, 'baseline'), Y.encodeStateAsUpdate(server)).state;
  const writers = ['ada', 'kai'].map((actor) => {
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(state.checkpoint, 'base64'));
    state = enroll(state, actor, doc.clientID, true);
    return { actor, doc, vector: Y.encodeStateVector(doc) };
  });
  const states = [state]; const entries: Entry[] = []; let noops = 0;
  for (let step = 0; step < steps; step++) {
    const writer = writers[step % 2]!; const text = writer.doc.getText('body');
    const kind = next(4);
    if (kind === 0) text.insert(next(text.length + 1), String.fromCharCode(97 + next(26)).repeat(1 + next(3)));
    else if (kind === 1 && text.length > 10) text.delete(next(text.length - 5), 1 + next(4));
    else if (kind === 2) { text.delete(text.length - 1, 1); text.insert(text.length, String.fromCharCode(97 + step % 26)); }
    // kind 3 re-sends what the server already has: a semantic no-op.
    const bytes = kind === 3 ? Y.encodeStateAsUpdate(writer.doc) : Y.encodeStateAsUpdate(writer.doc, writer.vector);
    writer.vector = Y.encodeStateVector(writer.doc);
    const result = admitted(state, envelope(writer.actor, writer.doc.clientID, `u-${step}`), bytes);
    if (result.receipt.semanticNoop) { noops++; assert.equal(result.state, state, 'A no-op leaves the state as it was'); continue; }
    entries.push({ sequence: result.state.sequence, bytes, ledger: ledgerDelta(state, result.state) });
    state = result.state; states.push(state);
    // The other writer receives the confirmed update, as a live client does.
    const other = writers[(step + 1) % 2]!; Y.applyUpdate(other.doc, bytes); other.vector = Y.encodeStateVector(other.doc);
  }
  return { states, entries, final: state, noops, writers };
}

function sameState(actual: CodecState, expected: CodecState) {
  for (const field of ['sequence', 'body', 'nodes', 'deleted', 'splits', 'enrollments', 'workspace', 'room', 'generation'] as const) {
    assert.deepEqual(actual[field], expected[field], field);
  }
  const a = new Y.Doc(); const b = new Y.Doc();
  try {
    Y.applyUpdate(a, Buffer.from(actual.checkpoint, 'base64')); Y.applyUpdate(b, Buffer.from(expected.checkpoint, 'base64'));
    assert.equal(a.getText('body').toString(), b.getText('body').toString());
    assert.deepEqual(Y.decodeStateVector(Y.encodeStateVector(a)), Y.decodeStateVector(Y.encodeStateVector(b)));
  } finally { a.destroy(); b.destroy(); }
}

test('a snapshot plus the logged ledger entries after it rebuilds exactly the state the commits produced', () => {
  const { states, entries, final, noops } = session(160);
  assert.ok(entries.length > 100 && noops > 0, `the session covers changes (${entries.length}) and semantic no-ops (${noops})`);
  for (const at of [0, 1, 37, 64, entries.length - 1, entries.length]) {
    sameState(rebuild(states[at]!, entries.slice(at), final.body), final);
  }
});

test('the codec state no longer grows with receipts or a journal: those live in the log rows', () => {
  const { states, final } = session(120);
  assert.equal('receipts' in final, false); assert.equal('journal' in final, false);
  const first = JSON.stringify(states[1]).length; const last = JSON.stringify(final).length;
  const perCommit = (last - first) / (final.sequence - states[1]!.sequence);
  // Each commit adds only its own ledger entries (here about two hundred bytes), not a receipt and journal entry each.
  assert.ok(perCommit < 400, `state grew ${perCommit.toFixed(0)} bytes per commit`);
});

test('a rebuild refuses a gap, a changed ledger and a body that disagrees with the head', () => {
  const { states, entries, final } = session(40);
  assert.throws(() => rebuild(states[0]!, [entries[0]!, entries[2]!]), code('LOG_GAP'));
  const tampered = entries.map((entry, index) => index === 3 ? { ...entry, ledger: { ...entry.ledger, nodes: [] } } : entry);
  if (entries[3]!.ledger.nodes.length) assert.throws(() => rebuild(states[0]!, tampered), code('LOG_STATE_MISMATCH'));
  assert.throws(() => rebuild(states[0]!, entries, `${final.body}x`), code('LOG_STATE_MISMATCH'));
  assert.throws(() => rebuild(states[0]!, entries.map((entry) => ({ ...entry, ledger: { ...entry.ledger, deleted: [{ client: 1, clock: 0, length: 0, actor: 'x', admittedSequence: entry.sequence }] } }))), code('INVALID_LEDGER_DELTA'));
  assert.throws(() => ledgerDelta(final, final), code('INVALID_LEDGER_DELTA'));
});
