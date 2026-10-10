import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { MapConfirmed } from '@flux/core';
import { editingMapResultCharge } from '../../apps/server/src/editing/context-charge.js';
import { transientCharge } from '../../apps/server/src/editing/map-authority.js';

// #228 latency: a confirmed map read without a delta is charged by `transientCharge` before its rows
// load, instead of the 24 MiB worst case of a delta. That bound must cover the conservative charge
// the read's actual result receives (editingMapResultCharge), for the largest shapes the rows allow.
const iso = new Date(0).toISOString();
const name = (units: number, char: string) => char.repeat(units);
const bytes = (text: string) => Buffer.byteLength(text);

function result(gestures: number, positions: number, presence: number, actorName: string): { value: MapConfirmed; nameBytes: number } {
  const generation = randomUUID();
  let nameBytes = bytes(actorName);
  const transient: MapConfirmed['transient'] = [];
  for (let index = 0; index < gestures; index++) {
    nameBytes += bytes(actorName);
    transient.push({ type: 'map-move', generation, connectionId: randomUUID(), actor: { kind: 'human', id: randomUUID(), name: actorName },
      gestureId: randomUUID(), leaseId: randomUUID(), sequence: Number.MAX_SAFE_INTEGER,
      positions: Array.from({ length: positions }, () => ({ id: randomUUID(), x: -100_000, y: -100_000, width: 800, height: 800 })), expiresAt: iso });
  }
  for (let index = 0; index < presence; index++) {
    nameBytes += bytes(actorName);
    transient.push({ type: 'map-presence', generation, connectionId: randomUUID(), actor: { kind: 'human', id: randomUUID(), name: actorName },
      selected: Array.from({ length: 16 }, () => randomUUID()), cursor: { x: -100_000, y: -100_000 }, expiresAt: iso });
  }
  return { nameBytes, value: { generation, sequence: Number.MAX_SAFE_INTEGER, hash: 'f'.repeat(64), workspaceId: randomUUID(), resourceId: randomUUID(),
    actor: { kind: 'human', id: randomUUID(), name: actorName }, canWrite: true, delta: null, transient } };
}

test('the transient read charge covers the actual result charge of the largest preview and presence rows', () => {
  for (const [gestures, positions, presence] of [[0, 0, 0], [1, 1, 0], [1, 200, 1], [8, 200, 32], [32, 1, 32], [2, 200, 0]] as const) {
    for (const actorName of ['', name(200, 'a'), name(500, 'ł'), name(300, '𝄞')]) {
      const { value, nameBytes } = result(gestures, positions, presence, actorName);
      const actual = editingMapResultCharge(value);
      const charged = transientCharge({ gestures, positions: gestures * positions, presence, nameBytes });
      assert.ok(actual <= charged, `${gestures}×${positions} moves, ${presence} people, ${actorName.length} name units: ${actual} > ${charged}`);
    }
  }
});

test('one ordinary preview read fits the small transient charge; many large previews take the worst case', () => {
  const ordinary = result(1, 200, 2, name(40, 'a'));
  assert.ok(transientCharge({ gestures: 1, positions: 200, presence: 2, nameBytes: ordinary.nameBytes }) <= 2 * 1024 * 1024);
  assert.ok(transientCharge({ gestures: 32, positions: 32 * 200, presence: 32, nameBytes: 0 }) > 2 * 1024 * 1024);
});
