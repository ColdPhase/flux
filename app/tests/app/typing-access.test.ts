import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase, listen, typingNotifications, typingRows } from '@flux/db';
import { authorizeTypingContext, authorizeTypingSender, decodeTypingPulse, TYPING_CHANNEL, type TypingActor, type TypingPulse } from '@flux/core';
import type { Conversation, Dm, ProjectGrant, TypingContext, Workspace } from '@flux/contracts';
import { typingAccess } from '../../apps/server/src/typing/access.js';
import { typingTaskDiscussion } from '../../apps/server/src/typing/tasks.js';
import { addMember, expectStatus, grant, person, project, secondSession, workspace, type Person } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());
const access = typingAccess(db);
const notifications = typingNotifications(db);
async function actor(person: Person): Promise<TypingActor> {
  const me = expectStatus(await person.browser.request('GET', '/api/v1/me'), 200) as { session: { id: string } };
  return { actorId: person.id, sessionId: me.session.id };
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function pulse(who: TypingActor, context: TypingContext, expiresAt: number): TypingPulse {
  return { ...who, context, expiresAt, sequence: 1, active: true, connectionId: randomUUID() };
}

// Actual API-established humans/sessions/grants and PostgreSQL notification paths; no socket/UI claim.
describe('current native human typing access and nondurable broker primitives', () => {
  let alice: Person; let bob: Person; let viewer: Person; let outsider: Person;
  let ws: Workspace; let aliceActor: TypingActor; let bobActor: TypingActor; let viewerActor: TypingActor;
  before(async () => {
    [alice, bob, viewer, outsider] = await Promise.all(['typing-alice', 'typing-bob', 'typing-viewer', 'typing-outsider'].map(person));
    ws = await workspace(alice, 'Typing access fixtures');
    await addMember(alice, ws.id, bob, 'member'); await addMember(alice, ws.id, viewer, 'member');
    [aliceActor, bobActor, viewerActor] = await Promise.all([actor(alice), actor(bob), actor(viewer)]);
  });
  async function conversation() {
    const room = await project(alice, ws.id, 'Typing restricted', 'restricted');
    await grant(alice, room.id, bob, 'contributor'); await grant(alice, room.id, viewer, 'viewer');
    const convo = expectStatus(await alice.browser.request('POST', `/api/v1/projects/${room.id}/conversations`,
      { body: { body: 'Actual shared native discussion', clientMessageId: randomUUID() } }), 201) as Conversation;
    return { room, context: { kind: 'conversation' as const, id: convo.id } };
  }

  test('only exact live human session plus current project authority yields native typing access', async () => {
    const { context } = await conversation();
    assert.deepEqual(await authorizeTypingContext(access, bobActor, context, 'write'), context);
    assert.deepEqual(await authorizeTypingContext(access, viewerActor, context, 'read'), context);
    assert.equal(await authorizeTypingContext(access, viewerActor, context, 'write'), null);
    assert.equal(await authorizeTypingContext(access, await actor(outsider), context, 'read'), null);
    assert.equal(await authorizeTypingContext(access, { actorId: bob.id, sessionId: aliceActor.sessionId }, context, 'read'), null);
    assert.equal(await authorizeTypingContext(access, { ...bobActor, sessionId: 'not-a-session' }, context, 'read'), null);
    assert.equal(await authorizeTypingContext(access, bobActor, { ...context, id: randomUUID() }, 'read'), null);
    assert.equal(await access.canonicalContext({ id: bob.id, kind: 'agent' }, context, 'write'), null);
    const authorized = await authorizeTypingSender(access, pulse(bobActor, context, await notifications.now() + 5000));
    assert.deepEqual(authorized, { id: bob.id, name: 'typing-bob' });
    assert.deepEqual(Object.keys(authorized!).sort(), ['id', 'name']);
  });

  test('current grant downgrade and denial withdraw sender activity while reader access follows its own policy', async () => {
    const { context, room } = await conversation(); const update = pulse(bobActor, context, await notifications.now() + 5000);
    assert.ok(await authorizeTypingSender(access, update));
    await grant(alice, room.id, bob, 'viewer');
    assert.equal(await authorizeTypingSender(access, update), null);
    assert.deepEqual(await authorizeTypingContext(access, bobActor, context, 'read'), context);
    await grant(alice, room.id, bob, 'denied');
    assert.equal(await authorizeTypingSender(access, update), null);
    assert.equal(await authorizeTypingContext(access, bobActor, context, 'read'), null);
  });

  test('exact remote session revocation or DB expiry withdraws activity despite unchanged human/project write authority', async () => {
    const { context } = await conversation();
    const first = await secondSession(bob); const second = await secondSession(bob);
    const ref = { actorId: bob.id, sessionId: first.sessionId }; const update = pulse(ref, context, await notifications.now() + 5000);
    assert.ok(await authorizeTypingSender(access, update));
    await pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [first.sessionId, bob.id]);
    assert.equal(await authorizeTypingSender(access, update), null);
    assert.ok(await authorizeTypingSender(access, pulse(bobActor, context, await notifications.now() + 5000)), 'another live session is not revoked');
    await pool.query("UPDATE auth_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [second.sessionId]);
    assert.equal(await authorizeTypingContext(access, { actorId: bob.id, sessionId: second.sessionId }, context, 'read'), null);
  });

  test('sender session is checked again after asynchronous policy work; names are current native identity only', async () => {
    const { context } = await conversation(); const session = await secondSession(bob);
    const ref = { actorId: bob.id, sessionId: session.sessionId }; const update = pulse(ref, context, await notifications.now() + 5000);
    const revokeDuringPolicy = {
      ...access,
      async canonicalContext(...args: Parameters<typeof access.canonicalContext>) {
        const found = await access.canonicalContext(...args);
        await pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [session.sessionId, bob.id]);
        return found;
      },
    };
    assert.equal(await authorizeTypingSender(revokeDuringPolicy, update), null, 'actual DB revocation between the two current session reads');
    await pool.query('UPDATE auth_users SET name = $1 WHERE id = $2', ['Typing Bob renamed', bob.id]);
    assert.deepEqual(await authorizeTypingSender(access, pulse(bobActor, context, await notifications.now() + 5000)), { id: bob.id, name: 'Typing Bob renamed' });
  });

  test('caller mutation across session awaits cannot mix one human with another scope or identity', async () => {
    const { context } = await conversation();
    const mutableActor = { ...aliceActor }; const mutableContext = { ...context };
    let entered!: () => void; let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const delayed = { ...access, async currentHuman(ref: TypingActor) {
      const current = await access.currentHuman(ref);
      if (first) { first = false; entered(); await releasePromise; }
      return current;
    } };
    const pending = authorizeTypingContext(delayed, mutableActor, mutableContext, 'write');
    await enteredPromise;
    mutableActor.actorId = bobActor.actorId; mutableActor.sessionId = bobActor.sessionId;
    mutableContext.id = randomUUID(); release();
    assert.deepEqual(await pending, context, 'consistent original actor and actual native conversation');
    let senderEntered!: () => void; let senderRelease!: () => void;
    const senderGate = new Promise<void>((resolve) => { senderRelease = resolve; });
    const senderStarted = new Promise<void>((resolve) => { senderEntered = resolve; });
    let firstSender = true;
    const senderPorts = { ...access, async currentHuman(ref: TypingActor) {
      const current = await access.currentHuman(ref);
      if (firstSender) { firstSender = false; senderEntered(); await senderGate; }
      return current;
    } };
    const mutablePulse = pulse(aliceActor, { ...context }, await notifications.now() + 5000);
    const senderPending = authorizeTypingSender(senderPorts, mutablePulse);
    await senderStarted;
    mutablePulse.actorId = bob.id; mutablePulse.sessionId = bobActor.sessionId; mutablePulse.context.id = randomUUID(); senderRelease();
    assert.deepEqual(await senderPending, { id: alice.id, name: 'typing-alice' });
  });

  test('closed 1:1 keeps readable history but denies typing publication using the native DM counterpart rule', async () => {
    const dm = expectStatus(await alice.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [bob.id] } }), 201) as Dm;
    const context: TypingContext = { kind: 'dm', id: dm.id };
    assert.ok(await authorizeTypingSender(access, pulse(aliceActor, context, await notifications.now() + 5000)));
    assert.equal(await authorizeTypingContext(access, viewerActor, context, 'read'), null, 'workspace membership does not grant DM access');
    expectStatus(await bob.browser.request('POST', `/api/v1/dms/${dm.id}/leave`), 204);
    assert.deepEqual(await authorizeTypingContext(access, aliceActor, context, 'read'), context);
    assert.equal(await authorizeTypingSender(access, pulse(aliceActor, context, await notifications.now() + 5000)), null);
    assert.equal(await authorizeTypingContext(access, bobActor, context, 'read'), null);
  });

  test('native Task access without the actual accepted discussion mapping creates no substitute root', async () => {
    const { room, context } = await conversation();
    const work = expectStatus(await alice.browser.request('POST', `/api/v1/projects/${room.id}/work`,
      { body: { title: 'Actual task', outcome: 'Typing alias integration', status: 'open' }, headers: { 'idempotency-key': randomUUID() } }), 201) as { id: string };
    const task: TypingContext = { kind: 'task', id: work.id };
    const count = await pool.query('SELECT count(*)::int AS n FROM project_conversations WHERE project_id = $1', [room.id]);
    assert.equal(await authorizeTypingContext(access, bobActor, task, 'read'), null);
    assert.deepEqual(await pool.query('SELECT count(*)::int AS n FROM project_conversations WHERE project_id = $1', [room.id]).then((r) => r.rows), count.rows);
    // Composition guard only: this fixture is not evidence of #154's actual root mapping.
    assert.deepEqual(await authorizeTypingContext(typingAccess(db, { conversation: async () => context.id }), bobActor, task, 'read'), context);
    const foreign = await conversation();
    assert.equal(await authorizeTypingContext(typingAccess(db, { conversation: async () => foreign.context.id }), bobActor, task, 'read'), null);
  });

  test('the production task alias resolves only the actual accepted discussion root, read-only and current', async () => {
    const production = typingAccess(db, typingTaskDiscussion(db));
    const { room } = await conversation();
    const work = expectStatus(await alice.browser.request('POST', `/api/v1/projects/${room.id}/work`,
      { body: { title: 'Wire the lamp sensor', outcome: 'Production typing alias', status: 'open' }, headers: { 'idempotency-key': randomUUID() } }), 201) as { id: string };
    const task: TypingContext = { kind: 'task', id: work.id };
    const roots = () => pool.query('SELECT count(*)::int AS n FROM project_conversations WHERE project_id = $1', [room.id]).then((r) => r.rows[0].n as number);
    const before = await roots();
    assert.equal(await authorizeTypingContext(production, bobActor, task, 'write'), null, 'no root before a genuine contribution');
    assert.equal(await roots(), before, 'reading the alias created no conversation');
    const message = expectStatus(await bob.browser.request('POST', `/api/v1/work/${work.id}/discussion`,
      { body: { body: 'Starting on the sensor wiring', clientMessageId: randomUUID() } }), 201) as { conversationId: string };
    const canonical = { kind: 'conversation' as const, id: message.conversationId };
    assert.deepEqual(await authorizeTypingContext(production, bobActor, task, 'write'), canonical, 'the task aliases its actual root');
    assert.deepEqual(await authorizeTypingContext(production, viewerActor, task, 'read'), canonical);
    assert.equal(await authorizeTypingContext(production, viewerActor, task, 'write'), null, 'a viewer cannot type into it');
    const outsiderActor = await actor(outsider);
    assert.equal(await authorizeTypingContext(production, outsiderActor, task, 'read'), null, 'no project access, no alias');
    assert.equal(await authorizeTypingContext(production, bobActor, { kind: 'task', id: randomUUID() }, 'read'), null, 'an unknown task is not an error');
    const grants = expectStatus(await alice.browser.request('GET', `/api/v1/projects/${room.id}/grants`), 200) as ProjectGrant[];
    const bobGrant = grants.find((row) => row.principal.kind === 'human' && row.principal.id === bob.id)!;
    expectStatus(await alice.browser.request('DELETE', `/api/v1/projects/${room.id}/grants/${bobGrant.id}`), 204);
    assert.equal(await authorizeTypingContext(production, bobActor, task, 'read'), null, 'a revoked grant ends the alias at once');
  });

  test('two independent LISTEN consumers receive bounded identifier-only pulses with no native/durable effect', async () => {
    const { context } = await conversation(); const published = pulse(aliceActor, context, 0);
    const received: string[][] = [[], []]; const ready = [false, false];
    const listeners = received.map((messages, index) => listen(connectionString!, TYPING_CHANNEL, (payload) => messages.push(payload), () => { ready[index] = true; }));
    try {
      await until(() => ready.every(Boolean), 'both actual LISTEN connections');
      const counts = () => pool.query(`SELECT
        (SELECT count(*) FROM events WHERE workspace_id = $1) AS events,
        (SELECT count(*) FROM outbox o JOIN events e ON e.id = o.event_id WHERE e.workspace_id = $1) AS outbox,
        (SELECT count(*) FROM event_audience a JOIN events e ON e.id = a.event_id WHERE e.workspace_id = $1) AS audience,
        (SELECT count(*) FROM project_messages WHERE workspace_id = $1) AS messages,
        (SELECT count(*) FROM notifications WHERE workspace_id = $1) AS notifications,
        (SELECT count(*) FROM pgboss.job WHERE data::text LIKE $2) AS jobs`, [ws.id, `%${context.id}%`]);
      const before = (await counts()).rows;
      const { expiresAt: ignoredExpiry, ...input } = published; void ignoredExpiry;
      input.context = { ...input.context };
      const pending = notifications.publish(input, 0);
      // The query is asynchronous: this must never change its returned/local metadata.
      input.actorId = outsider.id; input.sessionId = 'caller-mutated'; input.context.id = randomUUID();
      const update = await pending;
      assert.equal(update.actorId, alice.id); assert.equal(update.sessionId, aliceActor.sessionId); assert.equal(update.context.id, context.id);
      await until(() => received.every((messages) => messages.some((p) => decodeTypingPulse(p).connectionId === update.connectionId)), 'both notification deliveries');
      const now = await notifications.now(); assert.ok(update.expiresAt > now && update.expiresAt <= now + 5000);
      for (const messages of received) {
        const decoded = messages.map(decodeTypingPulse).find((p) => p.connectionId === update.connectionId)!;
        assert.deepEqual(decoded, update);
        assert.deepEqual(Object.keys(decoded).sort(), ['active', 'actorId', 'connectionId', 'context', 'expiresAt', 'sequence', 'sessionId']);
        assert.equal(JSON.stringify(decoded).includes('Actual shared native discussion'), false);
        assert.equal(JSON.stringify(decoded).includes(alice.email), false);
      }
      assert.deepEqual((await counts()).rows, before, 'no durable message/event/audience/outbox/notification/job rows');
      assert.deepEqual(await typingRows(db).currentHuman(aliceActor), { id: alice.id, name: 'typing-alice' });
    } finally { await Promise.all(listeners.map((listener) => listener.close())); }
  });

  test('actual listener loss signals uncertainty and reconnects without replaying old notifications', async () => {
    const channel = `flux_typing_test_${randomUUID().replaceAll('-', '')}`;
    let connects = 0; let errors = 0; const messages: string[] = [];
    const listener = listen(connectionString!, channel, (payload) => messages.push(payload), () => { connects++; }, () => { errors++; });
    try {
      await until(() => connects === 1, 'initial test LISTEN');
      await pool.query('SELECT pg_notify($1,$2)', [channel, 'before-loss']);
      await until(() => messages.length === 1, 'initial pulse');
      const backend = await pool.query('SELECT pid FROM pg_stat_activity WHERE query = $1', [`LISTEN "${channel}"`]);
      assert.equal(backend.rows.length, 1); await pool.query('SELECT pg_terminate_backend($1)', [backend.rows[0].pid]);
      await until(() => errors > 0, 'listener loss callback'); await until(() => connects >= 2, 'actual reconnect');
      await pool.query('SELECT pg_notify($1,$2)', [channel, 'after-reconnect']);
      await until(() => messages.length === 2, 'fresh pulse after reconnect');
      assert.deepEqual(messages, ['before-loss', 'after-reconnect']);
    } finally { await listener.close(); }
  });

  test('closing a real listener during initial connect never reports an obsolete readiness', async () => {
    let ready = 0; let errors = 0;
    const listener = listen(connectionString!, 'flux_typing_early_close', () => undefined, () => { ready++; }, () => { errors++; });
    await listener.close();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(ready, 0); assert.equal(errors, 0);
  });

  test('strict broker decoder rejects private extras, invalid identity and oversized payload without echo', async () => {
    const { context } = await conversation(); const update = pulse(aliceActor, context, await notifications.now() + 5000);
    assert.deepEqual(decodeTypingPulse(JSON.stringify(update)), update);
    for (const change of [{ name: 'secret-draft' }, { text: 'secret-draft' }, { sequence: 1.5 }, { active: 'yes' }, { connectionId: 'fake' }, { sessionId: 'secret\nvalue' }, { context: { ...context, token: 'secret-draft' } }]) {
      assert.throws(() => decodeTypingPulse(JSON.stringify({ ...update, ...change })), (error: unknown) => error instanceof Error && !error.message.includes('secret-draft'));
    }
    assert.throws(() => decodeTypingPulse('x'.repeat(2049)));
  });
});
