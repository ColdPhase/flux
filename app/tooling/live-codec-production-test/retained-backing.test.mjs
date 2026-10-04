// Byte-equivalent assertions from the independent retained-backing probe; explicit Node import only.
import process from 'node:process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.env.FLUX_CALIBRATION_ROOT ?? '/calibration';
const moduleAt = (name) => import(pathToFileURL(root + '/' + name).href);
const { emptyRoom } = await moduleAt('codec.mjs');
const { IntentRegistry } = await moduleAt('intent-registry.mjs');
const { CAPS } = await moduleAt('caps.mjs');

// Preparation only: run in the pinned isolated calibration image after a serial grant.
// No RSS claim and no SQL/worker simulation claim: inspect what the registry retains.
test('small views cannot pin uncharged oversized backing before registry admission awaits', async () => {
  const registry = new IntentRegistry();
  const state = emptyRoom('independent-retained-backing');
  const intent = { workspace: state.workspace, kind: state.kind, room: state.room,
    generation: state.generation, actor: 'independent-author', operation: 'text',
    uuid: 'independent-retained-backing', replica: 1, parameters: null };
  const backing = new ArrayBuffer(CAPS.assembliesBytesPerApi * 2);
  const view = new Uint8Array(backing, 0, 16);
  let entered; let release; let retainedAtPool = null;
  const atPool = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const pool = { run: async (_state, _intent, input) => {
    retainedAtPool = input;
    entered(); await blocked;
    return { ok: false, code: 'INDEPENDENT_CONTROLLED_DRAIN' };
  } };
  const job = registry.run(pool, state, intent, view).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }));
  try {
    const first = await Promise.race([
      atPool.then(() => ({ reachedPool: true })),
      job.then((outcome) => ({ reachedPool: false, outcome }))]);
    if (!first.reachedPool) {
      assert.equal(first.outcome.status, 'rejected');
      assert.ok(['EXTERNAL_BUFFER_LIMIT', 'INPUT_BACKING_LIMIT'].includes(first.outcome.reason.code),
        'oversized backing must receive a typed resource refusal before pool admission');
      assert.equal(retainedAtPool, null);
    } else {
      // A normalization fix may admit its own bounded copy. Neither the retained
      // admission lease nor the blocked pool may keep the oversized source backing.
      assert.equal(retainedAtPool.byteLength, 16);
      const buffers = new Set([retainedAtPool.buffer,
        ...[...registry.budget.leases].map((lease) => lease.input.buffer)]);
      const actualRetained = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
      assert.ok(actualRetained <= CAPS.assembliesBytesPerApi,
        `retained backing ${actualRetained} exceeds aggregate ${CAPS.assembliesBytesPerApi}`);
      assert.ok(registry.budget.bytes >= actualRetained,
        `budget ${registry.budget.bytes} undercharges retained backing ${actualRetained}`);
      assert.ok(registry.budget.bytes <= CAPS.assembliesBytesPerApi);
    }
  } finally {
    release(); await job; await registry.close();
  }
  assert.equal(registry.budget.bytes, 0);
  assert.equal(registry.budget.leases.size, 0);
  assert.equal(registry.waiting.length, 0);
});
