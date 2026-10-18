import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MapPresenceStore, type MapPeer } from '../../apps/web/src/editing/map-presence.js';

const peer = (expiresAt: number, cursor: MapPeer['cursor'] = { x: 40, y: 80 }): MapPeer => ({
  actor: { kind: 'human', id: 'person', name: 'Present Person' }, selected: ['thought'], cursor,
  expiresAt: new Date(expiresAt).toISOString(),
});

test('presence snapshots stay referentially stable until an actual notification; old snapshots stay immutable', () => {
  const store = new MapPresenceStore(), empty = store.getSnapshot();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  assert.equal(store.getSnapshot(), empty);
  store.set('first', peer(5000));
  const first = store.getSnapshot();
  assert.equal(empty.size, 0);
  assert.equal(first.get('first')!.cursor!.x, 40);
  assert.equal(store.getSnapshot(), first);
  store.set('first', peer(6000, { x: 90, y: 100 }));
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
  first.set('early', peer(1000)); first.set('later', peer(2000));
  otherRoom.set('elsewhere', peer(1000));
  const before = first.getSnapshot(); let notifications = 0;
  first.subscribe(() => { notifications++; });
  first.expire(999);
  assert.equal(first.getSnapshot(), before);
  assert.equal(notifications, 0);
  first.expire(1000);
  assert.deepEqual([...first.getSnapshot().keys()], ['later']);
  assert.equal(before.size, 2);
  assert.equal(otherRoom.getSnapshot().size, 1);
  assert.equal(notifications, 1);
  first.clear();
  assert.equal(first.getSnapshot().size, 0);
  assert.equal(notifications, 2);
  first.clear(); first.expire(3000);
  assert.equal(notifications, 2);
  assert.equal(otherRoom.getSnapshot().size, 1);
});
