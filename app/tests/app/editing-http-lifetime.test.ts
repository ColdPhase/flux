import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request, createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase, EditingTransactionError } from '@flux/db';
import { createProject, createWorkspace, VersionConflictError } from '@flux/core';
import type { Doc, LiveMapBootstrap, Sketch, Thought } from '@flux/contracts';
import { registerIdentity, loadIdentityConfig } from '../../apps/server/src/identity/index.js';
import { docRoutes } from '../../apps/server/src/docs/routes.js';
import { sketchRoutes } from '../../apps/server/src/sketches/routes.js';
import { editingRoutes } from '../../apps/server/src/editing/routes.js';
import { mapBackend } from '../../apps/server/src/editing/map-backend.js';
import { mapAuthority } from '../../apps/server/src/editing/map-authority.js';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import { editingHTTPLifetime } from '../../apps/server/src/editing/http-lifetime.js';
import { apiEditingOutputBudget, EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { Browser } from './support/http.js';
import { expectStatus } from './support/people.js';
import { connectionString, pool } from './support/db.js';

const preparationBytes = 24 * 1024 * 1024;
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function finite<T>(work: Promise<T>, label: string, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function observed(predicate: () => boolean | Promise<boolean>, label: string, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
interface Capture {
  close: ReturnType<typeof signal>; finish: ReturnType<typeof signal>; settled: ReturnType<typeof signal>;
  closes: number; finishes: number; workSettled: boolean; error: unknown; raw?: ServerResponse;
  serializations: number; serializationsAfterTerminal: number; sends: number; sendsAfterTerminal: number;
  writeHeads: number; writeHeadsAfterTerminal: number; writes: number; writesAfterTerminal: number; ends: number; endsAfterTerminal: number;
}
function capture(): Capture { return { close: signal(), finish: signal(), settled: signal(), closes: 0, finishes: 0, workSettled: false, error: null, serializations: 0, serializationsAfterTerminal: 0, sends: 0, sendsAfterTerminal: 0, writeHeads: 0, writeHeadsAfterTerminal: 0, writes: 0, writesAfterTerminal: 0, ends: 0, endsAfterTerminal: 0 }; }

/** Public PG query interposition ONLY: the real COMMIT completes before its response
 * is withheld/lost. No policy, native use case, SQL work or HTTP response is faked. */
async function fixture(developmentEditing = true) {
  const database = createDatabase(connectionString);
  let remaining = 0, lost = false;
  let reached = signal(), release = signal();
  const failure = new Error('fixture: response lost AFTER actual PostgreSQL COMMIT');
  database.pool.on('connect', client => {
    const query = client.query;
    client.query = function (...args: unknown[]) {
      const statement = args[0];
      const text = typeof statement === 'string' ? statement : statement && typeof statement === 'object' && 'text' in statement ? statement.text : null;
      if (remaining && typeof text === 'string' && /^\s*commit\s*$/i.test(text)) {
        if (--remaining === 0) {
          return Promise.resolve(Reflect.apply(query, client, args)).then(async result => {
            reached.resolve(); await release.promise;
            if (lost) throw failure;
            return result;
          });
        }
      }
      return Reflect.apply(query, client, args);
    } as typeof client.query;
  });
  let handoffKind: 'map' | 'wiki' | null = null, handoffReached = signal(), handoffRelease = signal();
  const beforeHandoff = async (kind: 'map' | 'wiki') => {
    if(handoffKind !== kind)return;handoffKind = null;handoffReached.resolve();await handoffRelease.promise;
  };
  const app = Fastify(); const captures = new Map<string, Capture>();
  app.addHook('onRequest', async (incoming, reply) => {
    const id = incoming.headers['x-lifetime-fixture']; const current = typeof id === 'string' ? captures.get(id) : undefined;
    if (!current) return;
    current.raw = reply.raw;
    // Observe public write methods without replacing their result or transport.
    // No response body is retained by these primitive, bounded counters.
    const writeHead=reply.raw.writeHead, write=reply.raw.write, end=reply.raw.end;
    reply.raw.writeHead=function(this: ServerResponse,...args: unknown[]) {current.writeHeads++;if(current.closes||current.finishes)current.writeHeadsAfterTerminal++;return Reflect.apply(writeHead,this,args);} as typeof writeHead;
    reply.raw.write=function(this: ServerResponse,...args: unknown[]) {current.writes++;if(current.closes||current.finishes)current.writesAfterTerminal++;return Reflect.apply(write,this,args);} as typeof write;
    reply.raw.end=function(this: ServerResponse,...args: unknown[]) {current.ends++;if(current.closes||current.finishes)current.endsAfterTerminal++;return Reflect.apply(end,this,args);} as typeof end;
    reply.raw.on('close', () => { current.closes++; current.close.resolve(); });
    reply.raw.on('finish', () => { current.finishes++; current.finish.resolve(); });
  });
  app.addHook('preSerialization', async (incoming, _reply, payload) => {
    const id=incoming.headers['x-lifetime-fixture'];const current=typeof id==='string'?captures.get(id):undefined;
    if(current){current.serializations++;if(current.closes||current.finishes)current.serializationsAfterTerminal++;}
    return payload;
  });
  app.addHook('onSend', async (incoming, _reply, payload) => {
    const id=incoming.headers['x-lifetime-fixture'];const current=typeof id==='string'?captures.get(id):undefined;
    if(current){current.sends++;if(current.closes||current.finishes)current.sendsAfterTerminal++;}
    return payload;
  });
  app.addHook('onRoute', options => {
    const original = options.handler;
    options.handler = async function (incoming, reply) {
      const id = incoming.headers['x-lifetime-fixture']; const current = typeof id === 'string' ? captures.get(id) : undefined;
      try { return await original.call(this, incoming, reply); }
      catch (error) { if (current) current.error = error; throw error; }
      finally { if (current) { current.workSettled = true; current.settled.resolve(); } }
    };
  });
  const origin = 'http://127.0.0.1';
  // In-process instances share the API container's secret: the database's JWKS private key is
  // encrypted with it, so a fresh random secret cannot sign up (compose.test.yaml).
  const config = loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: origin, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? randomBytes(32).toString('hex'), FLUX_AUTH_RATE_LIMIT: 'false' });
  const identity = registerIdentity(app, { db: database.db, config, mailer: null });
  const backend = mapBackend(database, { beforeHandoff: () => beforeHandoff('map') }); const maps = mapAuthority(backend, apiEditingOutputBudget);
  const wiki = wikiAuthority(database, undefined, { beforeHandoff: () => beforeHandoff('wiki'), outputBudget: apiEditingOutputBudget });
  await app.register(sketchRoutes, { db: database.db, sessions: identity, developmentEditing, liveBackend: () => backend });
  await app.register(docRoutes, { db: database.db, sessions: identity });
  await app.register(editingRoutes, { sessions: identity, authority: wiki, maps, outputBudget: apiEditingOutputBudget });
  const base = await app.listen({ host: '127.0.0.1', port: 0 }); const browser = new Browser(base, origin);
  // A failed setup releases what it opened, so the file's process can still exit and report.
  try {
    expectStatus(await browser.request('POST', '/api/auth/sign-up/email', { body: { name: 'Actual HTTP lifetime', email: `http-lifetime-${randomUUID()}@example.test`, password: 'actual public lifetime fixture password' } }), 200);
    const me = expectStatus(await browser.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
    // Setup uses the actual authorized core/domain transaction; the tested map creation,
    // subsequent commands and all sessions/origin checks use real public HTTP routes.
    const principal = { kind: 'human' as const, id: me.user.id };
    const workspace = await createWorkspace(principal, { name: 'HTTP lifetime workspace' }, database.db);
    const project = await createProject(principal, workspace.id, { name: 'Current lifetime policy', visibility: 'restricted' }, database.db);
    const sketch = expectStatus(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/sketches`, { body: { title: 'Actual retained source', scope: 'project', projectId: project.id } }), 201) as Sketch;
    const thought = (expectStatus(await browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { text: 'Original thought', x: 0, y: 0 } }), 201) as { thought: Thought }).thought;
    const head = expectStatus(await browser.request('GET', `/api/v1/sketches/${sketch.id}/live`), 200) as LiveMapBootstrap;
    const doc = expectStatus(await browser.request('POST', `/api/v1/projects/${project.id}/docs`, { body: { title: 'Protected wiki response', body: 'Actual saved original' } }), 201) as Doc;
    await observed(() => apiEditingOutputBudget.bytes === 0 && backend.sqlActive === 0 && wiki.sqlActive === 0, 'Setup response and actual SQL continuations must settle');
    return {
      database, app, backend, maps, wiki, browser, base, origin, sketch, thought, head, doc, actorId: me.user.id,
      watch(id = randomUUID()) { assert.ok(captures.size < 16); const value = capture(); captures.set(id, value); return { id, value }; },
      arm(commits: number, lose = false) { assert.equal(remaining, 0); remaining = commits; lost = lose; reached = signal(); release = signal(); return { reached: reached.promise, release: release.resolve, failure }; },
      pauseHandoff(kind: 'map' | 'wiki') { handoffKind = kind;handoffReached = signal();handoffRelease = signal();return { reached: handoffReached.promise,release: handoffRelease.resolve }; },
      async close() { release.resolve();handoffRelease.resolve(); await wiki.close(); await maps.close(); await app.close(); await database.pool.end(); },
    };
  } catch (error) {
    await wiki.close(); await maps.close(); await app.close(); await database.pool.end();
    throw error;
  }
}
function client(f: Awaited<ReturnType<typeof fixture>>, method: string, path: string, marker: string, body?: unknown, extra: Record<string, string> = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const req = request(new URL(path, f.base), { method, agent: false, headers: { cookie: f.browser.cookieHeader(), origin: f.origin, 'x-lifetime-fixture': marker,
    ...extra, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) } });
  const complete = new Promise<{ status: number; text: string; replayed: string | string[] | undefined }>((resolve, reject) => {
    req.once('error', reject);
    req.once('response', response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { req.destroy(new Error('Finite HTTP fixture output exceeded')); return; } chunks.push(chunk); });
      response.once('error', reject); response.once('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), replayed: response.headers['idempotent-replayed'] }));
    });
  });
  // Every rejection is observed immediately, including a deliberate real client abort.
  void complete.catch(() => {}); req.end(text);
  return { req, complete };
}
async function nativeState(f: Awaited<ReturnType<typeof fixture>>, uuid: string) {
  const thought = (await pool.query('SELECT text,version FROM sketch_thoughts WHERE id=$1', [f.thought.id])).rows[0];
  const receipts = (await pool.query('SELECT receipt FROM live_editing_intents WHERE actor_id=$1 AND command_id=$2', [f.actorId, uuid])).rows;
  const journal = (await pool.query('SELECT command_id,sequence FROM map_live_journal WHERE sketch_id=$1 AND command_id=$2', [f.sketch.id, uuid])).rows;
  return { thought, receipts, journal };
}

test('actual native HTTP abort before a PG-blocked command retains source through outer COMMIT then releases without another close', { timeout: 15_000 }, async () => {
  const f = await fixture(); const blocker = await pool.connect(); let locked = true;
  const watch = f.watch(); const uuid = randomUUID(); const parameters = { text: 'Persisted after actual disconnect', expectedVersion: f.thought.version };
  const boundary = f.arm(1); let pending: ReturnType<typeof client> | undefined;
  try {
    await blocker.query('BEGIN'); const pid = Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await blocker.query('SELECT sketch_id FROM map_live_heads WHERE sketch_id=$1 FOR UPDATE', [f.sketch.id]);
    pending = client(f, 'PATCH', `/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`, watch.id, parameters, { 'idempotency-key': uuid, 'if-match': `"${f.thought.version}"` });
    await observed(async () => (await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))) held', [pid])).rows[0].held, 'The actual API native backend must be blocked by the real control PID');
    assert.ok(apiEditingOutputBudget.bytes > preparationBytes); assert.equal(watch.value.workSettled, false);
    pending.req.destroy(); await finite(watch.value.close.promise, 'Actual server raw response did not close');
    assert.equal(watch.value.closes, 1); assert.equal(watch.value.finishes, 0);
    assert.ok(apiEditingOutputBudget.bytes > preparationBytes, 'Actual close cannot release SQL/native context still retained');
    await blocker.query('COMMIT'); locked = false;
    await finite(boundary.reached, 'Real outer native COMMIT response did not reach its withheld boundary');
    assert.equal(watch.value.workSettled, false); assert.ok(apiEditingOutputBudget.bytes > preparationBytes);
    const committed = await nativeState(f, uuid); assert.equal(committed.thought.text, parameters.text); assert.equal(committed.thought.version, f.thought.version + 1);
    assert.equal(committed.receipts.length, 1); assert.equal(committed.journal.length, 1);
    boundary.release(); await finite(watch.value.settled.promise, 'Actual native handler continuation did not settle');
    await observed(() => apiEditingOutputBudget.bytes === 0, 'Both actual work/terminal owners must release without another event');
    assert.equal(watch.value.closes, 1); assert.equal(watch.value.finishes, 0); assert.equal(f.backend.sqlActive, 0);
    const replay = await f.browser.request('PATCH', `/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`, { body: parameters, headers: { 'idempotency-key': uuid, 'if-match': `"${f.thought.version}"` } });
    expectStatus(replay, 200); assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(await nativeState(f, uuid), committed, 'Exact HTTP retry never creates a second version/receipt/journal');
    await observed(() => apiEditingOutputBudget.bytes === 0 && f.backend.sqlActive === 0, 'Healthy replay must settle normally');
  } finally { boundary.release(); if (locked) await blocker.query('ROLLBACK'); blocker.release(); pending?.req.destroy(); await pending?.complete.catch(() => {}); await f.close(); }
});

test('actual native response finish keeps source until the real protected COMMIT response and handler settle', { timeout: 15_000 }, async () => {
  const f = await fixture(); const watch = f.watch(); const uuid = randomUUID(); const boundary = f.arm(2);
  const pending = client(f, 'PATCH', `/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`, watch.id, { text: 'Normal finish before protected settlement', expectedVersion: f.thought.version }, { 'idempotency-key': uuid });
  try {
    await finite(boundary.reached, 'Second actual COMMIT must be the protected delivery transaction');
    const response = await finite(pending.complete, 'Actual native HTTP reply did not finish'); assert.equal(response.status, 200);
    await finite(watch.value.finish.promise, 'Actual server finish not observed');
    assert.equal(watch.value.workSettled, false); assert.equal(f.backend.sqlActive, 1);
    assert.ok(apiEditingOutputBudget.bytes > preparationBytes, 'Transport finish cannot free SQL-held response/native metadata');
    boundary.release(); await finite(watch.value.settled.promise, 'Actual protected route did not settle');
    assert.equal(apiEditingOutputBudget.bytes, 0); assert.equal(f.backend.sqlActive, 0);
    const state = await nativeState(f, uuid); assert.equal(state.thought.version, f.thought.version + 1); assert.equal(state.receipts.length, 1); assert.equal(state.journal.length, 1);
    assert.equal((JSON.parse(response.text) as Thought).text, state.thought.text);
  } finally { boundary.release(); pending.req.destroy(); await pending.complete.catch(() => {}); await f.close(); }
});

test('actual closed native CAS refusal rolls back without a new contribution; parser400 never allocates protected preparation', { timeout: 15_000 }, async () => {
  const f = await fixture(); const watch = f.watch(); const uuid = randomUUID(); const blocker = await pool.connect(); let locked = true;
  let pending: ReturnType<typeof client> | undefined;
  try {
    await blocker.query('BEGIN'); const pid = Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await blocker.query('SELECT id FROM sketch_thoughts WHERE id=$1 FOR UPDATE', [f.thought.id]);
    pending = client(f, 'PATCH', `/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`, watch.id, { text: 'Stale private input', expectedVersion: f.thought.version }, { 'idempotency-key': uuid });
    await observed(async () => (await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))) held', [pid])).rows[0].held, 'The native caller must really wait for the locked target');
    pending.req.destroy(); await finite(watch.value.close.promise, 'Closed refusal response not observed'); assert.ok(apiEditingOutputBudget.bytes >= preparationBytes);
    await blocker.query('UPDATE sketch_thoughts SET version=version+1 WHERE id=$1', [f.thought.id]); await blocker.query('COMMIT'); locked = false;
    await finite(watch.value.settled.promise, 'Definite stale-CAS rollback route must settle');
    assert.equal(apiEditingOutputBudget.bytes, 0); assert.equal(watch.value.closes, 1);
    const state = await nativeState(f, uuid); assert.equal(state.thought.text, f.thought.text); assert.equal(state.thought.version, f.thought.version + 1);
    assert.equal(state.receipts.length, 0); assert.equal(state.journal.length, 0); assert.ok(watch.value.error instanceof Error);
    const invalid = await f.browser.request('DELETE', `/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`, { headers: { 'content-type': 'application/json', 'content-length': '0' } });
    expectStatus(invalid, 400); assert.equal((invalid.json as { code: string }).code, 'FST_ERR_CTP_EMPTY_JSON_BODY'); assert.equal(apiEditingOutputBudget.bytes, 0);
    expectStatus(await f.browser.request('DELETE', `/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`, { headers: { 'if-match': `"${f.thought.version + 1}"` } }), 204);
    await observed(() => apiEditingOutputBudget.bytes === 0 && f.backend.sqlActive === 0, 'Bodyless204 actual work and transport must settle');
  } finally { if (locked) await blocker.query('ROLLBACK'); blocker.release(); pending?.req.destroy(); await pending?.complete.catch(() => {}); await f.close(); }
});

for (const kind of ['map', 'wiki'] as const) {
  test(`actual ${kind} HTTP finish keeps source/wire charged through protected SQL settlement`, { timeout: 15_000 }, async () => {
    const f = await fixture(); const watch = f.watch(); const boundary = f.arm(kind === 'wiki' ? 2 : 1);
    const path = kind === 'wiki' ? `/api/v1/docs/${f.doc.id}/live` : `/api/v1/sketches/${f.sketch.id}/live`;
    const pending = client(f, 'GET', path, watch.id);
    try {
      await finite(boundary.reached, 'Actual protected response COMMIT must reach the finite boundary');
      const response = await finite(pending.complete, 'Actual protected HTTP response must finish'); assert.equal(response.status, 200);
      await finite(watch.value.finish.promise, 'Actual protected finish must be observed'); assert.equal(watch.value.workSettled, false);
      assert.ok(apiEditingOutputBudget.bytes > 0, 'Response/source ownership cannot disappear before the actual SQL return');
      if (kind === 'wiki') { assert.equal(f.wiki.sqlActive, 1); assert.equal((JSON.parse(response.text) as { body: string }).body, f.doc.body); }
      else { assert.equal(f.backend.sqlActive, 1); assert.equal((JSON.parse(response.text) as LiveMapBootstrap).resourceId, f.sketch.id); }
      boundary.release(); await finite(watch.value.settled.promise, 'Actual protected handler continuation must settle');
      assert.equal(apiEditingOutputBudget.bytes, 0); assert.equal(f.wiki.sqlActive, 0); assert.equal(f.backend.sqlActive, 0);
    } finally { boundary.release(); pending.req.destroy(); await pending.complete.catch(() => {}); await f.close(); }
  });
}

for (const kind of ['map', 'wiki'] as const) {
  test(`actual ${kind} client close before its held protected SQL handoff releases after real route settlement`, { timeout: 15_000 }, async () => {
    const f = await fixture(); const watch = f.watch(); const boundary = f.pauseHandoff(kind);
    const path = kind === 'wiki' ? `/api/v1/docs/${f.doc.id}/live` : `/api/v1/sketches/${f.sketch.id}/live`;
    const pending = client(f, 'GET', path, watch.id);
    try {
      // Explicit beforeHandoff boundary interposition: actual production SQL has read
      // and locked current authority; the synchronous handoff has not happened yet.
      await finite(boundary.reached, 'Actual protected SQL action must reach its held pre-handoff boundary');
      assert.equal(watch.value.workSettled, false);assert.ok(apiEditingOutputBudget.bytes > 0);
      const retained = apiEditingOutputBudget.bytes;
      pending.req.destroy();await finite(watch.value.close.promise, 'Actual client close must precede handoff');
      assert.equal(watch.value.finishes, 0);assert.equal(watch.value.closes, 1);
      assert.equal(apiEditingOutputBudget.bytes, retained, 'Early actual close must retain all SQL-held source/context');
      boundary.release();await finite(watch.value.settled.promise, 'Actual protected route must settle without another response event');
      assert.equal(apiEditingOutputBudget.bytes, 0);assert.equal(watch.value.closes, 1);assert.equal(watch.value.finishes, 0);
      assert.equal(f.backend.sqlActive, 0);assert.equal(f.wiki.sqlActive, 0);
      const healthy = expectStatus(await f.browser.request('GET', path), 200) as { body?: string; resourceId: string };
      assert.equal(healthy.resourceId, kind === 'wiki' ? f.doc.id : f.sketch.id);if(kind === 'wiki')assert.equal(healthy.body, f.doc.body);
      await observed(() => apiEditingOutputBudget.bytes === 0 && f.backend.sqlActive === 0 && f.wiki.sqlActive === 0, 'A fresh current-rights response must still settle');
    } finally { boundary.release();pending.req.destroy();await pending.complete.catch(() => {});await f.close(); }
  });
}

test('actual protected COMMIT-response loss preserves unknown classification and retires only after HTTP plus SQL settlement', { timeout: 15_000 }, async () => {
  const f = await fixture(); const watch = f.watch(); const boundary = f.arm(2, true);
  const pending = client(f, 'GET', `/api/v1/docs/${f.doc.id}/live`, watch.id);
  try {
    await finite(boundary.reached, 'Actual read COMMIT must execute before losing its response');
    const response = await finite(pending.complete, 'Already authorized current read was handed before the lost response'); assert.equal(response.status, 200);
    assert.equal((JSON.parse(response.text) as { body: string }).body, f.doc.body);
    assert.equal(watch.value.workSettled, false); assert.ok(apiEditingOutputBudget.bytes >= preparationBytes);
    boundary.release(); await finite(watch.value.settled.promise, 'Unknown actual transaction route must settle');
    assert.ok(watch.value.error instanceof EditingTransactionError); assert.equal(watch.value.error.outcome, 'unknown'); assert.equal(watch.value.error.cause, boundary.failure);
    assert.equal(apiEditingOutputBudget.bytes, 0); assert.equal(f.wiki.sqlActive, 0);
    assert.equal((expectStatus(await f.browser.request('GET', `/api/v1/docs/${f.doc.id}`), 200) as Doc).body, f.doc.body);
  } finally { boundary.release(); pending.req.destroy(); await pending.complete.catch(() => {}); await f.close(); }
});

test('pinned actual ServerResponse close before owner construction is terminal evidence; late retainer joins need no new event', { timeout: 5000 }, async () => {
  const budget = new EditingOutputBudget(); const closed = signal(); let raw: ServerResponse | undefined; let closes = 0;
  const server = createServer((_request, response) => { raw = response; response.once('close', () => { closes++; closed.resolve(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const req = request({ host: '127.0.0.1', port: address.port, agent: false }); req.on('error', () => {}); req.end();
  try {
    await observed(() => !!raw, 'Real server response must be created'); req.destroy(); await finite(closed.promise, 'Real server response must close');
    assert.ok(raw); assert.equal('closed' in raw && raw.closed, true, 'Pinned public HTTP getter must match the actual already emitted close');
    const lifetime = editingHTTPLifetime(raw, budget); const release = budget.reserve(8192); lifetime.retain(release);
    assert.equal(lifetime.canSend, false); assert.ok(budget.bytes >= 8192); lifetime.settled(); lifetime.settled(); assert.equal(budget.bytes, 0); assert.equal(closes, 1);
  } finally { req.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


function noTerminalSerialization(current: Capture) {
  assert.equal(current.serializationsAfterTerminal,0,'A known terminal response cannot enter protected preSerialization');
  assert.equal(current.sendsAfterTerminal,0,'A known terminal response cannot reach the serialized onSend boundary');
  assert.equal(current.writeHeadsAfterTerminal,0,'A known terminal response cannot attempt writeHead');
  assert.equal(current.writesAfterTerminal,0,'A known terminal response cannot attempt a payload write');
  assert.equal(current.endsAfterTerminal,0,'A known terminal response cannot attempt end with a protected payload');
}

test('actual ordinary native abort before PG settlement skips protected success serialization and preserves exact durable replay', { timeout: 15_000 }, async () => {
  const f=await fixture(false);const blocker=await pool.connect();let locked=true;
  const watch=f.watch();const uuid=randomUUID();const parameters={text:'Ordinary persisted input after disconnect',expectedVersion:f.thought.version};
  const boundary=f.arm(1);let pending:ReturnType<typeof client>|undefined;
  try {
    await blocker.query('BEGIN');const pid=Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await blocker.query('SELECT sketch_id FROM map_live_heads WHERE sketch_id=$1 FOR UPDATE',[f.sketch.id]);
    pending=client(f,'PATCH',`/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`,watch.id,parameters,{'idempotency-key':uuid});
    await observed(async()=>(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))) held',[pid])).rows[0].held,'The ordinary public caller must wait for the actual PG control PID');
    assert.ok(apiEditingOutputBudget.bytes>preparationBytes);assert.equal(watch.value.workSettled,false);
    pending.req.destroy();await finite(watch.value.close.promise,'The actual ordinary response must close before SQL resumes');
    assert.equal(watch.value.closes,1);assert.equal(watch.value.finishes,0);assert.ok(apiEditingOutputBudget.bytes>preparationBytes);
    await blocker.query('COMMIT');locked=false;await finite(boundary.reached,'The actual ordinary outer COMMIT must succeed before its response is withheld');
    assert.equal(watch.value.workSettled,false);assert.ok(apiEditingOutputBudget.bytes>preparationBytes);
    const committed=await nativeState(f,uuid);assert.equal(committed.thought.text,parameters.text);assert.equal(committed.thought.version,f.thought.version+1);
    assert.equal(committed.receipts.length,1);assert.equal(committed.journal.length,1);
    boundary.release();await finite(watch.value.settled.promise,'The actual ordinary command promise must settle');
    await observed(()=>apiEditingOutputBudget.bytes===0,'Ordinary metadata/source must retire after actual SQL and earlier close');
    assert.equal(watch.value.serializations,0);assert.equal(watch.value.sends,0);noTerminalSerialization(watch.value);
    assert.equal(watch.value.closes,1);assert.equal(watch.value.finishes,0);assert.equal(watch.value.error,null);
    const healthy=f.watch();const replay=client(f,'PATCH',`/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`,healthy.id,parameters,{'idempotency-key':uuid});
    try {
      const response=await finite(replay.complete,'Exact ordinary retry must reply to the connected authorized client');assert.equal(response.status,200);assert.equal(response.replayed,'true');
      assert.equal((JSON.parse(response.text) as Thought).text,parameters.text);
      await finite(healthy.value.settled.promise,'Healthy ordinary replay route must settle');await finite(healthy.value.finish.promise,'Healthy ordinary replay must really finish');
      assert.equal(healthy.value.serializations,1);assert.equal(healthy.value.sends,1);assert.ok(healthy.value.writeHeads>0);assert.ok(healthy.value.ends>0);noTerminalSerialization(healthy.value);
      assert.deepEqual(await nativeState(f,uuid),committed,'Ordinary exact replay cannot add a version/receipt/journal');
      await observed(()=>apiEditingOutputBudget.bytes===0&&f.backend.sqlActive===0,'Ordinary replay ownership must settle');
    } finally {replay.req.destroy();await replay.complete.catch(()=>{});}
  } finally {boundary.release();if(locked)await blocker.query('ROLLBACK');blocker.release();pending?.req.destroy();await pending?.complete.catch(()=>{});await f.close();}
});

test('actual ordinary native closed CAS postimage skips error serialization while connected refusals preserve current authorized details', { timeout: 15_000 }, async () => {
  const f=await fixture(false);const blocker=await pool.connect();let locked=true;const watch=f.watch();const uuid=randomUUID();
  const parameters={text:'Rejected ordinary stale private input',expectedVersion:f.thought.version};let pending:ReturnType<typeof client>|undefined;
  try {
    await blocker.query('BEGIN');const pid=Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await blocker.query('SELECT id FROM sketch_thoughts WHERE id=$1 FOR UPDATE',[f.thought.id]);
    pending=client(f,'PATCH',`/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`,watch.id,parameters,{'idempotency-key':uuid});
    await observed(async()=>(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))) held',[pid])).rows[0].held,'The ordinary stale caller must really wait for its native target');
    assert.equal(watch.value.workSettled,false);assert.ok(apiEditingOutputBudget.bytes>preparationBytes);
    pending.req.destroy();await finite(watch.value.close.promise,'Ordinary refusal response must really close before its CAS decision');
    assert.equal(watch.value.closes,1);assert.equal(watch.value.finishes,0);assert.ok(apiEditingOutputBudget.bytes>preparationBytes);
    await blocker.query('UPDATE sketch_thoughts SET version=version+1 WHERE id=$1',[f.thought.id]);await blocker.query('COMMIT');locked=false;
    await finite(watch.value.settled.promise,'Ordinary definite CAS rollback must settle');
    await observed(()=>apiEditingOutputBudget.bytes===0,'Closed ordinary refusal must release only after real native SQL settles');
    assert.ok(watch.value.error instanceof VersionConflictError);assert.equal(watch.value.error.code,'VERSION_CONFLICT');
    assert.equal(watch.value.error.details?.currentVersion,f.thought.version+1);
    assert.equal((watch.value.error.details?.current as Thought).id,f.thought.id);assert.equal((watch.value.error.details?.current as Thought).text,f.thought.text);
    assert.equal(watch.value.serializations,0);assert.equal(watch.value.sends,0);noTerminalSerialization(watch.value);
    const unchanged=await nativeState(f,uuid);assert.equal(unchanged.thought.text,f.thought.text);assert.equal(unchanged.thought.version,f.thought.version+1);
    assert.equal(unchanged.receipts.length,0);assert.equal(unchanged.journal.length,0);
    const healthy=f.watch();const refusal=client(f,'PATCH',`/api/v1/sketches/${f.sketch.id}/thoughts/${f.thought.id}`,healthy.id,parameters,{'idempotency-key':uuid});
    try {
      const response=await finite(refusal.complete,'The connected current-rights CAS refusal must reply');assert.equal(response.status,409);
      const body=JSON.parse(response.text) as {code:string;currentVersion:number;current:Thought};assert.equal(body.code,'VERSION_CONFLICT');
      assert.equal(body.currentVersion,f.thought.version+1);assert.equal(body.current.id,f.thought.id);assert.equal(body.current.text,f.thought.text);assert.equal(body.current.version,f.thought.version+1);
      await finite(healthy.value.settled.promise,'Healthy ordinary refusal route must settle');await finite(healthy.value.finish.promise,'Healthy ordinary refusal must finish');
      assert.ok(healthy.value.error instanceof VersionConflictError);assert.equal(healthy.value.serializations,1);assert.equal(healthy.value.sends,1);
      assert.ok(healthy.value.writeHeads>0);assert.ok(healthy.value.ends>0);noTerminalSerialization(healthy.value);
      assert.deepEqual(await nativeState(f,uuid),unchanged,'Neither aborted nor connected stale retry can create a contribution');
      await observed(()=>apiEditingOutputBudget.bytes===0&&f.backend.sqlActive===0,'Connected ordinary refusal source must settle');
    } finally {refusal.req.destroy();await refusal.complete.catch(()=>{});}
  } finally {if(locked)await blocker.query('ROLLBACK');blocker.release();pending?.req.destroy();await pending?.complete.catch(()=>{});await f.close();}
});
