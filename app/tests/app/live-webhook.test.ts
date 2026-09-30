import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase } from '@flux/db';
import type { Conversation } from '@flux/contracts';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { LIVEKIT_WEBHOOK_PATH, liveWebhookRoutes } from '../../apps/server/src/live/webhook.js';
import { expectStatus, person, project, workspace } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

const key = 'flux-webhook-test';
const secret = 'a-long-private-livekit-test-secret-value';

function signed(body: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: key, nbf: now - 1, exp: now + 60,
    sha256: createHash('sha256').update(body).digest('base64') })).toString('base64url');
  const message = `${header}.${claims}`;
  return `${message}.${createHmac('sha256', secret).update(message).digest('base64url')}`;
}

async function post(app: ReturnType<typeof Fastify>, body: string, authorization?: string, contentType = 'application/webhook+json') {
  return app.inject({ method: 'POST', url: LIVEKIT_WEBHOOK_PATH, payload: body,
    headers: { 'content-type': contentType, ...(authorization ? { authorization } : {}) } });
}

test('signed webhook is bounded, current-generation-only, and replay-safe; reconciliation remains a hint', async () => {
  const owner = await person('live-webhook-owner');
  const ws = await workspace(owner, 'Live webhook');
  const place = await project(owner, ws.id, 'Webhook project', 'restricted');
  const context = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Webhook anchor', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const session = await liveSessionStore(db).createOrGet({ kind: 'human', id: owner.id }, place.id,
    { type: 'conversation', id: context.id }, randomUUID(), async () => {});

  const calls: { id: string; generation: number }[] = [];
  let failOnce = false;
  const app = Fastify({ logger: false });
  await app.register(liveWebhookRoutes, { pool, apiKey: key, apiSecret: secret,
    requestReconcile: async (id, generation) => {
      calls.push({ id, generation });
      if (failOnce) { failOnce = false; throw new Error('SFU temporarily unreachable'); }
    },
  });
  try {
    const body = JSON.stringify({ id: 'EV_RjiGR6qi5LBN', event: 'participant_joined', room: { name: session.roomId } });
    const authorization = signed(body);
    assert.equal((await post(app, body)).statusCode, 401, 'unsigned request');
    assert.equal((await post(app, `${body} `, authorization)).statusCode, 401, 'exact raw body hash is checked');
    assert.equal((await post(app, body, `${authorization}invalid`)).statusCode, 401, 'bad JWT');
    assert.equal((await post(app, body, authorization, 'application/json')).statusCode, 415, 'JSON parser is not the webhook parser');
    assert.equal((await post(app, body, authorization)).statusCode, 204);
    assert.deepEqual(calls, [{ id: session.id, generation: 1 }]);
    assert.equal((await post(app, body, authorization)).statusCode, 204, 'delivery replay is harmless');
    assert.equal(calls.length, 1, 'replay does not invoke reconciliation again');
    const rows = await pool.query('SELECT session_id, generation, room_id FROM live_webhook_events WHERE event_id = $1', [JSON.parse(body).id]);
    assert.deepEqual(rows.rows, [{ session_id: session.id, generation: 1, room_id: session.roomId }]);

    const oversized = 'x'.repeat(64 * 1024 + 1);
    assert.equal((await post(app, oversized, signed(oversized))).statusCode, 413, 'raw payload limit');
    const malformed = JSON.stringify({ id: 'invalid', event: 'participant_left', room: { name: session.roomId } });
    assert.equal((await post(app, malformed, signed(malformed))).statusCode, 400, 'fields checked only after signature');
    const unsupported = JSON.stringify({ id: randomUUID(), event: 'track_published', room: { name: session.roomId } });
    assert.equal((await post(app, unsupported, signed(unsupported))).statusCode, 204);
    assert.equal(calls.length, 1);

    // A failed reconciliation is retried by LiveKit with the same event ID.
    const retry = JSON.stringify({ id: randomUUID(), event: 'participant_left', room: { name: session.roomId } });
    const retryToken = signed(retry);
    failOnce = true;
    assert.equal((await post(app, retry, retryToken)).statusCode, 503);
    assert.equal((await post(app, retry, retryToken)).statusCode, 204);
    assert.equal(calls.length, 3);

    // A revoked generation's signed event cannot affect the replacement room.
    const nextRoom = `live_${randomUUID().replaceAll('-', '')}`;
    await pool.query('UPDATE live_sessions SET room_id = $1, generation = 2 WHERE id = $2', [nextRoom, session.id]);
    const old = JSON.stringify({ id: randomUUID(), event: 'participant_left', room: { name: session.roomId } });
    assert.equal((await post(app, old, signed(old))).statusCode, 204);
    assert.equal(calls.length, 3);
    const current = JSON.stringify({ id: randomUUID(), event: 'participant_joined', room: { name: nextRoom } });
    assert.equal((await post(app, current, signed(current))).statusCode, 204);
    assert.deepEqual(calls.at(-1), { id: session.id, generation: 2 });
    const unknown = JSON.stringify({ id: randomUUID(), event: 'room_finished', room: { name: `live_${randomUUID().replaceAll('-', '')}` } });
    assert.equal((await post(app, unknown, signed(unknown))).statusCode, 204);
    assert.equal(calls.length, 4);
  } finally { await app.close(); }
});
