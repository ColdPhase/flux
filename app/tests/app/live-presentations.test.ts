import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Conversation, ConversationMessage, LivePresentationPage, WorkItem } from '@flux/contracts';
import { livePresentPath, livePresentationsPath } from '@flux/contracts';
import { liveAccess } from '../../apps/server/src/live/access.js';
import { liveRoutes } from '../../apps/server/src/live/routes.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import type { SessionResolver } from '../../apps/server/src/identity/index.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';


test('recipient pages only current, readable presentation refs after hidden sources and loses replay on revoke',
  { timeout: 120_000 }, async () => {
    const owner = await person('live-feed-owner');
    const recipient = await person('live-feed-recipient');
    const outsider = await person('live-feed-outsider');
    const ws = await workspace(owner, 'Live feed');
    await addMember(owner, ws.id, recipient, 'member');
    const place = await project(owner, ws.id, 'Presentation project', 'restricted');
    await grant(owner, place.id, recipient, 'viewer');
    const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
      body: { body: 'Private body one', clientMessageId: randomUUID() },
    }), 201) as Conversation;
    const second = expectStatus(await owner.browser.request('POST', `/api/v1/conversations/${conversation.id}/messages`, {
      body: { body: 'Private body two', clientMessageId: randomUUID() },
    }), 201) as ConversationMessage;
    const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
      body: { title: 'Stale work title' },
    }), 201) as WorkItem;
    const store = liveSessionStore(db);
    const principal = { kind: 'human' as const, id: owner.id };
    const session = await store.createOrGet(principal, place.id,
      { type: 'conversation', id: conversation.id }, randomUUID(), async () => {});
    const otherSession = await store.createOrGet(principal, place.id,
      { type: 'conversation', id: conversation.id }, randomUUID(), async () => {});
    const identity = { async requirePrincipal(request: FastifyRequest) {
      return { principal: { kind: 'human' as const, id: String(request.headers['x-person-id'] ?? '') } };
    } } as SessionResolver;
    const app = Fastify({ logger: false });
    await app.register(liveRoutes, { sessions: identity, ports: {
      access: liveAccess(db), sessions: store, mediaUrl: 'wss://example.test',
      media: {
        async ensureRoom() {}, async requireRoom() {},
        async grant() { return { token: 'unused', expiresAt: new Date() }; },
        async participants() { return []; }, async occupancy() { return 0; },
        async removeAdmissions() {}, async deleteRoom() {},
      },
    } });
    const get = async (personId: string, id: string, suffix = '') => app.inject({
      method: 'GET', url: `${livePresentationsPath(id)}${suffix}`, headers: { 'x-person-id': personId },
    });
    const present = async (ref: { type: 'work' | 'message'; id: string; version: number }, id = session.id) => app.inject({
      method: 'POST', url: livePresentPath(id), headers: { 'x-person-id': owner.id },
      payload: { ref, clientEventId: randomUUID() },
    });
    try {
      assert.equal((await present({ type: 'work', id: work.id, version: work.version })).statusCode, 204);
      const hiddenId = (await pool.query<{ id: string }>('SELECT id FROM live_presentations WHERE session_id = $1',
        [session.id])).rows[0]!.id;
      expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${work.id}`, {
        headers: { 'if-match': `"${work.version}"` }, body: { title: 'Current work title' },
      }), 200);
      const firstRef = { type: 'message' as const, id: conversation.messages[0]!.id, version: 1 };
      const secondRef = { type: 'message' as const, id: second.id, version: 1 };
      assert.equal((await present(firstRef)).statusCode, 204);
      assert.equal((await present(secondRef)).statusCode, 204);
      assert.equal((await present(firstRef, otherSession.id)).statusCode, 204);
      const otherId = (await pool.query<{ id: string }>('SELECT id FROM live_presentations WHERE session_id = $1',
        [otherSession.id])).rows[0]!.id;

      const first = await get(recipient.id, session.id, '?limit=1');
      assert.equal(first.statusCode, 200, first.body);
      const page1 = first.json<LivePresentationPage>();
      assert.deepEqual(page1.items.map((item) => item.ref), [firstRef]);
      assert.ok(page1.nextAfter);
      assert.deepEqual(Object.keys(page1.items[0]!).sort(), ['createdAt', 'createdBy', 'generation', 'id', 'ref']);
      assert.equal(JSON.stringify(page1).includes('Private body'), false);
      assert.equal(JSON.stringify(page1).includes('Stale work title'), false);
      const next = await get(recipient.id, session.id, `?limit=1&after=${page1.nextAfter}`);
      assert.equal(next.statusCode, 200, next.body);
      const page2 = next.json<LivePresentationPage>();
      assert.deepEqual(page2.items.map((item) => item.ref), [secondRef]);
      assert.equal(page2.nextAfter, null);
      assert.equal((await get(outsider.id, session.id)).statusCode, 404);
      assert.equal((await get(recipient.id, session.id, `?after=${hiddenId}`)).statusCode, 404);
      assert.equal((await get(recipient.id, session.id, `?after=${otherId}`)).statusCode, 404);

      const nextRoom = `live_${randomUUID().replaceAll('-', '')}`;
      await pool.query('UPDATE live_sessions SET generation = 2, room_id = $1 WHERE id = $2', [nextRoom, session.id]);
      assert.equal((await get(recipient.id, session.id, `?after=${page1.nextAfter}`)).statusCode, 404);
      assert.deepEqual((await get(recipient.id, session.id)).json<LivePresentationPage>().items, []);
      assert.equal((await get(recipient.id, session.id, '?limit=51')).statusCode, 400);
      assert.equal((await get(recipient.id, session.id, '?after=invalid')).statusCode, 400);

      // An invisible tail cannot disclose its size or furnish a cursor.
      await pool.query(`INSERT INTO live_presentations
        (id, workspace_id, project_id, session_id, generation, created_by,
         client_event_id, ref_type, ref_id, ref_version, selected_thought_ids)
        SELECT gen_random_uuid(), $1, $2, $3, 2, $4,
               gen_random_uuid(), 'work', $5, $6, '{}'::uuid[]
        FROM generate_series(1, 501)`, [ws.id, place.id, session.id, owner.id, work.id, work.version]);
      const bounded = await get(recipient.id, session.id, '?limit=1');
      assert.equal(bounded.statusCode, 503, bounded.body);
      assert.equal(bounded.body.includes('501'), false);
      assert.equal(bounded.body.includes('cursor'), false);

      // A policy mutation holding the project guard must finish before a new
      // feed request can authorize; the request then sees the revoked role.
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE', [place.id]);
        let settled = false;
        const waiting = get(recipient.id, session.id).then((response) => { settled = true; return response; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(settled, false);
        await locker.query("UPDATE project_grants SET role = 'denied' WHERE project_id = $1 AND user_id = $2",
          [place.id, recipient.id]);
        await locker.query('COMMIT');
        assert.equal((await waiting).statusCode, 404);
      } finally {
        await locker.query('ROLLBACK').catch(() => undefined);
        locker.release();
      }
    } finally { await app.close(); }
  });
