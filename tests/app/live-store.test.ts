import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { DomainError, grantProject } from '@flux/core';
import type { Conversation } from '@flux/contracts';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

function failure(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test('durable live sessions bind to one project and store only idempotent references', async () => {
  const owner = await person('live-store-owner');
  const participant = await person('live-store-participant');
  const ws = await workspace(owner, 'Live store');
  await addMember(owner, ws.id, participant, 'member');
  const place = await project(owner, ws.id, 'Session project', 'restricted');
  const otherPlace = await project(owner, ws.id, 'Other project', 'restricted');
  await grant(owner, place.id, participant, 'viewer');
  const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Never copy this private body into live media or trace', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const second = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'A second anchor', clientMessageId: randomUUID() },
  }), 201) as Conversation;

  const ownerPrincipal = { kind: 'human' as const, id: owner.id };
  const viewerPrincipal = { kind: 'human' as const, id: participant.id };
  const store = liveSessionStore(db);
  const key = randomUUID();
  const anchor = { type: 'conversation' as const, id: thread.id };
  const first = await store.createOrGet(ownerPrincipal, place.id, anchor, key, async () => {});
  assert.deepEqual(await store.createOrGet(ownerPrincipal, place.id, anchor, key, async () => {}), first);
  assert.match(first.roomId, /^live_[A-Za-z0-9_-]{32}$/);
  assert.equal(first.generation, 1);
  assert.deepEqual(first.context, anchor);
  assert.deepEqual(await store.find(first.id), first);
  await assert.rejects(store.createOrGet(ownerPrincipal, place.id, { type: 'conversation', id: second.id }, key, async () => {}), failure('IDEMPOTENCY_CONFLICT'));
  // A composite FK refuses a context from another project, even when code bypasses the use case.
  await assert.rejects(store.createOrGet(ownerPrincipal, otherPlace.id, anchor, randomUUID(), async () => {}));

  const event = randomUUID();
  const ref = { type: 'message' as const, id: thread.messages[0]!.id, version: 1 };
  await store.present(first.id, viewerPrincipal, ref, event);
  await store.present(first.id, viewerPrincipal, ref, event);
  await assert.rejects(store.present(first.id, viewerPrincipal, { ...ref, version: 2 }, event), failure('IDEMPOTENCY_CONFLICT'));
  const trace = await pool.query('SELECT generation, ref_type, ref_id, ref_version, selected_thought_ids FROM live_presentations WHERE session_id = $1', [first.id]);
  assert.equal(trace.rows.length, 1);
  assert.deepEqual(trace.rows[0], { generation: 1, ref_type: 'message', ref_id: ref.id, ref_version: 1, selected_thought_ids: [] });
  const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('live_sessions', 'live_presentations')");
  assert.equal(columns.rows.some((row) => /title|body|transcript|content/.test(row.column_name)), false);

  await grantProject(ownerPrincipal, place.id, { principal: viewerPrincipal, role: 'denied' }, db);
  await assert.rejects(store.present(first.id, viewerPrincipal, ref, randomUUID()), failure('PROJECT_NOT_FOUND'));
  await assert.rejects(store.createOrGet(viewerPrincipal, place.id, anchor, randomUUID(), async () => {}), failure('PROJECT_NOT_FOUND'));
  // A committed trace survives a participant's grant revocation for authorized project users.
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM live_presentations WHERE session_id = $1', [first.id])).rows[0].count, 1);
});
