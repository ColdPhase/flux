import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import type { Doc, LiveDocBootstrap, LiveMapBootstrap, WikiTextEnvelope } from '@flux/contracts';
import { Browser, publicOrigin } from './support/http.js';
import { expectStatus } from './support/people.js';

// Actual production API processes, real OAuth-independent person sessions, PostgreSQL and native
// editing transport. Restarting with the operator opt-out must retain acknowledged unsaved text.
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function deadline<T>(work: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function api(mode: 'default' | 'off') {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY: '1',
    FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE: 'promotion-check' };
  delete env.FLUX_LIVE_EDITING; delete env.FLUX_DEVELOPMENT_LIVE_EDITING;
  if (mode === 'off') { env.FLUX_LIVE_EDITING = 'off'; env.FLUX_DEVELOPMENT_LIVE_EDITING = 'true'; }
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const record = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  const done = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    child.kill('SIGTERM');
    try { assert.equal(await deadline(done, 'API did not stop gracefully'), 0, output); }
    catch (error) { child.kill('SIGKILL'); await done; throw error; }
    assert.ok(!output.includes('FLUX_LIVE_QUEUE'), 'normal live and explicit off both emit no calibration telemetry');
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    await deadline((async () => {
      for (;;) {
        const healthy = await fetch(`${base}/api/v1/health`).then(r => r.ok).catch(() => false);
        if (healthy) return;
        if (child.exitCode !== null) throw new Error(`API startup failed: ${output}`);
        await delay(50);
      }
    })(), 'API did not become healthy', 20_000);
  } catch (error) { await stop(); throw error; }
  const client = (previous?: Browser) => {
    const browser = new Browser(base, publicOrigin);
    for (const [name, value] of previous?.cookies ?? []) browser.cookies.set(name, value);
    const request = browser.request.bind(browser);
    browser.request = (method, path, options = {}) => request(method, path, { ...options,
      headers: { host: new URL(publicOrigin).host, ...options.headers } });
    return browser;
  };
  return { base, client, stop };
}

test('normal install live ACK survives off/native refusal, re-enable recovery/Save and a later ordinary edit', { timeout: 120_000 }, async () => {
  let server = await api('default'); let socket: WebSocket | undefined;
  const document = new Y.Doc();
  try {
    let browser = server.client();
    assert.deepEqual(expectStatus(await browser.request('GET', '/api/v1/live-editing/capabilities'), 200), { status: 'configured' });
    expectStatus(await browser.request('POST', '/api/auth/sign-up/email', { body: { email: `promotion-${randomUUID()}@example.test`,
      password: 'retain the shared working text', name: 'Production writer' } }), 200);
    const me = expectStatus(await browser.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
    const ws = expectStatus(await browser.request('POST', '/api/v1/workspaces', { body: { name: 'Promotion recovery' } }), 201) as { id: string };
    const project = expectStatus(await browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
      { body: { name: 'Normal collaboration', visibility: 'restricted' } }), 201) as { id: string };
    const doc = expectStatus(await browser.request('POST', `/api/v1/projects/${project.id}/docs`,
      { body: { title: 'Retained text', body: 'Saved version.' } }), 201) as Doc;
    const map = expectStatus(await browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`,
      { body: { title: 'Normal live map', scope: 'project', projectId: project.id } }), 201) as { id: string };
    const mapHead = expectStatus(await browser.request('GET', `/api/v1/sketches/${map.id}/live`), 200) as LiveMapBootstrap;
    assert.equal(mapHead.resourceId, map.id); assert.equal(mapHead.canWrite, true);
    const head = expectStatus(await browser.request('GET', `/api/v1/docs/${doc.id}/live`), 200) as LiveDocBootstrap;
    Y.applyUpdate(document, Buffer.from(head.checkpoint, 'base64'));
    expectStatus(await browser.request('POST', `/api/v1/docs/${doc.id}/live/enroll`,
      { body: { generation: head.generation, replicaId: document.clientID } }), 200);
    const before = Y.encodeStateVector(document); document.getText('body').insert(head.body.length, ' Acknowledged before disable.');
    const envelope: WikiTextEnvelope = { workspace: ws.id, kind: 'wiki', room: doc.id, generation: head.generation,
      actor: me.user.id, operation: 'text', uuid: randomUUID(), replica: document.clientID, parameters: null };
    const url = new URL(`/api/v1/editing?kind=wiki&id=${doc.id}`, server.base); url.protocol = 'ws:';
    socket = new WebSocket(url, { headers: { origin: publicOrigin, host: new URL(publicOrigin).host,
      cookie: browser.cookieHeader() }, perMessageDeflate: false });
    const ack = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket!.on('message', (data, binary) => {
        if (binary) return;
        const value = JSON.parse(data.toString()) as Record<string, unknown>;
        if (value.type === 'error' || value.type === 'revoked') reject(new Error(JSON.stringify(value)));
        if (value.type === 'ack' && value.commandId === envelope.uuid) resolve(value);
      });
      socket!.once('error', reject);
    });
    await deadline(once(socket, 'open'), 'Default live editing socket did not open');
    socket.send(JSON.stringify({ type: 'subscribe', generation: head.generation, afterSequence: head.sequence }));
    const header = Buffer.from(JSON.stringify({ ...envelope, index: 0, count: 1 }));
    const bytes = Buffer.from(Y.encodeStateAsUpdate(document, before));
    const frame = Buffer.alloc(4 + header.length + bytes.length); frame.writeUInt32BE(header.length); header.copy(frame, 4); bytes.copy(frame, 4 + header.length);
    socket.send(frame); assert.equal((await deadline(ack, 'No durable live ACK')).sequence, 1);
    const closed = once(socket, 'close'); socket.close(); await deadline(closed, 'Writer socket did not close'); socket = undefined;
    assert.equal((expectStatus(await browser.request('GET', `/api/v1/docs/${doc.id}`), 200) as Doc).body, doc.body);
    await server.stop();

    server = await api('off'); browser = server.client(browser);
    assert.deepEqual(expectStatus(await browser.request('GET', '/api/v1/live-editing/capabilities'), 200), { status: 'unavailable' });
    expectStatus(await browser.request('GET', `/api/v1/docs/${doc.id}/live`), 503);
    for (const body of [{ body: 'Do not overwrite acknowledged text.' }, { title: 'Do not bypass the dirty fence.' }]) {
      const refused = await browser.request('PATCH', `/api/v1/docs/${doc.id}`, { body, headers: { 'if-match': '"1"' } });
      assert.equal(refused.status, 409, refused.text); assert.equal((refused.json as { code: string }).code, 'DOC_LIVE_WORKING_COPY_CHANGED');
    }
    assert.equal((expectStatus(await browser.request('GET', `/api/v1/docs/${doc.id}/versions/1`), 200) as Doc).body, doc.body);
    await server.stop();

    server = await api('default'); browser = server.client(browser);
    const recovered = expectStatus(await browser.request('GET', `/api/v1/docs/${doc.id}/live`), 200) as LiveDocBootstrap;
    assert.equal(recovered.generation, head.generation); assert.equal(recovered.sequence, 1);
    assert.equal(recovered.body, document.getText('body').toString());
    const saved = expectStatus(await browser.request('POST', `/api/v1/docs/${doc.id}/live/save`, { headers: { 'if-match': '"1"' }, body: {
      clientCommandId: randomUUID(), expectedVersion: 1, generation: recovered.generation, headSequence: recovered.sequence,
      headHash: recovered.hash, reason: 'Recovered before planned disable' } }), 200) as { savedDoc: Doc };
    assert.equal(saved.savedDoc.body, recovered.body); assert.equal(saved.savedDoc.version, 2);
    assert.deepEqual(saved.savedDoc.contributors?.map(actor => actor.id), [me.user.id]);
    await server.stop();

    server = await api('off'); browser = server.client(browser);
    const ordinary = expectStatus(await browser.request('PATCH', `/api/v1/docs/${doc.id}`, { body: { body: recovered.body + ' Ordinary continuation.' },
      headers: { 'if-match': '"2"' } }), 200) as Doc;
    assert.equal(ordinary.version, 3); assert.equal(ordinary.body, recovered.body + ' Ordinary continuation.');
    assert.equal((expectStatus(await browser.request('GET', `/api/v1/docs/${doc.id}/versions/2`), 200) as Doc).body, recovered.body);
    assert.equal((expectStatus(await browser.request('GET', `/api/v1/docs/${doc.id}/versions/1`), 200) as Doc).body, doc.body);
  } finally { socket?.terminate(); document.destroy(); await server.stop(); }
});
