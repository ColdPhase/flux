import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { Conversation, TypingContext, Workspace } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, secondSession, workspace, type Person } from './support/people.js';
import { Browser } from './support/http.js';
import { TypingClient } from './support/typing.js';

const { pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
describe('actual same-origin ephemeral human typing WebSocket', () => {
  let alice: Person; let bob: Person; let viewer: Person; let outsider: Person; let ws: Workspace;
  const clients = new Set<TypingClient>();
  before(async () => {
    [alice, bob, viewer, outsider] = await Promise.all(['socket-alice', 'socket-bob', 'socket-viewer', 'socket-outsider'].map(person));
    ws = await workspace(alice, 'Socket typing');
    await addMember(alice, ws.id, bob, 'member'); await addMember(alice, ws.id, viewer, 'member');
  });
  after(async () => { await Promise.all([...clients].map((client) => client.close())); });
  async function connect(browser: Browser) { const client = await TypingClient.connect(browser); clients.add(client); return client; }
  async function conversation() {
    const room = await project(alice, ws.id, 'Typing socket restricted', 'restricted');
    await grant(alice, room.id, bob, 'contributor'); await grant(alice, room.id, viewer, 'viewer');
    const native = expectStatus(await alice.browser.request('POST', `/api/v1/projects/${room.id}/conversations`,
      { body: { body: 'Native conversation, not a presence event', clientMessageId: randomUUID() } }), 201) as Conversation;
    return { room, context: { kind: 'conversation' as const, id: native.id } };
  }
  async function pair(context: TypingContext) {
    const [sender, receiver] = await Promise.all([connect(alice.browser), connect(bob.browser)]);
    await Promise.all([sender.watch(context), receiver.watch(context)]);
    return { sender, receiver };
  }
  const visible = (client: TypingClient, id: string) => client.messages.at(-1)?.people.some((human) => human.id === id) === true;
  const absent = (client: TypingClient, id: string) => client.messages.at(-1)?.people.every((human) => human.id !== id) === true;

  test('two actual accounts receive names only; immediate stop is nondurable and self is excluded', async () => {
    const { context } = await conversation(); const { sender, receiver } = await pair(context);
    assert.deepEqual(sender.frames[0], { type: 'identity', id: alice.id });
    assert.deepEqual(receiver.frames[0], { type: 'identity', id: bob.id });
    assert.equal(sender.frames.filter((frame) => frame.type === 'identity').length, 1);
    const counts = () => pool.query(`SELECT
      (SELECT count(*) FROM events WHERE workspace_id = $1) AS events,
      (SELECT count(*) FROM project_messages WHERE workspace_id = $1) AS messages,
      (SELECT count(*) FROM notifications WHERE workspace_id = $1) AS notifications,
      (SELECT count(*) FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.workspace_id = $1) AS outbox,
      (SELECT count(*) FROM event_audience a JOIN events e ON e.id=a.event_id WHERE e.workspace_id=$1) AS audience`, [ws.id]);
    const baseline = (await counts()).rows;
    const start = performance.now(); sender.send({ type: 'active', active: true });
    await receiver.until(() => visible(receiver, alice.id), 'remote person', 2000);
    const activeMs = performance.now() - start;
    const frame = receiver.messages.at(-1)!;
    assert.deepEqual(frame, { type: 'snapshot', context, availability: 'ready', people: [{ id: alice.id, name: 'socket-alice' }] });
    assert.equal(visible(sender, alice.id), false);
    const stopAt = performance.now(); sender.send({ type: 'active', active: false });
    await receiver.until(() => absent(receiver, alice.id), 'immediate stop', 750);
    console.log(JSON.stringify({ typingSocket: 'two-account', activeMs, stopMs: performance.now() - stopAt }));
    assert.deepEqual((await counts()).rows, baseline, 'no messages, events, notification or durable audience changes');
    await Promise.all([sender.close(), receiver.close()]);
  });

  test('newer scope B withdraws A even when only A has a receiving observer', async () => {
    const a = await conversation(); const b = await conversation(); const { sender, receiver } = await pair(a.context);
    sender.send({ type: 'active', active: true }); await receiver.until(() => visible(receiver, alice.id), 'A activity');
    const at = performance.now(); sender.send({ type: 'watch', context: b.context });
    await receiver.until(() => absent(receiver, alice.id), 'A clears on B watch', 750);
    const stopMs = performance.now() - at;
    await sender.until(() => sender.messages.at(-1)?.context.id === b.context.id, 'canonical B watch');
    await new Promise((resolve) => setTimeout(resolve, 1050));
    sender.send({ type: 'active', active: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(absent(receiver, alice.id));
    console.log(JSON.stringify({ typingSocket: 'scope-switch', stopMs }));
    await Promise.all([sender.close(), receiver.close()]);
  });

  test('unchanged checked snapshots renew application freshness without a new durable event', async () => {
    const { context } = await conversation(); const { sender, receiver } = await pair(context);
    sender.send({ type: 'active', active: true });
    await receiver.until(() => visible(receiver, alice.id), 'current active snapshot');
    const start = receiver.messages.length;
    const active = receiver.messages.at(-1);
    await receiver.until(() => receiver.messages.length >= start + 2, 'two checked heartbeat renewals', 3000);
    assert.deepEqual(receiver.messages.at(-1), active);
    assert.equal(receiver.frames.filter((frame) => frame.type === 'identity').length, 1);
    await Promise.all([sender.close(), receiver.close()]);
  });

  test('reader can observe but cannot publish; foreign and unknown contexts reveal no names', async () => {
    const { context } = await conversation();
    const [sender, reader, foreign] = await Promise.all([connect(alice.browser), connect(viewer.browser), connect(outsider.browser)]);
    await Promise.all([sender.watch(context), reader.watch(context), foreign.watch(context, 'unavailable')]);
    reader.send({ type: 'active', active: true }); sender.send({ type: 'active', active: true });
    await reader.until(() => visible(reader, alice.id), 'reader receives current writer');
    assert.equal(visible(sender, viewer.id), false);
    assert.deepEqual(foreign.messages.at(-1)?.people, []);
    foreign.send({ type: 'watch', context: { ...context, id: randomUUID() } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(foreign.messages.every((frame) => frame.availability === 'unavailable' && !frame.people.length));
    await Promise.all([sender.close(), reader.close(), foreign.close()]);
  });

  test('current writer downgrade and recipient denial withdraw on checked heartbeat', async () => {
    const { context, room } = await conversation();
    const [sender, receiver] = await Promise.all([connect(bob.browser), connect(alice.browser)]);
    await Promise.all([sender.watch(context), receiver.watch(context)]);
    sender.send({ type: 'active', active: true }); await receiver.until(() => visible(receiver, bob.id), 'Bob typing');
    await grant(alice, room.id, bob, 'viewer'); const changed = performance.now();
    await receiver.until(() => absent(receiver, bob.id), 'writer revoked', 2000);
    console.log(JSON.stringify({ typingSocket: 'writer-revoked', withdrawMs: performance.now() - changed }));
    receiver.send({ type: 'active', active: true }); await sender.until(() => visible(sender, alice.id), 'reader still observes');
    await grant(alice, room.id, bob, 'denied'); const denied = performance.now();
    await sender.until(() => sender.messages.at(-1)?.availability === 'unavailable' && absent(sender, alice.id), 'reader revoked', 2000);
    console.log(JSON.stringify({ typingSocket: 'reader-revoked', withdrawMs: performance.now() - denied }));
    await Promise.all([sender.close(), receiver.close()]);
  });

  test('exact sender session deletion withdraws despite another live session of the same human', async () => {
    const { context } = await conversation(); const session = await secondSession(alice);
    const [sender, receiver] = await Promise.all([connect(session.browser), connect(bob.browser)]);
    await Promise.all([sender.watch(context), receiver.watch(context)]);
    sender.send({ type: 'active', active: true }); await receiver.until(() => visible(receiver, alice.id), 'session typing');
    await pool.query('DELETE FROM auth_sessions WHERE id=$1 AND user_id=$2', [session.sessionId, alice.id]);
    const revoked = performance.now(); await receiver.until(() => absent(receiver, alice.id), 'exact sender session revoked', 2000);
    console.log(JSON.stringify({ typingSocket: 'session-revoked', withdrawMs: performance.now() - revoked }));
    assert.equal((await alice.browser.request('GET', '/api/v1/me')).status, 200);
    await assert.rejects(TypingClient.connect(session.browser), /401/);
    await Promise.all([sender.close(), receiver.close()]);
  });

  test('same human sessions deduplicate; idle expiry and disconnect leave no stale activity', async () => {
    const { context } = await conversation(); const session = await secondSession(alice);
    const [first, second, receiver] = await Promise.all([connect(alice.browser), connect(session.browser), connect(bob.browser)]);
    await Promise.all([first.watch(context), second.watch(context), receiver.watch(context)]);
    first.send({ type: 'active', active: true }); second.send({ type: 'active', active: true });
    await receiver.until(() => visible(receiver, alice.id), 'deduplicated person');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receiver.messages.at(-1)?.people.length, 1);
    const at = performance.now(); first.send({ type: 'active', active: false });
    await new Promise((resolve) => setTimeout(resolve, 200)); assert.ok(visible(receiver, alice.id), 'other exact session still active');
    await receiver.until(() => absent(receiver, alice.id), 'idle publication expires', 6000);
    console.log(JSON.stringify({ typingSocket: 'idle-expiry', expiryMs: performance.now() - at }));
    first.send({ type: 'active', active: true }); await receiver.until(() => visible(receiver, alice.id), 'fresh activity');
    const disconnect = performance.now(); await first.close();
    await receiver.until(() => absent(receiver, alice.id), 'clean disconnect', 750);
    console.log(JSON.stringify({ typingSocket: 'disconnect', stopMs: performance.now() - disconnect }));
    await Promise.all([second.close(), receiver.close()]);
  });

  test('upgrades require exact origin/session and eight-socket human cap releases after close', async () => {
    await assert.rejects(TypingClient.connect(alice.browser, 'https://evil.example'), /403/);
    await assert.rejects(TypingClient.connect(alice.browser, null), /403/);
    await assert.rejects(TypingClient.connect(new Browser()), /401/);
    const sockets: TypingClient[] = [];
    try {
      for (let i = 0; i < 8; i++) sockets.push(await connect(outsider.browser));
      await assert.rejects(TypingClient.connect(outsider.browser), /503/);
      await sockets.pop()!.close();
      const replacement = await connect(outsider.browser); sockets.push(replacement);
    } finally { await Promise.all(sockets.map((socket) => socket.close())); }
  });

  test('unwatched exact session revocation closes idle transport and releases its admission', async () => {
    const session = await secondSession(alice); const idle = await connect(session.browser);
    await pool.query('DELETE FROM auth_sessions WHERE id=$1 AND user_id=$2', [session.sessionId, alice.id]);
    const code = await Promise.race([idle.closed, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))]);
    assert.equal(code, 4401);
    const replacement = await connect(alice.browser); await replacement.close();
  });

  test('private extras, binary frames, oversized input and command flood close without echo', async () => {
    for (const payload of [JSON.stringify({ type: 'active', active: true, text: 'PRIVATE-DRAFT' }), Buffer.from('binary'), 'x'.repeat(1025)]) {
      const client = await connect(alice.browser); client.socket.send(payload);
      const code = await client.closed; assert.ok(code === 1008 || code === 1009);
      assert.ok(client.messages.every((frame) => !JSON.stringify(frame).includes('PRIVATE-DRAFT')));
    }
    const flood = await connect(alice.browser);
    for (let i = 0; i < 12; i++) flood.send({ type: 'active', active: false });
    assert.equal(await flood.closed, 1008);
  });
});
