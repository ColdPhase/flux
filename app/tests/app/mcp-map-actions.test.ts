import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { expect, toolValue } from './support/mcp.js';
import { text } from './support/assistant-scene.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';

interface Detail { title: string; version: number; scope: string; createdBy: { kind: string; id: string };
  thoughts: { id: string; text: string; x: number; y: number; version: number; createdBy: { id: string } }[];
  links: { id: string; fromId: string; toId: string; label: string | null }[] }

test('standing map grants create and change a shared project map as the agent, one effect and one event per command', async () => {
  const f = await actionScene(pool);
  const base = (_operation: string, clientCommandId: string = randomUUID()) => ({ projectId: f.projectId,
    runtimeSessionId: f.runtimeSessionId, clientCommandId, peerRequestClass: 'plan', sources: [] });
  const detail = async (mapId: string) => expect(await f.owner.request('GET', `/api/v1/sketches/${mapId}`), 200) as unknown as Detail;
  const events = async (mapId: string) => (await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id=$1', [mapId])).rows[0].n as number;

  const created = toolValue(await f.tool('flux_create_map', { ...base('map.create'), title: 'Comparison map' }));
  const mapId = String(created.mapId);
  let map = await detail(mapId);
  assert.deepEqual([map.title, map.scope, map.createdBy.kind, map.createdBy.id, map.version], ['Comparison map', 'project', 'agent', f.agentId, created.version]);
  assert.equal(await events(mapId), 1);

  const addA = randomUUID();
  const a = toolValue(await f.tool('flux_add_thought', { ...base('map.thought.create', addA), mapId, thought: { text: 'Measure', x: 0, y: 0 } }));
  const addB = randomUUID();
  const thoughtB = { text: 'Compare', x: 240, y: 0, shape: 'pill', linkFrom: { thoughtId: a.thoughtId, label: 'then' } };
  const b = toolValue(await f.tool('flux_add_thought', { ...base('map.thought.create', addB), mapId, thought: thoughtB }));
  // A lost response retried before anything else changed the map: the stored outcome, no second thought, link, debit or event.
  assert.deepEqual(toolValue(await f.tool('flux_add_thought', { ...base('map.thought.create', addB), mapId, thought: thoughtB })),
    { ...b, replayed: true });
  map = await detail(mapId);
  assert.deepEqual(map.thoughts.map((item) => [item.text, item.createdBy.id]).sort(), [['Compare', f.agentId], ['Measure', f.agentId]]);
  assert.deepEqual(map.links.map((link) => [link.id, link.fromId, link.toId, link.label]), [[b.linkId, a.thoughtId, b.thoughtId, 'then']]);
  assert.equal(await events(mapId), 3, 'one event per committed command');
  assert.equal((await detail(mapId)).thoughts.length, 2);
  assert.equal(await events(mapId), 3);

  const updated = toolValue(await f.tool('flux_update_thought', { ...base('map.thought.update'), mapId, thoughtId: a.thoughtId,
    expectedVersion: a.version, changes: { text: 'Measure twice' } }));
  assert.equal(toolFailure(await f.tool('flux_update_thought', { ...base('map.thought.update'), mapId, thoughtId: a.thoughtId,
    expectedVersion: a.version, changes: { text: 'Stale edit' } })).code, 'VERSION_CONFLICT');
  const moved = toolValue(await f.tool('flux_move_thoughts', { ...base('map.positions.update'), mapId,
    moves: [{ id: a.thoughtId, x: 10, y: 20, expectedVersion: updated.version }, { id: b.thoughtId, x: 250, y: 20, expectedVersion: b.version }] }));
  map = await detail(mapId);
  assert.deepEqual(map.thoughts.find((item) => item.id === a.thoughtId) && [map.thoughts.find((item) => item.id === a.thoughtId)!.text,
    map.thoughts.find((item) => item.id === a.thoughtId)!.x], ['Measure twice', 10]);
  assert.deepEqual((moved.thoughts as { id: string }[]).map((item) => item.id).sort(), [a.thoughtId, b.thoughtId].sort());
  // A's stored outcome no longer describes the map changed since: a late replay is visibly stale, never a second effect.
  assert.equal(toolFailure(await f.tool('flux_add_thought', { ...base('map.thought.create', addA), mapId,
    thought: { text: 'Measure', x: 0, y: 0 } })).code, 'COMMAND_POSTSTATE_STALE');

  // Deleting always waits for the owner (F-036 AG-3), a local client's too: nothing is removed until the owner approves.
  assert.match(text(await f.tool('flux_unlink_thoughts', { ...base('map.link.delete'), mapId, linkId: b.linkId })), /^Waiting for /);
  assert.match(text(await f.tool('flux_remove_thought', { ...base('map.thought.delete'), mapId, thoughtId: b.thoughtId,
    expectedVersion: (moved.thoughts as { id: string; version: number }[]).find((item) => item.id === b.thoughtId)!.version })), /^Waiting for /);
  const renamed = toolValue(await f.tool('flux_rename_map', { ...base('map.rename'), mapId, expectedVersion: created.version, title: 'Measured map' }));
  map = await detail(mapId);
  assert.deepEqual([map.title, map.version, map.links.length, map.thoughts.map((item) => item.id).sort()], ['Measured map', renamed.version, 1, [a.thoughtId, b.thoughtId].sort()]);
  assert.equal(await events(mapId), 6, 'create, two adds, update, move and rename');
  assert.equal((await pool.query('SELECT count(*)::int n FROM map_live_heads WHERE sketch_id=$1', [mapId])).rows[0].n, 0,
    'ordinary MCP writes do not create a live room in the normal enabled installation or the opt-out lane');
  assert.equal((await pool.query('SELECT count(*)::int n FROM map_live_journal WHERE sketch_id=$1', [mapId])).rows[0].n, 0);
});

test('map actions never reach private maps, maps of other projects or another map than a targeted grant names', async () => {
  const f = await actionScene(pool);
  const project = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/sketches`,
    { body: { title: 'Shared map', scope: 'project', projectId: f.projectId } }), 201);
  const personal = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/sketches`,
    { body: { title: 'Owner private map', scope: 'private' } }), 201);
  const add = (mapId: unknown) => f.tool('flux_add_thought', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
    clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [], mapId, thought: { text: 'Agent note', x: 0, y: 0 } });
  assert.equal(toolFailure(await add(personal.id)).code, 'OBJECT_NOT_FOUND', 'a private map is not a project object');
  assert.equal(toolFailure(await add(randomUUID())).code, 'OBJECT_NOT_FOUND');
  assert.ok(toolValue(await add(project.id)).thoughtId);
  const privateThoughts = (await pool.query('SELECT count(*)::int AS n FROM sketch_thoughts WHERE sketch_id=$1', [personal.id])).rows[0].n as number;
  assert.equal(privateThoughts, 0);
});
