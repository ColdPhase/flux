import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DomainError } from '@flux/core';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { db, pool } from './support/db.js';
import { expectStatus, person, project, workspace } from './support/people.js';


test('a live sketch anchor stays project-scoped and its read lock covers presence delivery', async () => {
  const owner = await person('live-anchor-owner');
  const ws = await workspace(owner, 'Live anchor');
  const place = await project(owner, ws.id, 'Anchor project', 'restricted');
  const projectSketch = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, {
    body: { title: 'Project board', scope: 'project', projectId: place.id },
  }), 201) as { id: string };
  const privateSketch = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, {
    body: { title: 'Private board', scope: 'private' },
  }), 201) as { id: string };
  const store = liveSessionStore(db);
  const principal = { kind: 'human' as const, id: owner.id };
  const noRoom = async () => undefined;
  await assert.rejects(store.createOrGet(principal, place.id,
    { type: 'sketch', id: privateSketch.id }, randomUUID(), noRoom),
  (error) => error instanceof DomainError && error.code === 'LIVE_CONTEXT_NOT_FOUND');

  const session = await store.createOrGet(principal, place.id,
    { type: 'sketch', id: projectSketch.id }, randomUUID(), noRoom);
  let entered!: () => void;
  let release!: () => void;
  const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const read = store.withRead(principal, session.id, async (current) => {
    assert.deepEqual(current.context, { type: 'sketch', id: projectSketch.id });
    entered();
    await held;
    return current.id;
  });
  await enteredRead;
  let updated = false;
  const change = pool.query('UPDATE sketches SET title = title WHERE id = $1', [projectSketch.id])
    .then(() => { updated = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(updated, false, 'anchor update waits for the authorized read and presence response');
  } finally { release(); }
  assert.equal(await read, session.id);
  await change;

  // There is no public scope-change API today, and the live-session composite
  // foreign key also prevents a database move to a private scope while anchored.
  await assert.rejects(pool.query(
    "UPDATE sketches SET scope = 'private', project_id = NULL WHERE id = $1", [projectSketch.id]),
  (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '23503');
});
