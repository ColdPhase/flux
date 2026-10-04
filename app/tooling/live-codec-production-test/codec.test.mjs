import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { yCollab } from 'y-codemirror.next';
import { Awareness } from 'y-protocols/awareness';
import { CAPS } from './caps.mjs';
import { canonical, emptyRoom, enroll, fingerprint, stateCharge } from './codec.mjs';
import { CodecPool } from './worker-pool.mjs';
import { item, wire } from './wire-fixtures.mjs';
import { RoomCache } from './room-cache.mjs';
import { Assemblies, packet } from './assembly.mjs';
import { IntentRegistry } from './intent-registry.mjs';
import { AdmissionBudget } from './admission-budget.mjs';

const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
function capture(doc, change) {
  const updates = [];
  const record = (bytes) => updates.push(Uint8Array.from(bytes));
  doc.on('update', record);
  try { change(); } finally { doc.off('update', record); }
  return Y.mergeUpdates(updates);
}
function harness(t) {
  const pool = new CodecPool(); const clients = []; let counter = 0;
  const h = { state: emptyRoom(), pool, intents: new IntentRegistry() };
  t.after(async () => { for (const client of clients) client.doc.destroy(); await h.intents.close(); await pool.close(); });
  h.client = (actor = 'actor-a', { text = true } = {}) => {
    // Public clientID is read once. Enrollment precedes getText, editor, and all local structs.
    const doc = new Y.Doc();
    h.state = enroll(h.state, actor, doc.clientID, true);
    Y.applyUpdate(doc, Buffer.from(h.state.checkpoint, 'base64'), 'confirmed');
    const client = { actor, doc, replica: doc.clientID, text: text ? doc.getText('body') : null };
    clients.push(client); return client;
  };
  h.envelope = (client, changes = {}) => ({ workspace: h.state.workspace, kind: h.state.kind,
    room: h.state.room, generation: h.state.generation, actor: client.actor,
    replica: client.replica, operation: 'text', uuid: `operation-${++counter}`, ...changes });
  h.accept = async (client, bytes, envelope = h.envelope(client)) => {
    const started = performance.now(); const result = await h.intents.run(pool, h.state, envelope, bytes);
    assert.equal(result.ok, true, result.code);
    assert.equal(result.workerLimits.maxOldGenerationSizeMb, CAPS.workerOldMiB);
    assert.equal(result.workerLimits.maxYoungGenerationSizeMb, CAPS.workerYoungMiB);
    h.state = result.state;
    t.diagnostic(`accepted bytes=${bytes.byteLength} bodyUnits=${h.state.body.length} wallMs=${(performance.now() - started).toFixed(2)}`);
    return result;
  };
  h.reject = async (client, bytes, code, envelope = h.envelope(client), options = {}) => {
    const before = digest(h.state); const registryBefore = digest(h.intents.bindings);
    let result;
    try { result = await h.intents.run(pool, h.state, envelope, bytes, options); }
    catch (error) { result = { ok: false, code: error.code }; }
    assert.equal(result.ok, false, 'candidate unexpectedly admitted');
    if (code) assert.equal(result.code, code);
    assert.equal(digest(h.state), before, 'confirmed state or receipts poisoned');
    assert.equal(digest(h.intents.bindings), registryBefore, 'confirmed intent binding poisoned');
    return result;
  };
  h.sync = (client) => Y.applyUpdate(client.doc, Buffer.from(h.state.checkpoint, 'base64'), 'confirmed');
  return h;
}

test('single compatible stable instance resolves the public CM6 binding (no DOM claim)', (t) => {
  const h = harness(t); const a = h.client(); const awareness = new Awareness(a.doc);
  t.after(() => awareness.destroy());
  const state = EditorState.create({ doc: '', extensions: [yCollab(a.text, awareness)] });
  assert.equal(state.doc.length, 0);
  assert.equal(a.replica, a.doc.clientID);
});

test('two concurrent authors converge in either admission order and own undo preserves peer text', async (t) => {
  const h = harness(t); const a = h.client('actor-a'); const b = h.client('actor-b');
  const undo = new Y.UndoManager(a.text, { trackedOrigins: new Set(['human-a']), captureTimeout: 0 });
  t.after(() => undo.destroy());
  const ua = capture(a.doc, () => a.doc.transact(() => a.text.insert(0, 'A'), 'human-a'));
  const ub = capture(b.doc, () => b.doc.transact(() => b.text.insert(0, 'B'), 'human-b'));
  const initial = JSON.parse(JSON.stringify(h.state));
  await h.accept(a, ua); await h.accept(b, ub); const orderAB = h.state.body;
  h.state = initial;
  await h.accept(b, ub); await h.accept(a, ua); assert.equal(h.state.body, orderAB);
  h.sync(a); h.sync(b); assert.equal(a.text.toString(), b.text.toString());
  const undone = capture(a.doc, () => undo.undo());
  await h.accept(a, undone); h.sync(b); assert.equal(h.state.body, 'B');
  const redone = capture(a.doc, () => undo.redo());
  await h.accept(a, redone); h.sync(b); assert.equal(h.state.body, orderAB);
});

test('durable enrollment, collisions and reconnect versus a fresh document', async (t) => {
  const h = harness(t); const a = h.client(); const id = a.doc.clientID;
  assert.throws(() => enroll(h.state, 'actor-b', id, true), { code: 'REPLICA_COLLISION' });
  assert.throws(() => enroll(h.state, 'actor-a', id, true), { code: 'REPLICA_COLLISION' });
  const oldPending = capture(a.doc, () => a.text.insert(0, 'offline'));
  const intent = h.envelope(a); h.state = JSON.parse(JSON.stringify(h.state));
  assert.equal(h.state.enrollments[String(id)].actor, a.actor);
  assert.equal(a.doc.clientID, id); // Same Doc survives transport reconnect.
  const fresh = h.client(); assert.notEqual(fresh.doc.clientID, id);
  // A fresh instance submits old exact bytes under durable old ownership, without changing its ID.
  await h.accept(a, oldPending, intent); const confirmed = digest(h.state);
  const replay = await h.accept(a, Uint8Array.from(oldPending), intent);
  assert.equal(replay.replay, true); assert.equal(digest(h.state), confirmed);
  h.sync(fresh); assert.equal(fresh.text.toString(), 'offline');
  const own = capture(fresh.doc, () => fresh.text.insert(fresh.text.length, '!'));
  await h.accept(fresh, own); assert.equal(h.state.body, 'offline!');
});

test('immutable retry namespace, bytes and full command parameters', async (t) => {
  const h = harness(t); const a = h.client();
  const update = capture(a.doc, () => a.text.insert(0, 'one')); const intent = h.envelope(a);
  await h.accept(a, update, intent);
  await h.reject(a, update, 'EDITING_IDEMPOTENCY_CONFLICT', { ...intent, parameters: { changed: true } });
  await h.reject(a, wire([item(a.replica, 0, 'two')]), 'EDITING_IDEMPOTENCY_CONFLICT', intent);
  for (const changed of [{ workspace: 'other' }, { kind: 'map' }, { room: 'other' }, { generation: 'old' }]) {
    await h.reject(a, update, 'EDITING_IDEMPOTENCY_CONFLICT', { ...intent, ...changed });
  }
  const save = { ...intent, operation: 'save', parameters: { expectedVersion: 4, generation: 'g',
    acknowledgedSequence: 2, title: 'Title', sectionIds: ['s'], sourceBindings: [{ id: 'x', revision: 1 }] } };
  const original = fingerprint(save, update);
  for (const field of Object.keys(save.parameters)) {
    assert.notEqual(fingerprint({ ...save, parameters: { ...save.parameters, [field]: null } }, update), original);
  }
  // Save fingerprint coverage is a helper proof only; SQL/Save execution belongs to gate 3.
});

test('known structs and ranges under new intents acknowledge without new journal or attribution', async (t) => {
  const h = harness(t); const a = h.client('actor-a');
  const original = capture(a.doc, () => a.text.insert(0, 'abc'));
  await h.accept(a, original); const b = h.client('actor-b');
  const journal = digest(h.state.journal); const nodes = digest(h.state.nodes);
  const duplicate = await h.accept(b, original);
  assert.equal(duplicate.receiptOnly, true); assert.equal(duplicate.receipt.semanticNoop, true);
  assert.equal(duplicate.receipt.provenance, null); assert.equal(h.state.sequence, 1);
  assert.equal(digest(h.state.journal), journal); assert.equal(digest(h.state.nodes), nodes);
  await h.accept(a, capture(a.doc, () => a.text.delete(1, 1)));
  const deletions = digest(h.state.deleted); const deletionJournal = digest(h.state.journal);
  const repeated = await h.accept(b, wire([], [{ client: a.replica, clock: 1, length: 1 }]));
  assert.equal(repeated.receiptOnly, true); assert.equal(repeated.receipt.provenance, null);
  assert.equal(h.state.sequence, 2); assert.equal(digest(h.state.deleted), deletions);
  assert.equal(digest(h.state.journal), deletionJournal);
  await h.accept(b, wire([], [{ client: a.replica, clock: 1, length: 2 }]));
  assert.equal(h.state.body, 'a'); assert.equal(h.state.sequence, 3);
  assert.deepEqual(h.state.deleted.map(({ clock, length, actor }) => ({ clock, length, actor })), [
    { clock: 1, length: 1, actor: 'actor-a' }, { clock: 2, length: 1, actor: 'actor-b' },
  ]);
});

test('a shared actor/UUID intent cannot migrate to another genuinely writable enrolled room', async (t) => {
  const h = harness(t); const a = h.client('actor-a'); const uuid = 'cross-room-command';
  const original = capture(a.doc, () => a.text.insert(0, 'first room'));
  const intent = h.envelope(a, { uuid }); await h.accept(a, original, intent);
  const second = new Y.Doc(); t.after(() => second.destroy());
  let secondState = emptyRoom('wiki-b'); secondState = enroll(secondState, a.actor, second.clientID, true);
  const secondBytes = capture(second, () => second.getText('body').insert(0, 'second room'));
  const secondIntent = { ...intent, room: secondState.room, replica: second.clientID };
  const originalRegistry = digest(h.intents.bindings); const originalState = digest(secondState);
  await assert.rejects(h.intents.run(h.pool, secondState, secondIntent, secondBytes), { code: 'EDITING_IDEMPOTENCY_CONFLICT' });
  assert.equal(digest(h.intents.bindings), originalRegistry); assert.equal(digest(secondState), originalState);
  // Reconstructed bindings retain scope/operation ownership, without claiming a SQL restart.
  h.intents = new IntentRegistry(JSON.parse(JSON.stringify(h.intents.bindings)));
  await assert.rejects(h.intents.run(h.pool, h.state, { ...intent, operation: 'save' }, original), { code: 'EDITING_IDEMPOTENCY_CONFLICT' });
  const replay = await h.accept(a, original, intent); assert.equal(replay.replay, true);
  assert.equal(h.state.sequence, 1);
});

test('current rights, actor ownership and generation reject replay and unseen pending safely', async (t) => {
  const h = harness(t); const a = h.client(); const b = h.client('actor-b');
  const update = capture(a.doc, () => a.text.insert(0, 'private')); const intent = h.envelope(a);
  await h.reject(a, update, 'CURRENT_WRITE_REQUIRED', intent, { canWrite: false });
  await h.reject(b, update, 'REPLICA_OWNERSHIP');
  await h.reject(a, update, 'ROOM_GENERATION', { ...intent, generation: 'old-generation' });
  await h.accept(a, update, intent);
  await h.reject(a, update, 'CURRENT_WRITE_REQUIRED', intent, { canWrite: false });
  // Enrollment is scoped durably; old-generation pending does not auto-enroll into a new room.
  const old = h.state; h.state = emptyRoom('wiki-a', 'new-generation');
  await h.reject(a, update, 'ROOM_GENERATION', intent); h.state = old;
});

test('forbidden roots, maps, arrays, attributes, embeds and subdocuments never poison confirmed text', async (t) => {
  const operations = [
    (doc) => doc.getText('secret').insert(0, 'hidden'),
    (doc) => doc.getMap('body').set('key', 'value'),
    (doc) => doc.getArray('body').insert(0, ['value']),
    (doc) => doc.getText('body').insert(0, 'rich', { bold: true }),
    (doc) => doc.getText('body').insertEmbed(0, { leak: true }),
    (doc) => doc.getMap('body').set('child', new Y.Doc()),
  ];
  for (const operation of operations) {
    const h = harness(t); const a = h.client('actor-a', { text: false });
    const update = capture(a.doc, () => operation(a.doc));
    await h.reject(a, update);
  }
});

test('unresolved hidden dependency stays refused when reordered or bundled', async (t) => {
  const h = harness(t); const a = h.client();
  const first = capture(a.doc, () => a.doc.getText('secret').insert(0, 'x'));
  const second = capture(a.doc, () => a.doc.getText('secret').insert(1, 'y'));
  await h.reject(a, second, 'UNRESOLVED_REFERENCE');
  await h.reject(a, first, 'EXTRA_ROOT');
  await h.reject(a, Y.mergeUpdates([second, first]), 'EXTRA_ROOT');
  assert.equal(h.state.body, '');
});

test('ordinary clock gaps require a complete bounded bundle; no pending-store shortcut', async (t) => {
  const h = harness(t); const a = h.client();
  const first = capture(a.doc, () => a.text.insert(0, 'x'));
  const second = capture(a.doc, () => a.text.insert(1, 'y'));
  await h.reject(a, second, 'UNRESOLVED_REFERENCE');
  await h.accept(a, Y.mergeUpdates([second, first])); assert.equal(h.state.body, 'xy');
});

test('unknown GC snapshots refuse; exact captured first-admission insert/delete bundle remains valid', async (t) => {
  const h = harness(t); const a = h.client();
  const first = capture(a.doc, () => a.text.insert(0, 'private pending'));
  const second = capture(a.doc, () => a.text.delete(0, a.text.length));
  await h.reject(a, Y.encodeStateAsUpdate(a.doc), 'UNPROVEN_NEW_TOMBSTONE');
  await h.accept(a, Y.mergeUpdates([first, second])); assert.equal(h.state.body, '');
  await h.accept(a, Y.encodeStateAsUpdate(a.doc)); assert.equal(h.state.body, '');
});

test('confirmed surrogate splits retain original provenance and accept public checkpoints only at proved cuts', async (t) => {
  const h = harness(t); const a = h.client();
  const original = capture(a.doc, () => a.text.insert(0, '🙂z'));
  await h.accept(a, original);
  await h.reject(a, wire([item(a.replica, 0, '\ufffd\ufffdz')]), 'ALTERED_DUPLICATE_CONTENT');
  await h.accept(a, capture(a.doc, () => a.text.delete(0, 1)));
  const immutable = digest(h.state.nodes); const journal = digest(h.state.journal);
  const checkpoint = await h.accept(a, Y.encodeStateAsUpdate(a.doc));
  assert.equal(checkpoint.receiptOnly, true); assert.equal(h.state.sequence, 2);
  assert.equal(h.state.body, '\ufffdz'); assert.equal(h.state.nodes[0].text, '🙂z');
  assert.equal(digest(h.state.nodes), immutable); assert.equal(digest(h.state.journal), journal);
  assert.deepEqual(h.state.splits, [{ client: a.replica, clock: 1 }]);
  await h.reject(a, wire([item(a.replica, 1, '\ufffdQ', { origin: { client: a.replica, clock: 0 }, parent: null })]), 'ALTERED_DUPLICATE_CONTENT');
  await h.reject(a, wire([item(a.replica, 0, '\ufffd\ufffdQ')]), 'ALTERED_DUPLICATE_CONTENT');
  const forwarded = await h.accept(a, original); assert.equal(forwarded.receiptOnly, true);
  assert.equal(digest(h.state.nodes), immutable); assert.equal(h.state.sequence, 2);
});

test('a peer insertion inside a surrogate establishes only that public split transformation', async (t) => {
  const h = harness(t); const a = h.client('actor-a');
  await h.accept(a, capture(a.doc, () => a.text.insert(0, '🙂')));
  const b = h.client('actor-b');
  await h.accept(b, capture(b.doc, () => b.text.insert(1, 'X')));
  assert.equal(h.state.body, '\ufffdX\ufffd'); assert.equal(h.state.nodes[0].text, '🙂');
  const before = digest(h.state.journal);
  const checkpoint = await h.accept(b, Y.encodeStateAsUpdate(b.doc));
  assert.equal(checkpoint.receiptOnly, true); assert.equal(digest(h.state.journal), before);
});

test('inconsistent duplicate intervals, parent origins and future references are refused', async (t) => {
  const h = harness(t); const a = h.client(); const b = h.client('actor-b');
  await h.accept(a, capture(a.doc, () => a.text.insert(0, 'abc')));
  await h.reject(a, wire([item(a.replica, 0, 'XYZ')]), 'ALTERED_DUPLICATE_CONTENT');
  await h.reject(a, wire([item(a.replica, 0, 'abc', { rightOrigin: { client: b.replica, clock: 0 } })]), 'UNRESOLVED_REFERENCE');
  await h.reject(a, wire([item(a.replica, 3, 'x', { origin: { client: a.replica, clock: 3 }, parent: null })]), 'FUTURE_OWN_REFERENCE');
  await h.reject(a, wire([item(a.replica, 4, 'x')]), 'CLOCK_GAP_OR_OVERLAP');
  await h.reject(b, wire([item(a.replica, 3, 'x', { origin: { client: a.replica, clock: 2 }, parent: null })]), 'REPLICA_OWNERSHIP');
});

test('future and partial unknown deletion ranges fail before disposable integration', async (t) => {
  const h = harness(t); const a = h.client();
  await h.accept(a, capture(a.doc, () => a.text.insert(0, 'abc')));
  await h.reject(a, wire([], [{ client: a.replica, clock: 2, length: 2 }]), 'UNRESOLVED_RANGE');
  await h.reject(a, wire([], [{ client: a.replica + 1, clock: 0, length: 1 }]), 'UNRESOLVED_RANGE');
  await h.accept(a, wire([], [{ client: a.replica, clock: 1, length: 1 }]));
  assert.equal(h.state.body, 'ac');
});

test('malformed, truncated, trailing and oversized inputs are finite refusals', async (t) => {
  const h = harness(t); const a = h.client();
  const good = capture(a.doc, () => a.text.insert(0, 'abc'));
  for (const bytes of [new Uint8Array(), Uint8Array.of(255), good.subarray(0, good.length - 1), Uint8Array.of(127, 255, 255, 255)]) {
    await h.reject(a, bytes, 'MALFORMED_UPDATE');
  }
  await h.reject(a, Uint8Array.from([...good, 0]), 'TRAILING_UPDATE_BYTES');
  await assert.rejects(h.pool.run(h.state, h.envelope(a), new Uint8Array(CAPS.assemblyBytes + 1)), { code: 'EXTERNAL_BUFFER_LIMIT' });
  assert.equal(h.state.sequence, 0);
});

test('100k JS code units are admitted and 100001 stays private; Unicode is byte bounded', async (t) => {
  for (const text of ['x'.repeat(100_000), '🙂'.repeat(50_000), '漢'.repeat(100_000)]) {
    const h = harness(t); const a = h.client();
    const update = capture(a.doc, () => a.text.insert(0, text));
    assert.ok(update.byteLength > CAPS.frameBytes && update.byteLength < CAPS.assemblyBytes);
    await h.accept(a, update); assert.equal(h.state.body, text);
    const over = capture(a.doc, () => a.text.insert(a.text.length, '!'));
    await h.reject(a, over, 'BODY_LIMIT'); assert.equal(a.text.length, 100_001);
    assert.equal(h.state.body.length, 100_000);
  }
});

test('long deletion history, public checkpoints and reconstructed receipts retain meaning', async (t) => {
  const h = harness(t); const a = h.client();
  await h.accept(a, capture(a.doc, () => a.text.insert(0, 'base')));
  for (let index = 0; index < 40; index++) {
    await h.accept(a, capture(a.doc, () => a.text.insert(a.text.length, `-${index}`)));
    await h.accept(a, capture(a.doc, () => a.text.delete(4, a.text.length - 4)));
  }
  const saved = digest(h.state); h.state = JSON.parse(JSON.stringify(h.state));
  assert.equal(digest(h.state), saved); assert.equal(h.state.body, 'base');
  const snapshot = Y.encodeStateAsUpdate(a.doc);
  await h.accept(a, snapshot); assert.equal(h.state.body, 'base');
  await h.reject(a, wire([item(a.replica, 0, 'evil')]), 'ALTERED_DUPLICATE_CONTENT');
  // This tests immutable serialized ledgers, not SQL restart/compaction or latency acceptance.
});

test('100ms hard termination, bounded queue and external reservations are recovered', async (t) => {
  const h = harness(t); const a = h.client(); const bytes = wire();
  const before = digest(h.state); const start = performance.now();
  await assert.rejects(h.pool.run(h.state, h.envelope(a), bytes, { stall: true }), { code: 'WORKER_TIMEOUT' });
  assert.ok(performance.now() - start < CAPS.workerBootstrapMs + 1_000);
  assert.equal(digest(h.state), before); assert.equal(h.pool.active, 0); assert.equal(h.pool.externalBytes, 0);
  // Full result reservation can fill the external budget before the queue count.
  const jobs = Array.from({ length: CAPS.workers + CAPS.waitingTasks + 1 }, () =>
    h.pool.run(h.state, h.envelope(a), bytes, { stall: true }));
  const results = await Promise.allSettled(jobs);
  assert.ok(results.some((r) => r.status === 'rejected' && r.reason.code === 'EXTERNAL_BUFFER_LIMIT'));
  assert.equal(h.pool.active, 0); assert.equal(h.pool.waiting.length, 0); assert.equal(h.pool.externalBytes, 0);
  const large = new Uint8Array(CAPS.assemblyBytes);
  const first = h.pool.run(h.state, h.envelope(a), large, { stall: true });
  await assert.rejects(h.pool.run(h.state, h.envelope(a), large, { stall: true }), { code: 'EXTERNAL_BUFFER_LIMIT' });
  await assert.rejects(first, { code: 'WORKER_TIMEOUT' });
  assert.equal(h.pool.externalBytes, 0);
});

test('room charge includes retained original text, checkpoint, receipts and object overhead', async (t) => {
  const h = harness(t); const a = h.client(); const original = stateCharge(h.state);
  const inflated = { ...h.state, receipts: { originalText: { value: 'x'.repeat(CAPS.roomCacheBytes / 2) } } };
  assert.ok(stateCharge(inflated) > CAPS.roomCacheBytes);
  await assert.rejects(h.pool.run(inflated, h.envelope(a), wire()), { code: 'ROOM_CACHE_LIMIT' });
  assert.equal(stateCharge(h.state), original);
  await h.accept(a, capture(a.doc, () => a.text.insert(0, 'x'.repeat(100_000))));
  const beforeDelete = stateCharge(h.state);
  await h.accept(a, capture(a.doc, () => a.text.delete(0, a.text.length)));
  assert.equal(h.state.body, ''); assert.equal(h.state.nodes[0].text.length, 100_000);
  assert.ok(stateCharge(h.state) > 200_000, 'deleted originals are still charged');
  assert.ok(beforeDelete < CAPS.roomCacheBytes);
});

test('close rejects reserved waiting tasks and releases every job allocation', async (t) => {
  const h = harness(t); const a = h.client();
  const jobs = Array.from({ length: 3 }, () => h.pool.run(h.state, h.envelope(a), wire(), { stall: true }));
  const settled = Promise.allSettled(jobs);
  await h.pool.close(); const results = await settled;
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(h.pool.waiting.length, 0); assert.equal(h.pool.active, 0); assert.equal(h.pool.externalBytes, 0);
});

test('missing bootstrap readiness and early clean exit are finite non-poisoning refusals', async (t) => {
  const h = harness(t); const a = h.client(); const before = digest(h.state);
  const start = performance.now();
  await assert.rejects(h.pool.run(h.state, h.envelope(a), wire(), { control: 'silent' }), { code: 'WORKER_BOOTSTRAP_TIMEOUT' });
  assert.ok(performance.now() - start < CAPS.workerBootstrapMs + 1_000);
  await assert.rejects(h.pool.run(h.state, h.envelope(a), wire(), { control: 'exit' }), { code: 'WORKER_EXIT' });
  assert.equal(digest(h.state), before); assert.equal(h.pool.active, 0); assert.equal(h.pool.externalBytes, 0);
});

test('registry reserves before a blocked first admission and releases retained inputs after refusal', async (t) => {
  const h = harness(t); const a = h.client();
  let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const stub = { run: async () => {
    if (++calls === 1) { entered(); await blocked; }
    return { ok: false, code: 'CONTROLLED_DRAIN' };
  } };
  const jobs = Array.from({ length: CAPS.workers + CAPS.waitingTasks + 1 }, () =>
    h.intents.run(stub, h.state, h.envelope(a), new Uint8Array(CAPS.assemblyBytes)));
  const settled = Promise.allSettled(jobs); await started;
  assert.ok(h.intents.budget.bytes <= CAPS.assembliesBytesPerApi);
  assert.equal(h.intents.waiting.length, 0, '8MiB jobs must hit bytes before waiting');
  release(); const results = await settled;
  assert.ok(results.some((result) => result.status === 'rejected' && result.reason.code === 'EXTERNAL_BUFFER_LIMIT'));
  assert.equal(h.intents.budget.bytes, 0); assert.equal(h.intents.budget.leases.size, 0);
});

test('admission accounts for full retained backing and refuses oversized views before hashing or queueing', async (t) => {
  const h = harness(t); const budget = new AdmissionBudget();
  const backing = new ArrayBuffer(1_024); const view = new Uint8Array(backing, 17, 16);
  const lease = budget.reserve(h.state, view);
  assert.equal(lease.amount, backing.byteLength + view.byteLength + stateCharge(h.state) + CAPS.roomCacheBytes);
  budget.release(lease); assert.equal(budget.bytes, 0);
  const oversized = new Uint8Array(new ArrayBuffer(64 * 1024 * 1024), 0, 16);
  let hashes = 0; let calls = 0;
  const envelope = { get workspace() { hashes++; throw new Error('must refuse before fingerprint'); } };
  await assert.rejects(h.intents.run({ run: async () => { calls++; } }, h.state, envelope, oversized), { code: 'EXTERNAL_BUFFER_LIMIT' });
  assert.equal(hashes, 0); assert.equal(calls, 0); assert.equal(h.intents.waiting.length, 0);
  assert.equal(h.intents.budget.bytes, 0); assert.equal(h.intents.budget.leases.size, 0);
  const growable = new Uint8Array(new ArrayBuffer(16, { maxByteLength: CAPS.assemblyBytes + 1 }));
  assert.throws(() => budget.reserve(h.state, growable), { code: 'EXTERNAL_BUFFER_LIMIT' });
  assert.equal(budget.bytes, 0); assert.equal(budget.leases.size, 0);
});

test('actual registry and pool share one reservation and cancel active plus waiting jobs on close', async (t) => {
  const h = harness(t); const a = h.client(); const before = digest(h.state);
  const jobs = Array.from({ length: 3 }, () => h.intents.run(h.pool, h.state, h.envelope(a), wire(), { stall: true }));
  const settled = Promise.allSettled(jobs); const until = performance.now() + 500;
  while (h.pool.running.size === 0 && performance.now() < until) await setImmediate();
  assert.equal(h.pool.running.size, 1); assert.equal(h.pool.budget.leases.size, 3);
  assert.ok(h.pool.externalBytes <= CAPS.assembliesBytesPerApi);
  assert.equal(h.intents.budget.bytes, 0, 'no second independent reservation for real pool');
  await h.intents.close(); const results = await settled;
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(h.pool.externalBytes, 0); assert.equal(h.pool.budget.leases.size, 0);
  assert.equal(h.pool.active, 0); assert.equal(h.intents.waiting.length, 0);
  assert.equal(digest(h.state), before);
});

test('registry waiting deadline releases reservations while a blocked boundary remains active', async (t) => {
  const h = harness(t); const a = h.client(); let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const stub = { run: async () => {
    if (++calls === 1) { entered(); await blocked; }
    return { ok: false, code: 'CONTROLLED_DRAIN' };
  } };
  const first = h.intents.run(stub, h.state, h.envelope(a), wire()); await started;
  const waiting = h.intents.run(stub, h.state, h.envelope(a), wire());
  await assert.rejects(waiting, { code: 'INTENT_REGISTRY_WAIT_TIMEOUT' });
  assert.equal(h.intents.waiting.length, 0); assert.equal(h.intents.budget.leases.size, 1);
  release(); await first; assert.equal(h.intents.budget.bytes, 0);
});

test('room count and replacement accounting are finite without losing confirmed entries', () => {
  const cache = new RoomCache();
  for (let index = 0; index < CAPS.caches; index++) cache.put(`room-${index}`, emptyRoom(`room-${index}`));
  const before = cache.bytes;
  cache.put('room-0', emptyRoom('room-0')); assert.equal(cache.bytes, before);
  assert.throws(() => cache.put('overflow', emptyRoom('overflow')), { code: 'CACHE_COUNT_LIMIT' });
  assert.equal(cache.rooms.size, CAPS.caches); assert.equal(cache.bytes, before);
  cache.remove('room-0'); cache.put('replacement', emptyRoom('replacement'));
  assert.equal(cache.rooms.size, CAPS.caches); assert.ok(cache.bytes < CAPS.cacheBytes);
});

test('100k UTF-8 update assembles reordered duplicate chunks and expires cross-scope work', async (t) => {
  const h = harness(t); const a = h.client(); const intent = h.envelope(a);
  const update = capture(a.doc, () => a.text.insert(0, '漢'.repeat(100_000)));
  const count = Math.ceil(update.length / CAPS.chunkBytes); const assemblies = new Assemblies();
  const frames = Array.from({ length: count }, (_, index) => packet({ ...intent, index, count },
    update.subarray(index * CAPS.chunkBytes, (index + 1) * CAPS.chunkBytes)));
  assert.ok(frames.every((frame) => frame.length <= CAPS.frameBytes));
  assert.equal(assemblies.receive('a', frames[count - 1], intent, 0), null);
  assert.equal(assemblies.receive('a', frames[count - 1], intent, 1), null);
  let complete;
  for (let index = count - 2; index >= 0; index--) complete = assemblies.receive('a', frames[index], intent, 2);
  assert.deepEqual(complete, Buffer.from(update));
  assert.equal(assemblies.bytes, 2 * complete.length, 'parts plus completed exact backing stay charged before job admission');
  assert.equal(complete.buffer.byteLength, complete.byteLength);
  for (const part of assemblies.pending.get('a').parts.values()) assert.equal(part.buffer.byteLength, part.byteLength, 'retained parts pin no larger slab');
  const retained = assemblies.bytes;
  assert.equal(assemblies.receive('a', frames[0], intent, 3), complete, 'exact completing-frame retry reuses the same owned copy');
  assert.equal(assemblies.bytes, retained);
  const admission = h.pool.budget.reserve(h.state, complete);
  try {
    assert.equal(h.pool.budget.owns(admission, h.state, complete), true);
    assemblies.remove('a'); assert.equal(assemblies.bytes, 0); assert.equal(assemblies.pending.size, 0);
    assert.equal(h.pool.budget.owns(admission, h.state, complete), true);
    assert.equal(h.pool.budget.bytes, admission.amount, 'job lease owns the input after assembly handoff');
    const before = digest(h.state);
    const result = await h.pool.run(h.state, intent, complete, { admission });
    assert.equal(h.pool.budget.owns(admission, h.state, complete), true);
    assert.equal(h.pool.budget.bytes, admission.amount, 'caller owns the settled job until explicit release');
    assert.equal(digest(h.state), before, 'disposable worker never mutates confirmed input');
    assert.equal(result.ok, true, result.code); assert.equal(result.workerLimits.maxOldGenerationSizeMb, CAPS.workerOldMiB);
    assert.equal(result.workerLimits.maxYoungGenerationSizeMb, CAPS.workerYoungMiB); h.state = result.state;
  } finally { h.pool.budget.release(admission); }
  assert.equal(h.pool.externalBytes, 0); assert.equal(h.pool.budget.leases.size, 0);
  assert.throws(() => assemblies.receive('x', frames[0], { ...intent, actor: 'other' }, 0), { code: 'ASSEMBLY_CONTEXT' });
  assert.throws(() => assemblies.receive('x', packet({ ...intent, room: 'other', index: 0, count }, update.subarray(0, CAPS.chunkBytes)), intent, 0), { code: 'ASSEMBLY_CONTEXT' });
  assemblies.receive('a', frames[0], intent, 0);
  const anotherIntent = { ...intent, uuid: 'other' };
  assert.throws(() => assemblies.receive('a', packet({ ...anotherIntent, index: 0, count }, update.subarray(0, CAPS.chunkBytes)), anotherIntent, 1), { code: 'ASSEMBLY_CONNECTION_LIMIT' });
  assemblies.expire(CAPS.assemblyTimeoutMs); assert.equal(assemblies.pending.size, 0); assert.equal(assemblies.bytes, 0);
  assert.throws(() => assemblies.receive('a', Buffer.alloc(CAPS.frameBytes + 1), intent, 0), { code: 'FRAME_LIMIT' });
});

test('assembly count, aggregate, altered duplicates and index ceilings have explicit refusal', () => {
  const context = { workspace: 'w', kind: 'wiki', room: 'r', generation: 'g', actor: 'a', uuid: 'id', operation: 'text', replica: 1, parameters: null };
  const assemblies = new Assemblies(); const header = { ...context, index: 0, count: 2 };
  const first = packet(header, Buffer.from('a'));
  for (let index = 0; index < CAPS.assembliesPerApi; index++) assemblies.receive(`c${index}`, first, context, 0);
  assert.throws(() => assemblies.receive('overflow', first, context, 0), { code: 'ASSEMBLY_SERVER_LIMIT' });
  assert.throws(() => assemblies.receive('c0', packet(header, Buffer.from('b')), context, 0), { code: 'ASSEMBLY_ALTERED_DUPLICATE' });
  assert.throws(() => assemblies.receive('c0', packet({ ...header, count: CAPS.chunks + 1 }, Buffer.from('a')), context, 0), { code: 'CHUNK_INDEX' });
  assemblies.expire(CAPS.assemblyTimeoutMs); assert.equal(assemblies.bytes, 0);
  const big = Buffer.alloc(CAPS.chunkBytes);
  for (let index = 0; index < CAPS.chunks; index++) {
    const frame = packet({ ...context, index, count: CAPS.chunks }, big);
    if ((index + 1) * big.length > CAPS.assemblyBytes) {
      assert.throws(() => assemblies.receive('big', frame, context, 1), { code: 'ASSEMBLY_BYTE_LIMIT' }); break;
    }
    assemblies.receive('big', frame, context, 0);
  }
  assert.ok(assemblies.bytes <= CAPS.assembliesBytesPerApi);
});

test('a complete assembly retries after copy capacity returns with its immutable intent', async (t) => {
  const assemblies = new Assemblies();
  const context = { workspace: 'w', kind: 'wiki', room: 'r', generation: 'g', actor: 'a' };
  const intent = { ...context, operation: 'text', replica: 1, parameters: { stable: true } };
  const count = Math.ceil(CAPS.assemblyBytes / CAPS.chunkBytes);
  const tail = CAPS.assemblyBytes - (count - 1) * CAPS.chunkBytes;
  const full = Buffer.alloc(CAPS.chunkBytes);
  for (let connection = 0; connection < 4; connection++) {
    for (let index = 0; index < count - 1; index++) {
      assert.equal(assemblies.receive(`c${connection}`, packet({ ...intent, uuid: `u${connection}`, index, count }, full), context, 0), null);
    }
  }
  const final = packet({ ...intent, uuid: 'u0', index: count - 1, count }, Buffer.alloc(tail));
  assert.throws(() => assemblies.receive('c0', final, context, 1), { code: 'ASSEMBLY_COPY_LIMIT' });
  assemblies.remove('c1'); const completed = assemblies.receive('c0', final, context, 2);
  assert.ok(completed instanceof Uint8Array); assert.equal(completed.length, CAPS.assemblyBytes);
  assert.equal(assemblies.pending.has('c0'), true, 'completed input remains owned until a real job lease accepts it');
  const retained = assemblies.bytes; assert.equal(retained, 2 * CAPS.assemblyBytes + 2 * (count - 1) * CAPS.chunkBytes);
  assert.equal(assemblies.pending.get('c0').size, CAPS.assemblyBytes); assert.equal(completed.buffer.byteLength, completed.byteLength);
  assert.equal(assemblies.pending.get('c0').complete, completed);
  assert.equal(assemblies.receive('c0', final, context, 3), completed); assert.equal(assemblies.bytes, retained);
  assert.deepEqual(completed.intent, { ...intent, uuid: 'u0' });
  assert.equal(Object.isFrozen(completed.intent.parameters), true);
  const pool = new CodecPool(); t.after(() => pool.close());
  const state = enroll(emptyRoom('r', 'g', 'w'), 'a', 1, true); const before = digest(state);
  const admission = pool.budget.reserve(state, completed);
  try {
    assert.equal(pool.budget.owns(admission, state, completed), true);
    assemblies.remove('c0'); assert.equal(assemblies.bytes, retained - 2 * CAPS.assemblyBytes);
    assert.equal(assemblies.pending.has('c0'), false);
    assert.equal(pool.budget.owns(admission, state, completed), true);
    assert.equal(pool.budget.bytes, admission.amount, 'pressure input remains charged after handoff');
    const result = await pool.run(state, completed.intent, completed, { admission });
    assert.equal(pool.budget.owns(admission, state, completed), true);
    assert.equal(pool.budget.bytes, admission.amount, 'refused worker input remains caller-owned until release');
    assert.equal(result.ok, false, 'synthetic zero-byte pressure payload is not valid wiki content');
    assert.equal(digest(state), before, 'pressure/refusal cannot poison confirmed state');
  } finally { pool.budget.release(admission); }
  assert.equal(pool.externalBytes, 0); assert.equal(pool.budget.leases.size, 0);
  assemblies.expire(CAPS.assemblyTimeoutMs); assert.equal(assemblies.bytes, 0); assert.equal(assemblies.pending.size, 0);
});

test('assemblies refuse changed semantic intent, duplicate headers and unknown schema fields', () => {
  const context = { workspace: 'w', kind: 'wiki', room: 'r', generation: 'g', actor: 'a' };
  const intent = { ...context, uuid: 'u', operation: 'text', replica: 1, parameters: { stable: true } };
  for (const change of [{ operation: 'save' }, { replica: 2 }, { parameters: { stable: false } }]) {
    const assemblies = new Assemblies();
    assemblies.receive('c', packet({ ...intent, index: 0, count: 2 }, Buffer.from('a')), context, 0);
    assert.throws(() => assemblies.receive('c', packet({ ...intent, ...change, index: 1, count: 2 }, Buffer.from('b')), context, 1), { code: 'ASSEMBLY_CONNECTION_LIMIT' });
    assert.throws(() => assemblies.receive('c', packet({ ...intent, ...change, index: 0, count: 2 }, Buffer.from('a')), context, 1), { code: 'ASSEMBLY_CONNECTION_LIMIT' });
    assert.equal(assemblies.bytes, 1);
  }
  const assemblies = new Assemblies();
  assert.throws(() => assemblies.receive('c', packet({ ...intent, extra: true, index: 0, count: 1 }, Buffer.from('a')), context, 0), { code: 'UNKNOWN_ENVELOPE_FIELD' });
  assert.throws(() => assemblies.receive('c', packet({ ...context, uuid: 'u', index: 0, count: 1 }, Buffer.from('a')), context, 0), { code: 'INVALID_ENVELOPE' });
  assert.equal(assemblies.bytes, 0);
});
