import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { emptyRoom, enroll } from '../../apps/server/src/editing/codec/codec.mjs';
import { CAPS } from '../../apps/server/src/editing/codec/caps.mjs';
import { CodecPool } from '../../apps/server/src/editing/codec/worker-pool.mjs';
import type { CodecEnvelope, CodecState } from '../../apps/server/src/editing/codec/types.js';

// #228 latency: a codec worker that answered within its deadline serves the next task instead of a
// fresh worker per keystroke (two workers, 100 ms task deadline, termination on timeout or failure).
// Each task carries its whole state, so a kept worker holds nothing between tasks.
function writer(state: CodecState) {
  const doc = new Y.Doc();
  const enrolled = enroll(state, 'actor-a', doc.clientID, true) as CodecState;
  Y.applyUpdate(doc, Buffer.from(enrolled.checkpoint, 'base64'), 'confirmed');
  const text = doc.getText('body');
  let counter = 0;
  return {
    doc, state: enrolled,
    next(insert: string) {
      const updates: Uint8Array[] = [];
      const record = (bytes: Uint8Array) => updates.push(Uint8Array.from(bytes));
      doc.on('update', record);
      try { text.insert(text.length, insert); } finally { doc.off('update', record); }
      const envelope: CodecEnvelope = { workspace: 'workspace', kind: 'wiki', room: 'room', generation: 'generation', actor: 'actor-a',
        operation: 'text', uuid: `operation-${++counter}`, replica: doc.clientID, parameters: null };
      return { envelope, bytes: Y.mergeUpdates(updates) };
    },
  };
}

test('a codec worker that answered stays for the next task; refusals keep it, close ends it', { timeout: 20_000 }, async () => {
  const pool = new CodecPool();
  const client = writer(emptyRoom('room', 'generation', 'workspace') as CodecState);
  let state = client.state;
  try {
    const first = client.next('Hello');
    const accepted = await pool.run(state, first.envelope, first.bytes);
    if (!accepted.ok) assert.fail(accepted.code);
    state = accepted.state;
    assert.equal(accepted.workerLimits?.maxOldGenerationSizeMb, CAPS.workerOldMiB);
    assert.equal(pool.running.size, 0);
    assert.equal(pool.idle.length, 1);
    const kept = pool.idle[0];
    const second = client.next(' world');
    const again = await pool.run(state, second.envelope, second.bytes);
    if (!again.ok) assert.fail(again.code);
    state = again.state;
    assert.equal(state.body, 'Hello world');
    assert.equal(pool.idle[0], kept, 'the same worker served the second task');
    assert.equal(again.workerLimits?.maxOldGenerationSizeMb, CAPS.workerOldMiB, 'a kept worker reports its verified limits');
    // A refused candidate is an answer within the deadline: nothing is admitted and the worker stays.
    const refused = await pool.run(state, { ...second.envelope, uuid: 'operation-refused', generation: 'other' }, second.bytes);
    assert.equal(refused.ok, false);
    assert.equal(pool.idle.length, 1);
    // Two concurrent tasks (one candidate under two command UUIDs, each against the same confirmed
    // state) use both workers; no more than CAPS.workers are ever kept.
    const third = client.next(' again');
    const both = await Promise.all(['operation-c1', 'operation-c2'].map((uuid) => pool.run(state, { ...third.envelope, uuid }, third.bytes)));
    assert.ok(both.every((result) => result.ok), JSON.stringify(both.map((result) => result.ok ? 'ok' : result.code)));
    assert.equal(pool.idle.length, CAPS.workers);
    assert.equal(pool.active, 0);
    assert.equal(pool.externalBytes, 0);
  } finally {
    const idle = [...pool.idle];
    await pool.close();
    assert.equal(pool.idle.length, 0);
    // Every kept worker was terminated by close: a terminated worker's threadId becomes -1.
    for (const worker of idle) assert.equal(worker.threadId, -1);
    client.doc.destroy();
  }
});
