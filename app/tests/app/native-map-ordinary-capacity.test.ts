import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Sketch, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { expectStatus, person, project, workspace, type Person } from './support/people.js';

// #239 review: with live editing off, an ordinary map (no live room) takes no live preparation, so
// concurrent native HTTP commands keep main's behaviour. A map that has a room stays charged and
// queued, but a finite capacity refusal is a retryable 503, never a 500.

// search.test's concurrency, which main serves; far above one admitted plus eight queued native commands.
// (70 concurrent writers of one map met the database pool/row-lock timeout here; that limit is not measured.)
const BURST = 25;
const thought = (someone: Person, sketchId: string, index: number) =>
  someone.browser.request('POST', `/api/v1/sketches/${sketchId}/thoughts`, { body: { text: `Burst thought ${index}`, x: index * 10, y: 0 } });
async function map(someone: Person, space: Workspace, title: string) {
  const owned = await project(someone, space.id, `${title} project`, 'restricted');
  return expectStatus(await someone.browser.request('POST', `/api/v1/workspaces/${space.id}/sketches`, { body: { title, scope: 'project', projectId: owned.id } }), 201) as Sketch;
}
const count = async (sketchId: string) => (await pool.query('SELECT count(*)::int n FROM sketch_thoughts WHERE sketch_id=$1', [sketchId])).rows[0].n as number;

test('an ordinary map without a live room accepts a concurrent burst like main', { timeout: 60_000 }, async () => {
  const ari = await person('Ari Ordinary Burst');
  const sketch = await map(ari, await workspace(ari, 'Ordinary burst'), 'Ordinary burst map');
  assert.equal((await pool.query('SELECT count(*)::int n FROM map_live_heads WHERE sketch_id=$1', [sketch.id])).rows[0].n, 0);
  const responses = await Promise.all(Array.from({ length: BURST }, (_, index) => thought(ari, sketch.id, index)));
  const statuses = responses.map((response) => response.status);
  assert.deepEqual(statuses.filter((status) => status !== 201), [], `every ordinary command is created: ${responses.find((response) => response.status !== 201)?.text ?? ''}`);
  assert.equal(await count(sketch.id), BURST);
  assert.equal((await pool.query('SELECT count(*)::int n FROM map_live_journal WHERE sketch_id=$1', [sketch.id])).rows[0].n, 0, 'an ordinary map is not journaled');
});

test('a map with a live room refuses excess native commands as a retryable 503, never a 500', { timeout: 90_000 }, async () => {
  const ari = await person('Ari Roomed Burst');
  const space = await workspace(ari, 'Roomed burst');
  const sketch = await map(ari, space, 'Roomed burst map');
  // A room left by an earlier live session (the capability is off in this stack).
  await pool.query('INSERT INTO map_live_heads(sketch_id,workspace_id,generation) VALUES ($1,$2,$3)', [sketch.id, space.id, randomUUID()]);
  const responses = await Promise.all(Array.from({ length: BURST }, (_, index) => thought(ari, sketch.id, index)));
  const unexpected = responses.filter((response) => response.status !== 201 && response.status !== 503);
  assert.deepEqual(unexpected.map((response) => `${response.status} ${response.text}`), [], 'only created or a finite refusal');
  const created = responses.filter((response) => response.status === 201).length;
  assert.ok(created > 0, 'the admitted commands are created');
  for (const refused of responses.filter((response) => response.status === 503)) {
    const body = refused.json as { code?: string; outcome?: string; retryable?: boolean };
    assert.ok(body.code === 'EDITING_OUTPUT_CAPACITY' || body.code === 'EDITING_MAP_CAPACITY', refused.text);
    assert.equal(body.outcome, 'refused', refused.text);
    assert.equal(body.retryable, true, refused.text);
  }
  assert.equal(await count(sketch.id), created, 'a refusal creates nothing');
  assert.equal((await pool.query('SELECT count(*)::int n FROM map_live_journal WHERE sketch_id=$1', [sketch.id])).rows[0].n, created, 'each roomed command is journaled');
  // Every preparation was released: later commands are admitted again.
  for (let index = 0; index < 3; index++) expectStatus(await thought(ari, sketch.id, BURST + index), 201, 'after the burst');
});

test('the live editing capability is reported unavailable when development live editing is off', async () => {
  const ari = await person('Ari Capability');
  assert.deepEqual(expectStatus(await ari.browser.request('GET', '/api/v1/live-editing/capabilities'), 200), { status: 'unavailable' });
  // The disabled editing routes still refuse truthfully.
  const space = await workspace(ari, 'Capability');
  const sketch = await map(ari, space, 'Capability map');
  const refused = await ari.browser.request('GET', `/api/v1/sketches/${sketch.id}/live`);
  assert.equal(refused.status, 503);
  assert.equal((refused.json as { code?: string }).code, 'LIVE_EDITING_DISABLED');
});
