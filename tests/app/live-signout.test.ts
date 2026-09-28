import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { IncomingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import { createDatabase } from '@flux/db';
import type { Conversation } from '@flux/contracts';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { disconnectOnSignOut } from '../../apps/server/src/live/signout.js';
import type { SessionContext } from '../../apps/server/src/identity/index.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';

// Signing out ends that person's live media connections (#62). The Better Auth sign-out is
// stood in for by a route that deletes the session, so the hook must resolve the person first.
// The SFU is an in-memory media port.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

interface Media {
  connected: Map<string, Set<string>>;
  removed: string[];
  fail: 'none' | 'participants' | 'remove' | 'hang';
}

function media(state: Media) {
  return {
    async participants(roomId: string) {
      if (state.fail === 'participants') throw new Error('SFU unavailable');
      if (state.fail === 'hang') return new Promise<never>(() => {});
      return [...(state.connected.get(roomId) ?? [])].map((userId) => ({ userId, joinedAt: new Date().toISOString() }));
    },
    async removeParticipant(roomId: string, userId: string) {
      if (state.fail === 'remove') throw new Error('SFU unavailable');
      state.connected.get(roomId)?.delete(userId);
      state.removed.push(roomId);
    },
  };
}

async function signOutApp(state: Media, timeoutMs?: number) {
  const signedIn = new Set<string>();
  const resolveSession = async (headers: IncomingHttpHeaders): Promise<SessionContext | null> => {
    const id = headers['x-test-user'];
    if (typeof id !== 'string' || !signedIn.has(id)) return null;
    return { principal: { kind: 'human', id }, sessionId: `s-${id}`, expiresAt: new Date(Date.now() + 60_000), user: { id, email: `${id}@example.test`, name: id } };
  };
  const app = Fastify();
  const hook = disconnectOnSignOut(app, { db, sessions: { resolveSession }, media: media(state), timeoutMs });
  // Runs after the disconnect hook, which by then has started its work: settled() covers it.
  let responses = 0;
  app.addHook('onResponse', async () => { responses++; });
  const responded = async (count: number) => {
    const deadline = Date.now() + 2000;
    while (responses < count) {
      if (Date.now() > deadline) throw new Error('No response hook ran');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  // Stands in for Better Auth: the session no longer resolves once sign-out has run.
  app.post('/api/auth/sign-out', async (request, reply) => {
    const id = request.headers['x-test-user'];
    if (typeof id !== 'string' || !signedIn.has(id)) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    signedIn.delete(id);
    return { success: true };
  });
  await app.ready();
  return { app, hook, signedIn, responded };
}

async function fixture(label: string) {
  const owner = await person(`${label}-owner`);
  const outsider = await person(`${label}-outsider`);
  const ws = await workspace(owner, label);
  const elsewhere = await workspace(outsider, `${label} elsewhere`);
  const place = await project(owner, ws.id, `${label} project`, 'workspace');
  const other = await project(outsider, elsewhere.id, `${label} other`, 'workspace');
  const anchor = async (someone: Person, projectId: string) => ({ type: 'conversation' as const, id: (expectStatus(await someone.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, {
    body: { body: `${label} anchor`, clientMessageId: randomUUID() } }), 201) as Conversation).id });
  const store = liveSessionStore(db);
  const here = await anchor(owner, place.id);
  const start = (someone: Person, projectId: string, context: { type: 'conversation'; id: string }) =>
    store.createOrGet({ kind: 'human', id: someone.id }, projectId, context, randomUUID(), async () => {});
  // At most three non-ended sessions per creator: end one before starting the rest.
  const ended = await start(owner, place.id, here);
  await pool.query(`UPDATE live_sessions SET state = 'ended', ended_at = now() WHERE id = $1`, [ended.id]);
  const connectedA = await start(owner, place.id, here);
  const connectedB = await start(owner, place.id, here);
  const notConnected = await start(owner, place.id, here);
  await addMember(outsider, elsewhere.id, owner, 'member');
  const otherWorkspace = await start(outsider, other.id, await anchor(outsider, other.id));
  return { owner, outsider, ws, elsewhere, connectedA, connectedB, notConnected, ended, otherWorkspace };
}

test('signing out disconnects the person from every available room they are connected to', async () => {
  const f = await fixture('live-signout');
  const state: Media = { connected: new Map(), removed: [], fail: 'none' };
  for (const session of [f.connectedA, f.connectedB, f.ended, f.otherWorkspace]) state.connected.set(session.roomId, new Set([f.owner.id, f.outsider.id]));
  state.connected.set(f.notConnected.roomId, new Set([f.outsider.id]));
  const { app, hook, signedIn, responded } = await signOutApp(state);
  try {
    signedIn.add(f.owner.id);
    const response = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { 'x-test-user': f.owner.id } });
    assert.equal(response.statusCode, 200);
    await responded(1);
    await hook.settled();
    assert.deepEqual(new Set(state.removed), new Set([f.connectedA.roomId, f.connectedB.roomId, f.otherWorkspace.roomId]),
      'every available room of their workspaces, not an ended one or a room they are not in');
    assert.equal(state.removed.length, 3);
    assert.equal(state.connected.get(f.connectedA.roomId)?.has(f.outsider.id), true, 'other people stay connected');
    assert.equal(state.connected.get(f.ended.roomId)?.has(f.owner.id), true);

    // A request that is not a successful sign-out disconnects nobody.
    state.removed.length = 0;
    const refused = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { 'x-test-user': f.outsider.id } });
    assert.equal(refused.statusCode, 401);
    await responded(2);
    await hook.settled();
    assert.deepEqual(state.removed, []);
  } finally { await app.close(); }
});

test('sign-out still succeeds when the SFU fails or hangs', async () => {
  const f = await fixture('live-signout-sfu');
  for (const fail of ['participants', 'remove', 'hang'] as const) {
    const state: Media = { connected: new Map([[f.connectedA.roomId, new Set([f.owner.id])]]), removed: [], fail };
    const { app, hook, signedIn, responded } = await signOutApp(state, 200);
    try {
      signedIn.add(f.owner.id);
      const started = Date.now();
      const response = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { 'x-test-user': f.owner.id } });
      assert.equal(response.statusCode, 200, fail);
      assert.deepEqual(response.json(), { success: true });
      assert.ok(Date.now() - started < 1000, `sign-out does not wait for the SFU (${fail})`);
      await responded(1);
      await hook.settled();
      assert.deepEqual(state.removed, []);
    } finally { await app.close(); }
  }
});
