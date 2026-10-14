import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import type { EditingServerMessage, LiveDocBootstrap } from '@flux/contracts';
import { SharedWiki } from '../../apps/web/src/editing/wiki.js';
import { encode64 } from '../../apps/web/src/editing/wire.js';

// A controlled browser socket: enough of WebSocket for EditingConnection, with no network.
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;
  readyState = FakeSocket.CONNECTING;
  binaryType = '';
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: URL) { FakeSocket.last = this; }
  send(frame: string | ArrayBuffer) { this.sent.push(frame); }
  close() { this.readyState = FakeSocket.CLOSED; }
  /** Text intents in sending order: their envelope UUIDs. */
  get texts() {
    return this.sent.filter((frame): frame is ArrayBuffer => typeof frame !== 'string').map((frame) => {
      const length = new DataView(frame).getUint32(0);
      return (JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4, length))) as { uuid: string }).uuid;
    });
  }
  get cursors() {
    return this.sent.filter((frame): frame is string => typeof frame === 'string').map((frame) => JSON.parse(frame) as { type: string; cursor?: unknown })
      .filter((frame) => frame.type === 'cursor');
  }
  receive(message: EditingServerMessage) { this.onmessage!({ data: JSON.stringify(message) }); }
}

async function observed(condition: () => boolean, label: string) {
  for (let waited = 0; !condition() && waited < 2000; waited += 5) await delay(5);
  assert.ok(condition(), label);
}

/** One live writer against a controlled server: real Yjs, SharedWiki and EditingConnection. */
async function live(t: { after: (fn: () => void) => void }) {
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(['WebSocket', 'location', 'window', 'sessionStorage', 'fetch'].map((key) => [key, globals[key]]));
  const storage = new Map<string, string>();
  const workspaceId = randomUUID(), docId = randomUUID(), generation = randomUUID(), userId = randomUUID();
  const server = new Y.Doc(); server.getText('body').insert(0, 'Shared starting text');
  const bootstrap: LiveDocBootstrap = { kind: 'wiki', workspaceId, resourceId: docId, generation, sequence: 0, hash: 'h0',
    savedVersion: 1, savedSequence: 0, body: 'Shared starting text', html: '<p>Shared starting text</p>', mentions: [],
    checkpoint: encode64(Y.encodeStateAsUpdate(server)), stateVector: encode64(Y.encodeStateVector(server)), canWrite: true,
    actor: { kind: 'human', id: userId, name: 'Ada North' } };
  globals.WebSocket = FakeSocket;
  globals.location = { origin: 'http://flux.test', protocol: 'http:' };
  globals.window = { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {}, removeEventListener: () => {} };
  globals.sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); } };
  globals.fetch = async (path: string, init: { method?: string; body?: string }) => {
    const body = init.method === 'POST' && path.endsWith('/enroll')
      ? { generation, replicaId: (JSON.parse(init.body!) as { replicaId: number }).replicaId, instanceId: randomUUID() }
      : bootstrap;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
  };
  FakeSocket.last = null;
  const wiki = new SharedWiki(docId, userId);
  t.after(() => {
    wiki.destroy(); server.destroy();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globals[key]; else globals[key] = value; }
  });
  await observed(() => FakeSocket.last !== null, 'The live connection opens after enrollment');
  const socket = FakeSocket.last!;
  socket.readyState = FakeSocket.OPEN; socket.onopen!();
  socket.receive({ type: 'head', kind: 'wiki', workspaceId, resourceId: docId, generation, sequence: 0, hash: 'h0', savedVersion: 1, canWrite: true,
    actor: { kind: 'human', id: userId, name: 'Ada North' } });
  assert.equal(wiki.editable, true);
  let sequence = 0;
  const ack = (commandId: string) => socket.receive({ type: 'ack', workspaceId, resourceId: docId, generation, sequence: ++sequence,
    hash: `h${sequence}`, commandId, operation: 'text', fingerprint: 'f', changed: true });
  const type = (character: string) => wiki.text.insert(wiki.text.length, character);
  return { wiki, socket, ack, type };
}

test('typing while a command awaits its receipt becomes one next command, not a queue of 40 ms commands', async (t) => {
  const { wiki, socket, ack, type } = await live(t);
  type('a');
  await observed(() => socket.texts.length === 1, 'The first batch is sealed and sent after 40 ms');
  // The server takes several batch windows to admit it; typing continues meanwhile.
  for (const character of 'bcd') { type(character); await delay(60); }
  assert.equal(socket.texts.length, 1, 'One command at a time is in flight');
  assert.equal(wiki.sealedBatches.length, 1, 'Later input is not sealed into commands queued behind the first');
  assert.equal(wiki.pendingCount, 2, 'The in-flight command and one open batch');
  ack(socket.texts[0]!);
  await observed(() => socket.texts.length === 2, 'The receipt sends the next batch');
  assert.deepEqual(wiki.sealedBatches.map(({ from, to }) => ({ from, to })), [{ from: 1, to: 1 }, { from: 2, to: 4 }]);
  assert.equal(socket.texts[1], wiki.sealedBatches[1]!.commandId);
  ack(socket.texts[1]!);
  assert.equal(wiki.pendingCount, 0);
});

test('a cursor inside not yet admitted own text waits for its receipt; admitted positions go at once', async (t) => {
  const { wiki, socket, ack, type } = await live(t);
  wiki.setCursor(3, 3);
  await observed(() => socket.cursors.length === 1, 'A cursor in admitted text is published after 40 ms');
  type('x');
  await observed(() => socket.texts.length === 1, 'The typed character is in flight');
  // Selecting the just-typed character names an item the server has not admitted yet.
  wiki.setCursor(wiki.text.length - 1, wiki.text.length);
  await delay(100);
  assert.equal(socket.cursors.length, 1, 'The server would refuse this position (INVALID_CURSOR)');
  ack(socket.texts[0]!);
  assert.equal(socket.cursors.length, 2, 'The receipt publishes the waiting cursor');
  const expected = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(wiki.text, wiki.text.length - 1));
  assert.equal((socket.cursors[1]!.cursor as { anchor: string }).anchor, encode64(expected));
});
