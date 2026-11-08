import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { DomainError, liveInvitationUseCases, type LiveMedia } from '@flux/core';
import type { Doc, LiveSession, Material } from '@flux/contracts';
import { liveRoutes } from '../../apps/server/src/live/routes.js';
import { liveAccess } from '../../apps/server/src/live/access.js';
import { discoverLiveSessions } from '../../apps/server/src/live/discovery.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { liveInvitationStore } from '../../apps/server/src/live/invitations.js';
import { liveRevocationCoordinator } from '../../apps/server/src/live/revocation.js';
import { db, pool, removeFromSpaceCore } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

test('wiki doc is a project-bound live anchor; non-doc, foreign and hidden anchors are refused', async () => {
  const owner = await person('live-doc-owner');
  const viewer = await person('live-doc-viewer');
  const outsider = await person('live-doc-outsider');
  const ws = await workspace(owner, 'Live docs');
  await addMember(owner, ws.id, viewer, 'member');
  await addMember(owner, ws.id, outsider, 'member');
  const place = await project(owner, ws.id, 'Wiki room', 'restricted');
  const other = await project(owner, ws.id, 'Other wiki room', 'restricted');
  await grant(owner, place.id, viewer, 'contributor');
  const doc = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, {
    body: { title: 'Private wiki title', body: 'Private wiki body' },
  }), 201) as Doc;
  const secondDoc = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, {
    body: { title: 'Different doc' },
  }), 201) as Doc;
  const foreignDoc = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${other.id}/docs`, {
    body: { title: 'Foreign doc' },
  }), 201) as Doc;
  const material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/materials`, {
    body: { clientMutationId: randomUUID(), title: 'Ordinary material', body: 'Not a wiki doc' },
  }), 201) as Material;

  const rooms = new Set<string>();
  const media: LiveMedia = {
    async ensureRoom(roomId) { rooms.add(roomId); },
    async requireRoom(roomId) { assert.ok(rooms.has(roomId)); },
    async grant(roomId) { return { token: `jwt:${roomId}`, expiresAt: new Date(Date.now() + 90_000) }; },
    async participants() { return []; },
    async occupancy() { return 0; },
    async removeAdmissions() {},
    async deleteRoom(roomId) { rooms.delete(roomId); },
  };
  const store = liveSessionStore(db);
  const app = Fastify();
  await app.register(liveRoutes, {
    sessions: { requirePrincipal: async (request: { headers: Record<string, unknown> }) => ({
      principal: { kind: 'human', id: String(request.headers['x-test-user'] ?? owner.id) },
      sessionId: `auth-${String(request.headers['x-test-user'] ?? owner.id)}`,
    }) } as never,
    ports: { access: liveAccess(db), sessions: store, media, mediaUrl: 'wss://media.example.test' },
  });
  const start = (userId: string, id: string, clientSessionId = randomUUID()) => app.inject({
    method: 'POST', url: '/api/v1/live-sessions', headers: { 'x-test-user': userId },
    payload: { context: { type: 'doc', id }, clientSessionId },
  });
  const ownerPrincipal = { kind: 'human' as const, id: owner.id };
  try {
    const key = randomUUID();
    const first = await start(owner.id, doc.id, key);
    assert.equal(first.statusCode, 201);
    const session = first.json() as LiveSession;
    assert.deepEqual(session.context, { type: 'doc', id: doc.id });
    assert.equal((await start(owner.id, doc.id, key)).json().id, session.id);
    const conflict = await start(owner.id, secondDoc.id, key);
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.json() as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/live-sessions/${session.id}`,
      headers: { 'x-test-user': viewer.id } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/live-sessions/${session.id}/join`,
      headers: { 'x-test-user': viewer.id } })).statusCode, 200);
    expectStatus(await owner.browser.request('PATCH', `/api/v1/docs/${doc.id}`, {
      body: { body: 'Updated wiki body' }, headers: { 'if-match': '"1"' },
    }), 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/live-sessions/${session.id}/join`,
      headers: { 'x-test-user': viewer.id } })).statusCode, 200, 'doc versions keep the same anchor ID');
    const discovered = await discoverLiveSessions(db, media, { kind: 'human', id: viewer.id }, place.id);
    assert.deepEqual(discovered.items.find((row) => row.id === session.id)?.context, { type: 'doc', id: doc.id });
    assert.equal(JSON.stringify(discovered).includes('Private wiki'), false);
    const invitations = liveInvitationUseCases(liveInvitationStore(db));
    const invitation = await invitations.invite(ownerPrincipal, session.id, viewer.id);
    const reply = await invitations.reply({ kind: 'human', id: viewer.id }, invitation.id, 'text');
    assert.deepEqual(reply.next, { kind: 'open_project_conversation', projectId: place.id,
      context: { type: 'doc', id: doc.id } });

    const hidden = await start(outsider.id, doc.id);
    assert.equal(hidden.statusCode, 404);
    assert.equal((hidden.json() as { code: string }).code, 'PROJECT_NOT_FOUND');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/live-sessions/${session.id}/join`,
      headers: { 'x-test-user': outsider.id } })).statusCode, 404);
    const nonDoc = await start(owner.id, material.materialId);
    assert.equal(nonDoc.statusCode, 404);
    assert.equal((nonDoc.json() as { code: string }).code, 'LIVE_CONTEXT_NOT_FOUND');
    await assert.rejects(store.createOrGet(ownerPrincipal, place.id, { type: 'doc', id: foreignDoc.id },
      randomUUID(), media.ensureRoom), (error: unknown) => error instanceof DomainError &&
        error.code === 'LIVE_CONTEXT_NOT_FOUND');
    // The database keeps the rule on its own: a session names a page of its own space (a trigger, since a deleted page must be
    // free to go while its ended session keeps the id as history, #941). A page of another space, a material that is no page
    // and an id that is nothing are all refused, on a new session and on a changed `doc_id`.
    const insertSession = (docId: string) => pool.query(`INSERT INTO live_sessions
      (id, workspace_id, project_id, doc_id, created_by, client_session_id, room_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), ws.id, place.id, docId, owner.id, randomUUID(), `live_${randomUUID()}`]);
    const outsideTheSpace = (error: unknown) => (error as { code?: string }).code === '23503'
      && /page must be a page of its own space/.test((error as Error).message);
    for (const wrong of [foreignDoc.id, material.materialId, randomUUID()]) await assert.rejects(insertSession(wrong), outsideTheSpace);
    await assert.rejects(pool.query('UPDATE live_sessions SET doc_id = $2 WHERE id = $1', [session.id, foreignDoc.id]), outsideTheSpace);
    assert.equal((await pool.query('SELECT doc_id FROM live_sessions WHERE id = $1', [session.id])).rows[0].doc_id, doc.id, 'a refused change changes nothing');
    await liveRevocationCoordinator(db, pool, media).withProjectChange(place.id, () => removeFromSpaceCore(ownerPrincipal, place.id, { kind: 'human', id: viewer.id }, db));
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/live-sessions/${session.id}`,
      headers: { 'x-test-user': viewer.id } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/live-sessions/${session.id}/join`,
      headers: { 'x-test-user': viewer.id } })).statusCode, 404);

    // A deleted page is free to go (#941): its room ends and the ended session keeps the page's id as history. Ending the room
    // is a state change and does not meet the rule above; a new room on the page that is gone does.
    const latest = expectStatus(await owner.browser.request('GET', `/api/v1/docs/${doc.id}`), 200) as Doc;
    expectStatus(await owner.browser.request('DELETE', `/api/v1/docs/${doc.id}`, { headers: { 'if-match': `"${latest.version}"` } }), 204);
    const ending = (await pool.query('SELECT state, doc_id FROM live_sessions WHERE id = $1', [session.id])).rows[0];
    assert.deepEqual([ending.state, ending.doc_id], ['ending', doc.id]);
    await pool.query("UPDATE live_sessions SET state = 'ended', ended_at = now(), updated_at = now() WHERE id = $1", [session.id]);
    const ended = (await pool.query('SELECT state, doc_id FROM live_sessions WHERE id = $1', [session.id])).rows[0];
    assert.deepEqual([ended.state, ended.doc_id], ['ended', doc.id], 'the ended session keeps the id of the page that is gone');
    await assert.rejects(insertSession(doc.id), outsideTheSpace);
    assert.equal((await start(owner.id, doc.id)).statusCode, 404, 'no new room on a deleted page');
  } finally { await app.close(); }
});
