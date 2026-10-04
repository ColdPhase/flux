import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import { createDatabase,EDITING_CHANNEL } from '@flux/db';
import * as Y from 'yjs';
import { EDITING_LIMITS, type Doc, type LiveDocBootstrap, type LiveMapBootstrap, type LiveMapDelta, type LiveMapLease,
  type LiveReceipt, type Thought, type WikiTextEnvelope } from '@flux/contracts';
import { Browser, type ClientResponse } from '../support/http.js';

/** Explicitly selected against TWO running container processes. Not part of the ordinary one-API suite.
 * The runner supplies actual inspected IDs/image/process origins; neither two clients nor two in-process
 * Fastify instances prove replication. No application auth, policy, SQL or transport port is replaced.
 * This functional case is not the full-path browser p95 gate, nor API restart/offline acceptance. */
interface Inventory { schema: 1; sourceSha: string; apis: { apiInstance: string; apiUrl: string; containerId: string; imageId: string }[] }
interface Actor { id: string; name: string; email: string; browser: Browser }
interface Packet { header: Record<string, unknown>; bytes?: Buffer; at: number }
const finite = 5000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodyLimit = EDITING_LIMITS.assemblyBytes;
function status(response: ClientResponse, expected: number) {
  assert.equal(response.status, expected, response.text); return response.json;
}
async function inventory(): Promise<{ first: string; second: string; origin: string; source: Inventory }> {
  assert.equal(process.env.FLUX_LIVE_TWO_API, '1', 'This fixture requires an explicit isolated two-process selection');
  const path = process.env.FLUX_LIVE_TWO_API_INVENTORY;
  assert.ok(path, 'Runner must supply its actual Docker inspection inventory');
  const raw = await readFile(path, 'utf8'); assert.ok(Buffer.byteLength(raw) <= 16_384);
  const source = JSON.parse(raw) as Inventory;
  assert.equal(source.schema, 1); assert.match(source.sourceSha, /^[0-9a-f]{40}$/);
  assert.equal(source.apis.length, 2);
  const [a, b] = source.apis; assert.ok(a && b);
  for (const api of source.apis) {
    assert.match(api.apiInstance, /^[A-Za-z0-9_.-]{1,64}$/); assert.match(api.containerId, /^[0-9a-f]{64}$/);
    assert.match(api.imageId, /^sha256:[0-9a-f]{64}$/); assert.match(api.apiUrl, /^https?:\/\//);
  }
  assert.notEqual(a.containerId, b.containerId); assert.notEqual(a.apiInstance, b.apiInstance);
  assert.notEqual(a.apiUrl, b.apiUrl); assert.equal(a.imageId, b.imageId, 'Both actual API processes must execute the same image');
  const origin = process.env.FLUX_PUBLIC_ORIGIN; assert.ok(origin);
  assert.equal(new URL(origin).origin, origin);
  return { first: a.apiUrl, second: b.apiUrl, origin, source };
}
function browser(base: string, origin: string) {
  const result = new Browser(base, origin); const original = result.request.bind(result);
  result.request = (method, path, options = {}) => original(method, path,
    { ...options, headers: { host: new URL(origin).host, ...options.headers } });
  return result;
}
async function actor(base: string, origin: string, name: string): Promise<Actor> {
  const client = browser(base, origin); const email = `two-api-${randomUUID()}@example.test`;
  status(await client.request('POST', '/api/auth/sign-up/email', { body: { email, name, password: 'independent live process fixture' } }), 200);
  const me = status(await client.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
  return { id: me.user.id, email, name, browser: client };
}
class SocketClient {
  readonly packets: Packet[] = [];
  private readonly pending = new Map<string, { header: Record<string, unknown>; parts: Buffer[]; bytes: number }>();
  private error: Error | null = null;
  private waiters = new Set<() => void>();
  private constructor(readonly socket: WebSocket) {
    socket.on('error', (error: Error) => { this.error = error; this.wake(); });
    socket.on('close', () => this.wake());
    socket.on('message', (data: RawData, binary) => {
      try {
        assert.ok(Buffer.isBuffer(data)); assert.ok(data.byteLength <= EDITING_LIMITS.frameBytes);
        if (!binary) { this.keep({ header: JSON.parse(data.toString('utf8')) as Record<string, unknown>, at: performance.now() }); return; }
        const headerLength = data.readUInt32BE(0); assert.ok(headerLength > 0 && headerLength + 4 <= data.length);
        const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(4, headerLength + 4))) as Record<string, unknown>;
        assert.ok(typeof header.deliveryId === 'string' && uuid.test(header.deliveryId));
        assert.ok(Number.isInteger(header.index) && Number.isInteger(header.count));
        const index = Number(header.index), count = Number(header.count);
        assert.ok(count > 0 && count <= EDITING_LIMITS.chunks && index >= 0 && index < count);
        const chunk = Buffer.from(data.subarray(headerLength + 4)); assert.ok(chunk.length <= EDITING_LIMITS.chunkBytes);
        let assembly = this.pending.get(header.deliveryId);
        if (!assembly) { assert.equal(index, 0); assert.ok(this.pending.size < 2); assembly = { header, parts: [], bytes: 0 }; this.pending.set(header.deliveryId, assembly); }
        assert.equal(index, assembly.parts.length); assert.equal(count, assembly.header.count);
        for (const field of ['type','generation','sequence','commandId','hash']) assert.equal(header[field], assembly.header[field]);
        assembly.parts.push(chunk); assembly.bytes += chunk.length; assert.ok(assembly.bytes <= bodyLimit);
        this.send({ type: 'received', deliveryId: header.deliveryId, index });
        if (assembly.parts.length === count) {
          const bytes = Buffer.concat(assembly.parts); this.pending.delete(header.deliveryId);
          this.keep({ header: assembly.header, bytes, at: performance.now() });
        }
      } catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); this.socket.terminate(); this.wake(); }
    });
  }
  static async open(base: string, origin: string, actor: Actor, kind: 'map' | 'wiki', id: string) {
    const url = new URL(`/api/v1/editing?kind=${kind}&id=${id}`, base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { origin, host: new URL(origin).host, cookie: actor.browser.cookieHeader() }, perMessageDeflate: false });
    const client = new SocketClient(socket);
    await Promise.race([once(socket, 'open'), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Real editing socket did not open')), finite); timer.unref(); })]);
    return client;
  }
  send(value: unknown) { this.socket.send(JSON.stringify(value)); }
  update(envelope: WikiTextEnvelope, bytes: Uint8Array) {
    assert.ok(bytes.length > 0 && bytes.length <= bodyLimit);
    const count = Math.ceil(bytes.length / EDITING_LIMITS.chunkBytes); assert.ok(count <= EDITING_LIMITS.chunks);
    for (let index = 0; index < count; index++) {
      const header = Buffer.from(JSON.stringify({ ...envelope, index, count }));
      const chunk = bytes.subarray(index * EDITING_LIMITS.chunkBytes, (index + 1) * EDITING_LIMITS.chunkBytes);
      const frame = Buffer.alloc(4 + header.length + chunk.length); frame.writeUInt32BE(header.length); header.copy(frame, 4); frame.set(chunk, 4 + header.length);
      assert.ok(frame.length <= EDITING_LIMITS.frameBytes); this.socket.send(frame);
    }
  }
  private keep(packet: Packet) { assert.ok(this.packets.length < 2048, 'Finite fixture ledger'); this.packets.push(packet); this.wake(); }
  private wake() { for (const wake of this.waiters) wake(); }
  async wait(predicate: (packet: Packet) => boolean, timeout = finite): Promise<Packet> {
    const deadline = performance.now() + timeout;
    while (true) {
      if (this.error) throw this.error;
      const packet = this.packets.find(predicate); if (packet) return packet;
      assert.ok(this.socket.readyState === WebSocket.OPEN, 'Socket closed before required real delivery');
      const remaining = deadline - performance.now(); if (remaining <= 0) throw new Error('Required real delivery exceeded finite fixture deadline');
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        this.waiters.add(wake); timer = setTimeout(wake, remaining);
      });
    }
  }
  close() { this.socket.terminate(); this.pending.clear(); }
}
function decodedDelta(packet: Packet): LiveMapDelta {
  assert.equal(packet.header.type, 'map-delta'); assert.ok(packet.bytes);
  const delta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packet.bytes)) as LiveMapDelta;
  assert.equal(delta.sequence, packet.header.sequence); assert.equal(delta.commandId, packet.header.commandId); return delta;
}
const byCommand = (type: string, id: string) => (packet: Packet) => packet.header.type === type && packet.header.commandId === id;

test('two actual API processes deliver commit NOTIFY, pre-drop preview, character edits, protected presence and ordered missed-update catch-up', { timeout: 60_000 }, async (t) => {
  const env = await inventory();
  t.diagnostic(`actual process inventory source=${env.source.sourceSha} instances=${env.source.apis.map(api => api.apiInstance).join(',')} distinctContainers=true sameImage=true`);
  assert.ok(process.env.DATABASE_URL, 'Real database notification observation requires the isolated runner database');
  const database=createDatabase(process.env.DATABASE_URL);const notify=await database.pool.connect();const notices: string[] = [];
  await notify.query(`LISTEN ${EDITING_CHANNEL}`);
  notify.on('notification', message => { if (message.payload) { assert.ok(notices.length < 2048); notices.push(message.payload); } });
  const ada = await actor(env.first, env.origin, 'Ada Across APIs'); const kai = await actor(env.second, env.origin, 'Kai Across APIs');
  const sockets: SocketClient[] = []; const docs: Y.Doc[] = [];
  try {
    const workspace = status(await ada.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Two actual API processes' } }), 201) as { id: string };
    status(await ada.browser.request('POST', `/api/v1/workspaces/${workspace.id}/members`, { body: { email: kai.email, role: 'member' } }), 201);
    const project = status(await ada.browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: 'Actual cross-process room', visibility: 'restricted' } }), 201) as { id: string };
    const grant = status(await ada.browser.request('POST', `/api/v1/projects/${project.id}/grants`, { body: { principal: { kind: 'human', id: kai.id }, role: 'contributor' } }), 201) as { id: string };
    const sketch = status(await ada.browser.request('POST', `/api/v1/workspaces/${workspace.id}/sketches`, { body: { title: 'Cross-process map', scope: 'project', projectId: project.id } }), 201) as { id: string };
    const thoughts: Thought[] = [];
    for (let index = 0; index < 2; index++) {
      const result = status(await ada.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { text: `Thought ${index}`, x: index * 200, y: 40 }, headers: { 'idempotency-key': randomUUID() } }), 201) as { thought: Thought };
      thoughts.push(result.thought);
    }
    const [mapA, mapB] = await Promise.all([ada.browser.request('GET', `/api/v1/sketches/${sketch.id}/live`), kai.browser.request('GET', `/api/v1/sketches/${sketch.id}/live`)]);
    const headA = status(mapA, 200) as LiveMapBootstrap, headB = status(mapB, 200) as LiveMapBootstrap;
    assert.equal(headA.generation, headB.generation); assert.equal(headA.sequence,headB.sequence); assert.equal(headA.sketch.thoughts.length, 2);
    const mapStart=headA.sequence;notices.length=0;
    const mapWriter = await SocketClient.open(env.first, env.origin, ada, 'map', sketch.id), mapReader = await SocketClient.open(env.second, env.origin, kai, 'map', sketch.id); sockets.push(mapWriter, mapReader);
    for (const socket of [mapWriter, mapReader]) socket.send({ type: 'subscribe', generation: headA.generation, afterSequence: mapStart });
    await Promise.all([mapWriter.wait(packet => packet.header.type === 'head'), mapReader.wait(packet => packet.header.type === 'head')]);
    const gestureId = randomUUID();
    const lease = status(await ada.browser.request('POST', `/api/v1/sketches/${sketch.id}/live/gestures`, { body: { gestureId, thoughts: [{ id: thoughts[0]!.id, expectedVersion: 1 }] } }), 200) as LiveMapLease;
    mapWriter.send({ type: 'map-move', generation: headA.generation, gestureId, leaseId: lease.leaseId, sequence: 1, positions: [{ id: thoughts[0]!.id, x: 311, y: 222 }] });
    const preview = await mapReader.wait(packet => packet.header.type === 'map-move' && packet.header.leaseId === lease.leaseId);
    assert.deepEqual(preview.header.positions, [{ id: thoughts[0]!.id, x: 311, y: 222 }]); assert.equal((preview.header.actor as { id: string }).id, ada.id);
    const uncommitted = status(await kai.browser.request('GET', `/api/v1/sketches/${sketch.id}/live`), 200) as LiveMapBootstrap;
    assert.equal(uncommitted.sequence,mapStart); assert.equal(uncommitted.sketch.thoughts.find(thought => thought.id === thoughts[0]!.id)?.x, 0, 'Real preview arrives before any native drop');
    const peerCommand = randomUUID();
    status(await kai.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/thoughts/${thoughts[1]!.id}`, { body: { text: 'Independent peer change during drag', expectedVersion: 1 }, headers: { 'idempotency-key': peerCommand } }), 200);
    assert.equal(decodedDelta(await mapWriter.wait(byCommand('map-delta', peerCommand))).thoughts[0]?.text, 'Independent peer change during drag');
    assert.equal(decodedDelta(await mapReader.wait(byCommand('map-delta', peerCommand))).sequence,mapStart+1);
    const dropCommand = randomUUID(); const drop = { leaseId: lease.leaseId, moves: [{ id: thoughts[0]!.id, x: 311, y: 222, expectedVersion: 1 }] };
    status(await ada.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: drop, headers: { 'idempotency-key': dropCommand } }), 200);
    const dropped = decodedDelta(await mapReader.wait(byCommand('map-delta', dropCommand))); assert.equal(dropped.sequence,mapStart+2); assert.deepEqual(dropped.clearedLeaseIds, [lease.leaseId]);
    assert.equal(dropped.thoughts[0]?.x, 311); assert.ok(notices.includes(sketch.id), 'Real committed PostgreSQL identifier NOTIFY is observed separately');
    // Reconnect a reader on the second process from its original sequence. It receives the real ordered journal,
    // without a full-graph GET after each command. This is missed-delivery recovery, not a process-restart claim.
    mapReader.close(); const catchup = await SocketClient.open(env.second, env.origin, kai, 'map', sketch.id); sockets.push(catchup);
    catchup.send({ type: 'subscribe', generation: headA.generation, afterSequence:mapStart });
    assert.equal(decodedDelta(await catchup.wait(byCommand('map-delta', peerCommand))).sequence,mapStart+1);
    assert.equal(decodedDelta(await catchup.wait(byCommand('map-delta', dropCommand))).sequence,mapStart+2);

    const created = status(await ada.browser.request('POST', `/api/v1/projects/${project.id}/docs`, { body: { title: 'Cross-process live characters', body: 'Saved original. ', state: 'published' } }), 201) as Doc;
    const [docA, docB] = await Promise.all([ada.browser.request('GET', `/api/v1/docs/${created.id}/live`), kai.browser.request('GET', `/api/v1/docs/${created.id}/live`)]);
    const first = status(docA, 200) as LiveDocBootstrap, second = status(docB, 200) as LiveDocBootstrap;
    assert.equal(first.generation, second.generation); assert.equal(first.checkpoint, second.checkpoint);
    const a = new Y.Doc(), b = new Y.Doc(); docs.push(a, b);
    const enrollments:[Actor,Y.Doc][]=[[ada,a],[kai,b]];
    await Promise.all(enrollments.map(async ([who, document]) => {
      status(await who.browser.request('POST', `/api/v1/docs/${created.id}/live/enroll`, { body: { generation: first.generation, replicaId: document.clientID } }), 200);
    }));
    Y.applyUpdate(a, Buffer.from(first.checkpoint, 'base64')); Y.applyUpdate(b, Buffer.from(second.checkpoint, 'base64'));
    const wikiWriter = await SocketClient.open(env.first, env.origin, ada, 'wiki', created.id), wikiPeer = await SocketClient.open(env.second, env.origin, kai, 'wiki', created.id); sockets.push(wikiWriter, wikiPeer);
    for (const socket of [wikiWriter, wikiPeer]) socket.send({ type: 'subscribe', generation: first.generation, afterSequence: 0 });
    await Promise.all([wikiWriter.wait(packet => packet.header.type === 'head'), wikiPeer.wait(packet => packet.header.type === 'head')]);
    const make = (who: Actor, document: Y.Doc, text: string) => {
      const before = Y.encodeStateVector(document); document.getText('body').insert(first.body.length, text);
      const envelope: WikiTextEnvelope = { workspace: first.workspaceId, kind: 'wiki', room: created.id, generation: first.generation,
        actor: who.id, operation: 'text', uuid: randomUUID(), replica: document.clientID, parameters: null };
      return { envelope, bytes: Y.encodeStateAsUpdate(document, before) };
    };
    const own = make(ada, a, 'Ada concurrent 🚀. '), other = make(kai, b, 'Kai concurrent é. ');
    wikiWriter.update(own.envelope, own.bytes); wikiPeer.update(other.envelope, other.bytes);
    const [ackA, ackB] = await Promise.all([wikiWriter.wait(byCommand('ack', own.envelope.uuid)), wikiPeer.wait(byCommand('ack', other.envelope.uuid))]);
    assert.deepEqual([ackA.header.sequence, ackB.header.sequence].sort(), [1,2]);
    const [receivedA, receivedB] = await Promise.all([wikiWriter.wait(byCommand('update', other.envelope.uuid)), wikiPeer.wait(byCommand('update', own.envelope.uuid))]);
    assert.ok(receivedA.bytes && receivedB.bytes); Y.applyUpdate(a, receivedA.bytes); Y.applyUpdate(b, receivedB.bytes);
    assert.equal(a.getText('body').toString(), b.getText('body').toString()); assert.match(a.getText('body').toString(), /Ada concurrent 🚀/); assert.match(a.getText('body').toString(), /Kai concurrent/);
    const position = Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(a.getText('body'), 2))).toString('base64');
    wikiWriter.send({ type: 'cursor', generation: first.generation, cursor: { anchor: position, head: position } });
    const named = await wikiPeer.wait(packet => packet.header.type === 'presence' && (packet.header.actor as { id: string } | undefined)?.id === ada.id);
    assert.equal((named.header.actor as { name: string }).name, ada.name);
    assert.equal((status(await kai.browser.request('GET', `/api/v1/docs/${created.id}`), 200) as Doc).body, created.body, 'Character edits preserve saved material until Save');
    status(await ada.browser.request('PATCH', `/api/v1/docs/${created.id}`, { body: { body: 'Old API must not overwrite shared text' }, headers: { 'if-match': '"1"' } }), 409);
    const acknowledged = status(await kai.browser.request('GET', `/api/v1/docs/${created.id}/live`), 200) as LiveDocBootstrap;
    assert.equal(acknowledged.sequence, 2); assert.equal(acknowledged.body, a.getText('body').toString());
    const save = { clientCommandId: randomUUID(), expectedVersion: 1, generation: first.generation, headSequence: acknowledged.sequence, headHash: acknowledged.hash, reason: 'Actual independent API process fixture' };
    const receipt = status(await ada.browser.request('POST', `/api/v1/docs/${created.id}/live/save`, { body: save }), 200) as LiveReceipt;
    assert.equal(receipt.savedDoc?.version, 2); assert.equal(receipt.savedDoc?.body, acknowledged.body);
    const originalActorOnSecondApi = browser(env.second, env.origin);
    for (const [name,value] of ada.browser.cookies) originalActorOnSecondApi.cookies.set(name,value);
    assert.deepEqual(status(await originalActorOnSecondApi.request('POST', `/api/v1/docs/${created.id}/live/save`, { body: save }), 200), receipt, 'Original authenticated actor retries the immutable Save on the second actual process');
    assert.equal((status(await kai.browser.request('GET', `/api/v1/docs/${created.id}/versions/1`), 200) as Doc).body, created.body);
    assert.ok(notices.includes(created.id), 'Wiki COMMIT publishes real PostgreSQL identifier NOTIFY');
    status(await ada.browser.request('DELETE', `/api/v1/projects/${project.id}/grants/${grant.id}`), 204);
    await wikiPeer.wait(packet => packet.header.type === 'revoked');
    status(await kai.browser.request('GET', `/api/v1/docs/${created.id}/live`), 404);
    t.diagnostic(`cross-process functional receipts map=2 wiki=2; real NOTIFY rooms=2; missed-delivery ordered catchup=2; savedVersion=2; old-client dirty409; named presence/current revocation. Browser DOM latency and API restart remain separate required gates.`);
  } finally { for (const socket of sockets) socket.close(); for (const document of docs) document.destroy();notify.release();await database.pool.end(); }
});
