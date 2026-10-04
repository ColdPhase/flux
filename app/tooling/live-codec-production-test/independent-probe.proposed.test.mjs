// #228 author-proposed current-ownership adaptation. Independent review required; original probe preserved.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = process.env.FLUX_CALIBRATION_ROOT ?? '/calibration';
const moduleAt = (name) => import(pathToFileURL(root + '/' + name).href);
const Y = await moduleAt('node_modules/yjs/dist/yjs.mjs');
const { emptyRoom, enroll, canonical } = await moduleAt('codec.mjs');
const { CodecPool } = await moduleAt('worker-pool.mjs');
const { Assemblies, packet } = await moduleAt('assembly.mjs');
const { CAPS } = await moduleAt('caps.mjs');
const { IntentRegistry } = await moduleAt('intent-registry.mjs');
const hash = (state) => createHash('sha256').update(canonical(state)).digest('hex');

function capture(doc, fn) {
  const values = [];
  const handler = (bytes) => values.push(Uint8Array.from(bytes));
  doc.on('update', handler);
  try { fn(); } finally { doc.off('update', handler); }
  return Y.mergeUpdates(values);
}
function harness(t, room = 'independent-room', registry = null) {
  const pool = new CodecPool();
  const docs = [];
  const h = { state: emptyRoom(room), pool, counter: 0 };
  t.after(async () => { docs.forEach((doc) => doc.destroy()); await pool.close(); });
  h.client = (actor = 'independent-a') => {
    const doc = new Y.Doc();
    h.state = enroll(h.state, actor, doc.clientID, true);
    Y.applyUpdate(doc, Buffer.from(h.state.checkpoint, 'base64'), 'confirmed');
    docs.push(doc);
    return { actor, doc, replica: doc.clientID, text: doc.getText('body') };
  };
  h.intent = (client, uuid = 'independent-' + ++h.counter) => ({
    workspace: h.state.workspace, kind: h.state.kind, room: h.state.room,
    generation: h.state.generation, actor: client.actor, replica: client.replica,
    operation: 'text', uuid,
  });
  h.run = async (client, bytes, intent = h.intent(client)) => {
    const before = hash(h.state);
    const result = registry ? await registry.run(pool, h.state, intent, bytes)
      : await pool.run(h.state, intent, bytes);
    assert.equal(hash(h.state), before, 'call mutated input confirmed state');
    return result;
  };
  h.accept = async (client, bytes, intent) => {
    const result = await h.run(client, bytes, intent);
    assert.equal(result.ok, true, result.code);
    h.state = result.state;
    return result;
  };
  return h;
}

test('positive control: independent public updates admit, exact original receipt replays', async (t) => {
  const h = harness(t); const a = h.client();
  const bytes = capture(a.doc, () => a.text.insert(0, 'control'));
  const intent = h.intent(a);
  await h.accept(a, bytes, intent);
  const before = hash(h.state);
  const repeat = await h.run(a, Uint8Array.from(bytes), intent);
  assert.equal(repeat.ok, true); assert.equal(repeat.replay, true);
  assert.equal(hash(repeat.state), before);
});

test('exact known update under a fresh UUID receives no new admitted sequence/provenance', async (t) => {
  const h = harness(t); const a = h.client();
  const bytes = capture(a.doc, () => a.text.insert(0, 'original'));
  await h.accept(a, bytes);
  const result = await h.run(a, bytes);
  assert.ok(!result.ok || result.state.sequence === h.state.sequence,
    'known duplicate was journalled as a fresh contributing update');
  if (result.ok) {
    assert.equal(result.receipt.provenance, null);
    assert.deepEqual(result.state.journal, h.state.journal);
    assert.deepEqual(result.state.nodes, h.state.nodes);
  }
});

test('another authenticated writer cannot gain new provenance by forwarding known peer bytes', async (t) => {
  const h = harness(t); const a = h.client('independent-a'); const b = h.client('independent-b');
  const bytes = capture(a.doc, () => a.text.insert(0, 'owned by A'));
  await h.accept(a, bytes);
  const result = await h.run(b, bytes);
  assert.ok(!result.ok || result.state.sequence === h.state.sequence,
    'B received a fresh admitted sequence for unchanged A structs');
  if (result.ok) {
    assert.equal(result.receipt.provenance, null);
    assert.deepEqual(result.state.journal, h.state.journal);
    assert.deepEqual(result.state.nodes, h.state.nodes);
  }
});

test('duplicate deletion with a fresh UUID does not create another admitted change', async (t) => {
  const h = harness(t); const a = h.client();
  await h.accept(a, capture(a.doc, () => a.text.insert(0, 'abc')));
  const deletion = capture(a.doc, () => a.text.delete(1, 1));
  await h.accept(a, deletion);
  const result = await h.run(a, deletion);
  assert.ok(!result.ok || result.state.sequence === h.state.sequence,
    'known deletion received new provenance and retained duplicate ranges');
  if (result.ok) {
    assert.equal(result.receipt.provenance, null);
    assert.deepEqual(result.state.journal, h.state.journal);
    assert.deepEqual(result.state.deleted, h.state.deleted);
  }
});

test('actor UUID intent remains immutable across two otherwise valid rooms', async (t) => {
  const registry = new IntentRegistry();
  const first = harness(t, 'room-one', registry); const a = first.client('same-author');
  await first.accept(a, capture(a.doc, () => a.text.insert(0, 'one')), first.intent(a, 'global-intent'));
  const second = harness(t, 'room-two', registry); const b = second.client('same-author');
  await assert.rejects(() => second.run(b, capture(b.doc, () => b.text.insert(0, 'two')),
    second.intent(b, 'global-intent')), { code: 'EDITING_IDEMPOTENCY_CONFLICT' });
});

test('public Unicode split/deletion checkpoint remains a compatible known candidate', async (t) => {
  const h = harness(t); const a = h.client();
  await h.accept(a, capture(a.doc, () => a.text.insert(0, '🙂')));
  await h.accept(a, capture(a.doc, () => a.text.delete(0, 1)));
  Y.applyUpdate(a.doc, Buffer.from(h.state.checkpoint, 'base64'), 'confirmed');
  const checkpoint = Y.encodeStateAsUpdate(a.doc);
  const result = await h.run(a, checkpoint);
  assert.equal(result.ok, true, 'valid public checkpoint rejected: ' + result.code);
  assert.equal(result.state.body, h.state.body);
  assert.equal(result.state.sequence, h.state.sequence, 'unchanged checkpoint acquired new provenance');
});

test('worker refusal under current-write revocation preserves confirmed state', async (t) => {
  const h = harness(t); const a = h.client();
  const bytes = capture(a.doc, () => a.text.insert(0, 'private'));
  const before = hash(h.state);
  const result = await h.pool.run(h.state, h.intent(a), bytes, { canWrite: false });
  assert.equal(result.ok, false); assert.equal(result.code, 'CURRENT_WRITE_REQUIRED');
  assert.equal(hash(h.state), before);
});

test('complete assembly can progress after the temporary contiguous-copy budget pressure clears', async (t) => {
  const assemblies = new Assemblies();
  const context = { workspace: 'w', kind: 'wiki', room: 'r', generation: 'g', actor: 'a' };
  const count = Math.ceil(CAPS.assemblyBytes / CAPS.chunkBytes);
  const last = CAPS.assemblyBytes - (count - 1) * CAPS.chunkBytes;
  const chunk = Buffer.alloc(CAPS.chunkBytes);
  const tail = Buffer.alloc(last);
  for (let room = 0; room < 4; room++) {
    for (let index = 0; index < count - 1; index++) {
      const header = { ...context, operation: 'text', replica: 1, parameters: null, uuid: 'assembly-' + room, index, count };
      assert.equal(assemblies.receive('connection-' + room, packet(header, chunk), context, 0), null);
    }
  }
  const finalFrame = packet({ ...context, operation: 'text', replica: 1, parameters: null, uuid: 'assembly-0', index: count - 1, count }, tail);
  assert.throws(() => assemblies.receive('connection-0', finalFrame, context, 1),
    { code: 'ASSEMBLY_COPY_LIMIT' });
  assemblies.remove('connection-1');
  const recovered = assemblies.receive('connection-0', finalFrame, context, 2);
  assert.ok(recovered instanceof Uint8Array, 'complete assembly became permanently stuck after copy refusal');
  assert.equal(recovered.byteLength, CAPS.assemblyBytes);
  assert.equal(assemblies.pending.has('connection-0'), true, 'current contract retains completed input until actual job admission');
  const retained = assemblies.bytes;
  assert.equal(retained, 2 * CAPS.assemblyBytes + 2 * (count - 1) * CAPS.chunkBytes);
  assert.equal(recovered.buffer.byteLength, recovered.byteLength);
  assert.equal(assemblies.pending.get('connection-0').size, CAPS.assemblyBytes);
  assert.equal(assemblies.pending.get('connection-0').complete, recovered);
  assert.equal(assemblies.receive('connection-0', finalFrame, context, 3), recovered);
  assert.equal(assemblies.bytes, retained, 'same completing frame allocates no second completed copy');
  const pool = new CodecPool(); t.after(() => pool.close());
  const state = enroll(emptyRoom('r', 'g', 'w'), 'a', 1, true); const before = hash(state);
  const admission = pool.budget.reserve(state, recovered);
  try {
    assert.equal(pool.budget.owns(admission, state, recovered), true);
    assemblies.remove('connection-0'); assert.equal(assemblies.bytes, retained - 2 * CAPS.assemblyBytes);
    assert.equal(assemblies.pending.has('connection-0'), false);
    assert.equal(pool.budget.owns(admission, state, recovered), true);
    assert.equal(pool.budget.bytes, admission.amount, 'actual job owns the handed-off pressure input');
    const result = await pool.run(state, recovered.intent, recovered, { admission });
    assert.equal(pool.budget.owns(admission, state, recovered), true);
    assert.equal(pool.budget.bytes, admission.amount, 'settled refusal cannot release caller-owned input');
    assert.equal(result.ok, false, 'synthetic pressure payload does not become valid text');
    assert.equal(hash(state), before);
  } finally { pool.budget.release(admission); }
  assert.equal(pool.externalBytes, 0); assert.equal(pool.budget.leases.size, 0);
  assemblies.expire(CAPS.assemblyTimeoutMs); assert.equal(assemblies.bytes, 0); assert.equal(assemblies.pending.size, 0);
});

test('assembly persistent operation/replica/parameters cannot change between chunks unnoticed', () => {
  const assemblies = new Assemblies();
  const context = { workspace: 'w', kind: 'wiki', room: 'r', generation: 'g', actor: 'a' };
  const base = { ...context, uuid: 'assembly', operation: 'text', replica: 123, parameters: { stable: true }, count: 2 };
  assemblies.receive('connection', packet({ ...base, index: 0 }, Buffer.from('a')), context, 0);
  assert.throws(() => assemblies.receive('connection',
    packet({ ...base, operation: 'save', replica: 456, parameters: { stable: false }, index: 1 },
      Buffer.from('b')), context, 1),
    'assembly accepted altered persistent semantic header');
});

test('intent registry bounds retained jobs before awaiting a blocked first admission', async () => {
  const registry = new IntentRegistry();
  const state = emptyRoom('registry-bound');
  let releaseFirst; let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const pool = { run: async () => {
    if (++calls === 1) { signalEntered(); await blocked; }
    return { ok: false, code: 'INDEPENDENT_PROBE_DRAIN' };
  } };
  const jobs = Array.from({ length: CAPS.workers + CAPS.waitingTasks + 1 }, (_, index) => {
    const envelope = { workspace: state.workspace, kind: state.kind, room: state.room,
      generation: state.generation, actor: 'registry-author', replica: 1,
      operation: 'text', uuid: 'registry-job-' + index };
    return registry.run(pool, state, envelope, new Uint8Array(CAPS.assemblyBytes));
  });
  const settled = Promise.allSettled(jobs);
  await entered;
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  const results = await settled;
  assert.ok(results.some((result) => result.status === 'rejected'
    && ['EXTERNAL_BUFFER_LIMIT', 'WORK_QUEUE_LIMIT', 'INTENT_REGISTRY_QUEUE_LIMIT'].includes(result.reason.code)),
  'all retained 8MiB requests bypassed count/byte admission while first job was blocked');
});
