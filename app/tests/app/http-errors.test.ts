import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { apiUrl, Browser, publicOrigin } from './support/http.js';

// One error mapping for the API (#85): a request without a session gets the same ApiError body
// from access, push, stream and identity routes, and a refused stream origin keeps its own code.
// Identity's 401 used to be Fastify's default body; it is now the ApiError contract too (#85, amended).
const UNAUTHENTICATED = { error: 'Authentication required', code: 'UNAUTHENTICATED' };

/** The HTTP answer to a stream upgrade that is refused before it opens. */
function refusedUpgrade(origin: string): Promise<{ status: number; body: unknown }> {
  const socket = new WebSocket(`${apiUrl.replace(/^http/, 'ws')}/api/v1/stream`, { headers: { origin } });
  return new Promise((resolve, reject) => {
    socket.once('open', () => { socket.close(1000); reject(new Error('the upgrade was accepted')); });
    socket.once('unexpected-response', (_request, response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => { socket.terminate(); resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }); });
    });
    socket.once('error', (error) => { if (socket.readyState !== WebSocket.CLOSED) reject(error); });
  });
}

test('access, push, stream and identity answer a missing session with the same 401 body', async () => {
  const anonymous = new Browser();
  for (const path of ['/api/v1/workspaces', '/api/v1/drafts/00000000-0000-4000-8000-000000000000', '/api/v1/push/public-key',
    '/api/v1/push/subscriptions', '/api/v1/inbox', '/api/v1/stream/work',
    '/api/v1/me', '/api/v1/sessions', '/api/v1/agent-oauth/consent-context?oauth_query=x']) {
    const response = await anonymous.request('GET', path);
    assert.equal(response.status, 401, path);
    assert.deepEqual(response.json, UNAUTHENTICATED, path);
  }
  const subscribing = await anonymous.request('POST', '/api/v1/push/subscriptions', { body: { endpoint: 'https://push.example.test/x', keys: { p256dh: 'a', auth: 'b' } } });
  assert.equal(subscribing.status, 401);
  assert.deepEqual(subscribing.json, UNAUTHENTICATED);
  const revoking = await anonymous.request('POST', '/api/v1/sessions/revoke-others');
  assert.equal(revoking.status, 401);
  assert.deepEqual(revoking.json, UNAUTHENTICATED);
  assert.deepEqual(await refusedUpgrade(publicOrigin), { status: 401, body: UNAUTHENTICATED });
});

test('a stream upgrade from another origin is refused with its own code', async () => {
  assert.deepEqual(await refusedUpgrade('https://elsewhere.example.test'), { status: 403, body: { error: 'Forbidden', code: 'ORIGIN_REJECTED' } });
});
