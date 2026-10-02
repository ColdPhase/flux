import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { expect, toolValue } from './support/mcp.js';
import { actionScene, toolFailure } from './support/mcp-actions.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

interface Detail { title: string; version: number; scope: string; createdBy: { kind: string; id: string };
  thoughts: { id: string; text: string; x: number; y: number; version: number; createdBy: { id: string } }[];
  links: { id: string; fromId: string; toId: string; label: string | null }[] }

test('standing map grants create and change a shared project map as the agent, one effect and one event per command', async () => {
  const f = await actionScene(pool);
  const grants = Object.fromEntries(await Promise.all((['map.create', 'map.rename', 'map.thought.create', 'map.thought.update',
    'map.thought.delete', 'map.positions.update', 'map.link.create', 'map.link.delete'] as const)
    .map(async (operation) => [operation, (await f.grant(operation, 'plan', 10)).id] as const)));
  const base = (operation: keyof typeof grants, clientCommandId: string = randomUUID()) => ({ projectId: f.projectId,
    runtimeSessionId: f.runtimeSessionId, grantId: grants[operation]!, clientCommandId, peerRequestClass: 'plan', sources: [] });
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
  assert.equal(await f.used(grants['map.thought.create']!), 2);

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

  toolValue(await f.tool('flux_unlink_thoughts', { ...base('map.link.delete'), mapId, linkId: b.linkId }));
  toolValue(await f.tool('flux_remove_thought', { ...base('map.thought.delete'), mapId, thoughtId: b.thoughtId,
    expectedVersion: (moved.thoughts as { id: string; version: number }[]).find((item) => item.id === b.thoughtId)!.version }));
  const renamed = toolValue(await f.tool('flux_rename_map', { ...base('map.rename'), mapId, expectedVersion: created.version, title: 'Measured map' }));
  map = await detail(mapId);
  assert.deepEqual([map.title, map.version, map.links.length, map.thoughts.map((item) => item.id)], ['Measured map', renamed.version, 0, [a.thoughtId]]);
  assert.equal(await events(mapId), 8, 'create, two adds, update, move, unlink, remove and rename');
});

test('map actions never reach private maps, maps of other projects or another map than a targeted grant names', async () => {
  const f = await actionScene(pool);
  const anyMap = (await f.grant('map.thought.create', 'plan', 10)).id;
  const project = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/sketches`,
    { body: { title: 'Shared map', scope: 'project', projectId: f.projectId } }), 201);
  const other = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/sketches`,
    { body: { title: 'Second shared map', scope: 'project', projectId: f.projectId } }), 201);
  const personal = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/sketches`,
    { body: { title: 'Owner private map', scope: 'private' } }), 201);
  const add = (grantId: string, mapId: unknown) => f.tool('flux_add_thought', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
    grantId, clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [], mapId, thought: { text: 'Agent note', x: 0, y: 0 } });
  assert.equal(toolFailure(await add(anyMap, personal.id)).code, 'OBJECT_NOT_FOUND', 'a private map is not a project object');
  assert.equal(toolFailure(await add(anyMap, randomUUID())).code, 'OBJECT_NOT_FOUND');
  const onlyProject = (await f.grant('map.thought.create', 'plan', 10, String(project.id))).id;
  assert.equal(toolFailure(await add(onlyProject, other.id)).code, 'AGENT_EXECUTION_UNAVAILABLE', 'a targeted grant authorizes only its map');
  assert.ok(toolValue(await add(onlyProject, project.id)).thoughtId);
  assert.equal(await f.used(anyMap), 0);
  const privateThoughts = (await pool.query('SELECT count(*)::int AS n FROM sketch_thoughts WHERE sketch_id=$1', [personal.id])).rows[0].n as number;
  assert.equal(privateThoughts, 0);
});
