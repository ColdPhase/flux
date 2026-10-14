import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditingConnection } from '../../apps/web/src/editing/wire.js';

// A controlled browser socket: enough of WebSocket for EditingConnection, with no network.
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;
  readyState = FakeSocket.CONNECTING;
  binaryType = '';
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: URL) { FakeSocket.last = this; }
  send(frame: string) { this.sent.push(frame); }
  close() { this.readyState = FakeSocket.CLOSED; }
}

test('a cursor set while the wiki socket is still connecting is sent after its subscription', () => {
  const globals = globalThis as Record<string, unknown>;
  const saved = { WebSocket: globals.WebSocket, location: globals.location, window: globals.window };
  globals.WebSocket = FakeSocket;
  globals.location = { origin: 'http://flux.test', protocol: 'http:' };
  globals.window = { setInterval: () => 1, clearInterval: () => {} };
  try {
    const connection = new EditingConnection('wiki', 'doc-1', 'generation-1', 0, () => {}, () => {});
    const socket = FakeSocket.last!;
    // The editor's cursor timer fires before the socket has opened (e.g. after a reconnect).
    connection.send({ type: 'cursor', generation: 'generation-1', cursor: null });
    assert.deepEqual(socket.sent, []);
    socket.readyState = FakeSocket.OPEN;
    socket.onopen!();
    // The server refuses a cursor that arrives before its subscription (INVALID_CURSOR), so the
    // subscription must be the first frame on every connection.
    assert.deepEqual(socket.sent.map((frame) => JSON.parse(frame).type), ['subscribe', 'cursor']);
    assert.equal(JSON.parse(socket.sent[0]!).generation, 'generation-1');
    connection.close();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globals[key]; else globals[key] = value;
    }
  }
});
