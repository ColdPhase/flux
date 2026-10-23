import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MapPresenceStore, type MapPeer } from '../../apps/web/src/editing/map-presence.js';

const peer = (expiresAt: number, cursor: MapPeer['cursor'] = { x: 40, y: 80 }): MapPeer => ({
  actor: { kind: 'human', id: 'person', name: 'Present Person' }, selected: ['thought'], cursor, slot: 0,
  expiresAt: new Date(expiresAt).toISOString(),
});

test('presence snapshots stay referentially stable until an actual notification; old snapshots stay immutable', () => {
  const store = new MapPresenceStore(), empty = store.getSnapshot();
  const now = Date.now();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  assert.equal(store.getSnapshot(), empty);
  store.set('first', peer(now + 5000));
  const first = store.getSnapshot();
  assert.equal(empty.size, 0);
  assert.equal(first.get('first')!.cursor!.x, 40);
  assert.equal(store.getSnapshot(), first);
  store.set('first', peer(now + 6000, { x: 90, y: 100 }));
  assert.equal(first.get('first')!.cursor!.x, 40);
  assert.equal(store.getSnapshot().get('first')!.cursor!.x, 90);
  assert.equal(notifications, 2);
  unsubscribe();
  store.clear();
  assert.equal(notifications, 2);
  assert.equal(store.getSnapshot().size, 0);
});

test('real expiry boundary and clear invalidate only that account/room snapshot', () => {
  const first = new MapPresenceStore(), otherRoom = new MapPresenceStore();
  const now = Date.now();
  first.set('early', peer(now + 1000)); first.set('later', peer(now + 2000));
  otherRoom.set('elsewhere', peer(now + 1000));
  const before = first.getSnapshot(); let notifications = 0;
  first.subscribe(() => { notifications++; });
  first.expire(now + 999);
  assert.equal(first.getSnapshot(), before);
  assert.equal(notifications, 0);
  first.expire(now + 1000);
  assert.deepEqual([...first.getSnapshot().keys()], ['later']);
  assert.equal(before.size, 2);
  assert.equal(otherRoom.getSnapshot().size, 1);
  assert.equal(notifications, 1);
  first.clear();
  assert.equal(first.getSnapshot().size, 0);
  assert.equal(notifications, 2);
  first.clear(); first.expire(now + 3000);
  assert.equal(notifications, 2);
  assert.equal(otherRoom.getSnapshot().size, 1);
});

test('expired or invalid presence frames never enter or replace the snapshot', () => {
  const store = new MapPresenceStore(), now = Date.now();
  store.set('expired', peer(now - 1));
  store.set('invalid', { ...peer(now + 5000), expiresAt: 'invalid' });
  assert.equal(store.getSnapshot().size, 0);
  store.set('current', peer(now + 5000));
  const current = store.getSnapshot();
  store.set('current', peer(now - 1, { x: 500, y: 600 }));
  assert.equal(store.getSnapshot(), current);
  assert.equal(store.getSnapshot().get('current')!.cursor!.x, 40);
});
