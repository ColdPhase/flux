import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as Y from 'yjs';
import type { Doc, WikiTextEnvelope } from '@flux/contracts';
import Fastify from 'fastify';
import { editingRoutes } from '../../apps/server/src/editing/routes.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { UnauthenticatedError } from '../../apps/server/src/identity/session.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { editingRuntime, NATIVE_CHECKPOINT_BYTES } from '../../apps/server/src/editing/runtime.js';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import { liveEditingRows } from '@flux/db';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

async function context(user: Awaited<ReturnType<typeof person>>): Promise<SessionContext> {
  const [session] = (await pool.query('SELECT id,expires_at FROM auth_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [user.id])).rows;
  const [row] = (await pool.query('SELECT name,email FROM auth_users WHERE id=$1', [user.id])).rows;
  return { sessionId: session.id, expiresAt: session.expires_at, principal: { kind: 'human', id: user.id }, user: { id: user.id, ...row } };
}
async function scene() {
  const owner = await person('live-authority-owner'); const peer = await person('live-authority-peer');
  const ws = await workspace(owner, 'Live authority'); await addMember(owner, ws.id, peer, 'member');
  const place = await project(owner, ws.id, 'Current shared text', 'restricted'); await grant(owner, place.id, peer, 'contributor');
  const create = async (title: string) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title, body: 'Saved. ' } }), 201) as Doc;
  return { owner, peer, ws, place, doc: await create('First room'), other: await create('Second room'), create };
}
const refused = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
function update(head: Awaited<ReturnType<ReturnType<typeof wikiAuthority>['bootstrap']>>, doc: Y.Doc, actorId: string, uuid = randomUUID()) {
  return { envelope: { workspace: head.workspaceId, kind: 'wiki' as const, room: head.resourceId, generation: head.generation,
    actor: actorId, operation: 'text' as const, uuid, replica: doc.clientID, parameters: null }, bytes: Y.encodeStateAsUpdate(doc) };
}

test('actual SQL wiki ownership/concurrent text/immutable global intents/no-op provenance/snapshot/current rights', { timeout: 15_000 }, async () => {
  const f = await scene(); const authority = wikiAuthority({ pool }); const first = new Y.Doc(); const second = new Y.Doc();
  try {
    const owner = await context(f.owner); const peer = await context(f.peer);
    const head = await authority.bootstrap(owner, f.doc.id);
    assert.equal(head.body, f.doc.body); assert.equal(head.sequence, 0);
    const enrolled = await authority.enroll(owner, f.doc.id, { generation: head.generation, replicaId: first.clientID });
    await authority.enroll(peer, f.doc.id, { generation: head.generation, replicaId: second.clientID });
    await assert.rejects(authority.enroll(peer, f.doc.id, { generation: head.generation, replicaId: first.clientID }), refused('EDITING_REPLICA_COLLISION'));
    const renewal = await authority.enroll(owner, f.doc.id, { generation: head.generation, replicaId: first.clientID, instanceId: enrolled.instanceId });
    assert.equal(renewal.instanceId, enrolled.instanceId);
    Y.applyUpdate(first, Buffer.from(head.checkpoint, 'base64')); Y.applyUpdate(second, Buffer.from(head.checkpoint, 'base64'));
    first.getText('body').insert(head.body.length, 'Ada. '); second.getText('body').insert(head.body.length, 'Jon. ');
    const a = update(head, first, owner.principal.id); const b = update(head, second, peer.principal.id);
    const send = (who: SessionContext, command: { envelope: WikiTextEnvelope; bytes: Uint8Array }) => authority.submit(who, f.doc.id, command.envelope, command.bytes, authority.reserve(command.bytes));
    const ackA = await send(owner, a); const ackB = await send(peer, b);
    assert.equal(ackA.sequence, 1); assert.equal(ackB.sequence, 2);
    assert.deepEqual(await send(owner, a), ackA, 'original exact receipt is immutable after the peer update');
    const latest = await authority.bootstrap(owner, f.doc.id);
    assert.ok(latest.body.includes('Ada.') && latest.body.includes('Jon.')); assert.equal(latest.sequence, 2);
    const known = { ...a, envelope: { ...a.envelope, uuid: randomUUID() } };
    const noOp = await send(owner, known); assert.equal(noOp.changed, false); assert.equal(noOp.sequence, 2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM doc_live_updates WHERE doc_id=$1', [f.doc.id])).rows[0].n, 2);
    const otherHead = await authority.bootstrap(owner, f.other.id); const otherDoc = new Y.Doc();
    try {
      await authority.enroll(owner, f.other.id, { generation: otherHead.generation, replicaId: otherDoc.clientID });
      Y.applyUpdate(otherDoc, Buffer.from(otherHead.checkpoint, 'base64')); otherDoc.getText('body').insert(0, 'Another valid room. ');
      const foreign = update(otherHead, otherDoc, owner.principal.id, a.envelope.uuid);
      await assert.rejects(authority.submit(owner, f.other.id, foreign.envelope, foreign.bytes, authority.reserve(foreign.bytes)), refused('EDITING_IDEMPOTENCY_CONFLICT'));
      assert.equal((await authority.bootstrap(owner, f.other.id)).sequence, 0);
    } finally { otherDoc.destroy(); }
    const beforeNative = expectStatus(await f.owner.browser.request('GET', `/api/v1/docs/${f.doc.id}`), 200) as Doc;
    assert.equal(beforeNative.body, head.body, 'ordinary saved projections remain immutable until Save');
    const save = { clientCommandId: randomUUID(), expectedVersion: 1, generation: latest.generation, headSequence: latest.sequence, headHash: latest.hash, reason: 'Together' };
    const saved = await authority.save(owner, f.doc.id, save); assert.equal(saved.savedDoc?.body, latest.body); assert.equal(saved.savedDoc?.version, 2);
    assert.deepEqual(new Set(saved.savedDoc?.contributors?.map((actor) => actor.id)), new Set([owner.principal.id, peer.principal.id]));
    assert.deepEqual(await authority.save(owner, f.doc.id, save), saved);
    await assert.rejects(authority.save(owner, f.doc.id, { ...save, reason: 'Changed under original UUID' }), refused('EDITING_IDEMPOTENCY_CONFLICT'));
    await pool.query('DELETE FROM auth_sessions WHERE id=$1', [owner.sessionId]);
    await assert.rejects(authority.receipt(owner, f.doc.id, a.envelope.uuid), refused('UNAUTHENTICATED'));
  } finally { first.destroy(); second.destroy(); await authority.close(); }
});

test('actual authority rejects large backing before any SQL wait and releases failed native bootstrap admission', async () => {
  let connects = 0;
  const actual = { pool: { async connect() { connects++; throw new Error('controlled SQL boundary'); } } };
  const authority = wikiAuthority(actual);
  try {
    assert.throws(() => authority.reserve(new Uint8Array(new ArrayBuffer(64 * 1024 * 1024), 0, 16)), refused('EXTERNAL_BUFFER_LIMIT'));
    assert.equal(connects, 0);
    const who: SessionContext = { sessionId: 'never-resolved', expiresAt: new Date(), principal: { kind: 'human', id: 'nobody' }, user: { id: 'nobody', name: 'Nobody', email: 'nobody@example.test' } };
    await assert.rejects(authority.bootstrap(who, randomUUID()), /controlled SQL boundary/);
    assert.equal(connects, 1);
    const lease = authority.reserve(new Uint8Array(0)); authority.runtime.release(lease);
  } finally { await authority.close(); }
});


test('two simultaneous actual 100k bootstrap joins share one baseline and no healthy capacity refusal', { timeout: 15_000 }, async () => {
  const f = await scene();
  const body = '😀é'.repeat(25_000); assert.equal(body.length, 100_000);
  const updated = expectStatus(await f.owner.browser.request('PATCH', `/api/v1/docs/${f.doc.id}`, { body: { body }, headers: { 'if-match': '"1"' } }), 200) as Doc;
  const authority = wikiAuthority({ pool });
  try {
    const owner = await context(f.owner); const peer = await context(f.peer);
    const [a,b] = await Promise.all([authority.bootstrap(owner, f.doc.id), authority.bootstrap(peer, f.doc.id)]);
    assert.equal(a.body, updated.body); assert.equal(b.body, updated.body); assert.equal(a.generation, b.generation);
    assert.equal(a.checkpoint, b.checkpoint); assert.equal(a.sequence, 0); assert.equal(b.sequence, 0);
    assert.ok(Buffer.from(a.checkpoint, 'base64').byteLength <= NATIVE_CHECKPOINT_BYTES);
    assert.equal((await pool.query("SELECT count(*)::int n FROM doc_live_replicas WHERE doc_id=$1 AND owner_kind='server'", [f.doc.id])).rows[0].n, 1);
    const [againA,againB] = await Promise.all([authority.bootstrap(owner, f.doc.id), authority.bootstrap(peer, f.doc.id)]);
    assert.equal(againA.generation, a.generation); assert.equal(againB.hash, a.hash);
  } finally { await authority.close(); }
});

test('current SQL clock immediately before a withheld protected callback prevents expired-session bytes', { timeout: 5_000 }, async () => {
  const f = await scene(); const initialize = wikiAuthority({ pool });
  const owner = await context(f.owner); let delivered = 0;
  const started: { resolve?: () => void } = {}; let release!: () => void;
  const entered = new Promise<void>((resolve) => { started.resolve = resolve; }); const barrier = new Promise<void>((resolve) => { release = resolve; });
  try {
    const head = await initialize.bootstrap(owner, f.doc.id); await initialize.close();
    await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [owner.sessionId]);
    const fenced = wikiAuthority({ pool }, undefined, { beforeHandoff: async () => { started.resolve!(); await barrier; } });
    const waiting = fenced.deliver(owner, f.doc.id, head.generation, 0, () => { delivered++; });
    const refusedPromise = assert.rejects(waiting, refused('UNAUTHENTICATED'));
    try { await Promise.race([entered, new Promise<never>((_,reject) => setTimeout(() => reject(new Error('handoff did not enter within finite bound')),1500))]); await pool.query('SELECT pg_sleep(1.1)'); release(); await refusedPromise; assert.equal(delivered, 0); }
    finally { release(); await fenced.close(); }
  } finally { release?.(); await initialize.close(); }
});

test('server-named relative cursor presence uses current writing rights, exact public positions and no project events', { timeout: 15_000 }, async () => {
  const f = await scene(); const authority = wikiAuthority({ pool }); const document = new Y.Doc();
  try {
    const owner = await context(f.owner); const peer = await context(f.peer); const head = await authority.bootstrap(owner, f.doc.id);
    await authority.enroll(owner, f.doc.id, { generation: head.generation, replicaId: document.clientID });
    Y.applyUpdate(document, Buffer.from(head.checkpoint, 'base64')); const text = document.getText('body');
    const anchor = Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 0))).toString('base64');
    const end = Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, text.length))).toString('base64');
    assert.equal(Y.decodeRelativePosition(Buffer.from(anchor,'base64')).tname,null,'Public item-ID encoding omits the root name');
    assert.equal(Y.decodeRelativePosition(Buffer.from(end,'base64')).tname,'body','Public end-of-root encoding includes the root name');
    const connection = randomUUID(); const events = (await pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1', [f.ws.id])).rows[0].n;
    await authority.cursor(owner, f.doc.id, head.generation, connection, { anchor, head: end });
    let peers: { connectionId: string; actor: { id: string; name: string } }[] = [];
    await authority.deliver(peer, f.doc.id, head.generation, 0, (result) => { peers = result.presence; });
    assert.equal(peers[0]?.connectionId, connection); assert.equal(peers[0]?.actor.id, owner.principal.id); assert.ok(peers[0]?.actor.name);
    await assert.rejects(authority.cursor(owner, f.doc.id, head.generation, connection, { anchor: anchor + 'AAAA', head: end }), refused('INVALID_CURSOR'));
    const foreign=new Y.Doc();try {
      foreign.getText('body').insert(0,'Foreign unconfirmed text');
      const unknown=Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(foreign.getText('body'),0))).toString('base64');
      await assert.rejects(authority.cursor(owner,f.doc.id,head.generation,connection,{anchor:unknown,head:end}),refused('INVALID_CURSOR'));
      const extraRoot=Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(foreign.getText('another-root'),0))).toString('base64');
      await assert.rejects(authority.cursor(owner,f.doc.id,head.generation,connection,{anchor:extraRoot,head:end}),refused('INVALID_CURSOR'));
    }finally{foreign.destroy();}
    assert.equal((await pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1', [f.ws.id])).rows[0].n, events);
    await grant(f.owner, f.place.id, f.peer, 'viewer');
    await assert.rejects(authority.cursor(peer, f.doc.id, head.generation, randomUUID(), { anchor, head: end }), refused('FORBIDDEN'));
    await authority.cursor(owner, f.doc.id, head.generation, connection, null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM doc_live_presence WHERE connection_id=$1', [connection])).rows[0].n, 0);
  } finally { document.destroy(); await authority.close(); }
});

test('fresh public one-root update encoding stays within its pre-SQL initialization input bound at 100k UTF16', () => {
  for (const body of ['x'.repeat(100_000), '😀'.repeat(50_000), 'é'.repeat(50_000), '\ud800'.repeat(100_000), '漢'.repeat(100_000)]) {
    const doc = new Y.Doc(); try { doc.getText('body').insert(0,body); assert.ok(Y.encodeStateAsUpdate(doc).byteLength <= NATIVE_CHECKPOINT_BYTES); } finally { doc.destroy(); }
  }
});


test('real current routes queue two 100k joins and stale Save errors reveal no rolled-back current document', { timeout: 15_000 }, async () => {
  const f = await scene(); const marker = 'Protected stale material';
  const body = '😀'.repeat(50_000);
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/docs/${f.doc.id}`, { body: { body, title: marker }, headers: { 'if-match': '"1"' } }),200);
  const owner = await context(f.owner); const peer = await context(f.peer); const authority = wikiAuthority({ pool });
  const identities = new Map([[owner.principal.id,owner],[peer.principal.id,peer]]); const app = Fastify(); const outputBudget = new EditingOutputBudget();
  // Only this fixture resolver selects a pre-created identity. Production still uses current cookie auth;
  // real SQL session/resource fences run in the actual route authority below.
  await app.register(editingRoutes, { authority, outputBudget, sessions: {
    async resolveSession(headers) { return identities.get(String(headers['x-fixture-actor'])) ?? null; },
    async requirePrincipal(request) { const who = identities.get(String(request.headers['x-fixture-actor'])); if (!who) throw new UnauthenticatedError(); return who; },
  } });
  try {
    const [a,b] = await Promise.all([
      app.inject({ method: 'GET', url: `/api/v1/docs/${f.doc.id}/live`, headers: { 'x-fixture-actor': owner.principal.id } }),
      app.inject({ method: 'GET', url: `/api/v1/docs/${f.doc.id}/live`, headers: { 'x-fixture-actor': peer.principal.id } }),
    ]);
    assert.equal(a.statusCode,200,a.body); assert.equal(b.statusCode,200,b.body);
    const head = a.json(); assert.equal(head.body,body); assert.equal(b.json().body,body); assert.equal(head.generation,b.json().generation);
    const stale = await app.inject({ method: 'POST', url: `/api/v1/docs/${f.doc.id}/live/save`, headers: { 'x-fixture-actor': owner.principal.id, 'if-match': '"1"' },
      payload: { clientCommandId: randomUUID(), expectedVersion:1, generation:head.generation, headSequence:head.sequence, headHash:head.hash } });
    assert.equal(stale.statusCode,409,stale.body); assert.equal(stale.json().code,'VERSION_CONFLICT');
    assert.deepEqual(Object.keys(stale.json()).sort(),['code','error','outcome']);
    assert.ok(!stale.body.includes(marker)); assert.ok(!stale.body.includes('currentDoc')); assert.ok(!stale.body.includes(body.slice(0,100)));
    await pool.query('DELETE FROM auth_sessions WHERE id=$1',[owner.sessionId]);
    const revoked = await app.inject({ method:'GET',url:`/api/v1/docs/${f.doc.id}/live`,headers:{'x-fixture-actor':owner.principal.id} });
    assert.equal(revoked.statusCode,401); assert.ok(!revoked.body.includes(marker));
  } finally { await app.close(); await authority.close(); assert.equal(outputBudget.bytes,0); }
});

test('actual 100k live HTTP read waits behind two full codec leases before SQL and returns its exact confirmed head', { timeout: 15_000 }, async () => {
  const f = await scene(); const body = '😀'.repeat(50_000);
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/docs/${f.doc.id}`, { body: { body }, headers: { 'if-match': '"1"' } }), 200);
  const owner = await context(f.owner); const outputBudget = new EditingOutputBudget(); const runtime = editingRuntime();
  let sql = 0;
  const authority = wikiAuthority({ pool: { async connect() { sql++; return pool.connect(); } } }, runtime, { outputBudget });
  const app = Fastify();
  // Fixture identity selection only: the actual HTTP route still executes current
  // PostgreSQL session/project fences and the held protected response handoff.
  await app.register(editingRoutes, { authority, outputBudget, sessions: {
    async resolveSession() { return owner; }, async requirePrincipal() { return owner; },
  } });
  const head = await authority.bootstrap(owner, f.doc.id);
  const empty = new Uint8Array(); const first = runtime.reserve(empty); const second = runtime.reserve(empty);
  assert.equal(runtime.externalInputBytes, 32 * 1024 * 1024);
  let settled = false; let settlement: Promise<unknown> = Promise.resolve();
  try {
    await app.ready(); const before = sql;
    const request = app.inject({ method: 'GET', url: `/api/v1/docs/${f.doc.id}/live` }).then((response) => { settled = true; return response; });
    settlement = request;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(sql, before); assert.equal(runtime.admissionQueued, 1);
    assert.equal(runtime.externalInputBytes, 32 * 1024 * 1024);
    assert.ok(outputBudget.bytes >= 24 * 1024 * 1024, 'the HTTP response/context owns its waiting continuation');
    runtime.release(first);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(sql, before); assert.equal(runtime.admissionQueued, 1);
    runtime.release(second);
    const response = await request; assert.equal(response.statusCode, 200, response.body);
    const observed = response.json(); assert.equal(observed.body, body);
    assert.deepEqual([observed.generation, observed.sequence, observed.hash, observed.checkpoint], [head.generation, head.sequence, head.hash, head.checkpoint]);
    assert.ok(sql > before, 'actual SQL begins only after full future input/state promotion');
    // raw.end completes inject while the held handoff transaction still awaits
    // COMMIT. Observe actual work settlement before checking its retained lease.
    const deadline = performance.now() + 1500;
    while (authority.sqlActive !== 0 || runtime.codecLeases !== 0) {
      assert.ok(performance.now() < deadline, 'actual SQL/admission settlement exceeded its finite bound');
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(authority.sqlActive, 0); assert.equal(runtime.codecLeases, 0);
    assert.equal(runtime.admissionQueued, 0); assert.equal(runtime.externalInputBytes, 0); assert.equal(outputBudget.bytes, 0);
  } finally {
    runtime.release(first); runtime.release(second); await Promise.allSettled([settlement]);
    await app.close(); await authority.close();
  }
  assert.equal(runtime.codecLeases, 0); assert.equal(runtime.externalInputBytes, 0); assert.equal(outputBudget.bytes, 0);
});

/** Founder direction 2026-10-09 (B1): incremental public updates from one writer replica. */
function typist(authority: ReturnType<typeof wikiAuthority>, who: SessionContext, head: Awaited<ReturnType<ReturnType<typeof wikiAuthority>['bootstrap']>>) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(head.checkpoint, 'base64')); let vector = Y.encodeStateVector(doc);
  return { doc,
    learn(bytes: Uint8Array) { Y.applyUpdate(doc, bytes); vector = Y.encodeStateVector(doc); },
    async type(text: string, through = authority) {
      doc.getText('body').insert(doc.getText('body').length, text);
      const bytes = Y.encodeStateAsUpdate(doc, vector); vector = Y.encodeStateVector(doc);
      const envelope: WikiTextEnvelope = { workspace: head.workspaceId, kind: 'wiki', room: head.resourceId, generation: head.generation,
        actor: who.principal.id, operation: 'text', uuid: randomUUID(), replica: doc.clientID, parameters: null };
      const receipt = await through.submit(who, head.resourceId, envelope, bytes, through.reserve(bytes));
      return { bytes, receipt };
    } };
}
const liveHead = async (docId: string) => (await pool.query('SELECT sequence,snapshot_sequence,revision,codec_state::text AS codec FROM doc_live_heads WHERE doc_id=$1', [docId])).rows[0] as
  { sequence: string; snapshot_sequence: string; revision: string; codec: string };

test('a text commit appends its update and ledger to the log; the full state is rewritten only every 64 updates', { timeout: 30_000 }, async () => {
  const f = await scene(); const authority = wikiAuthority({ pool });
  try {
    const owner = await context(f.owner); const head = await authority.bootstrap(owner, f.doc.id); const writer = typist(authority, owner, head);
    await authority.enroll(owner, f.doc.id, { generation: head.generation, replicaId: writer.doc.clientID });
    const enrolled = await liveHead(f.doc.id);
    for (const text of ['One. ', 'Two. ', 'Three. ']) await writer.type(text);
    const between = await liveHead(f.doc.id);
    assert.equal(Number(between.sequence), 3); assert.equal(Number(between.snapshot_sequence), 0);
    assert.equal(between.codec, enrolled.codec, 'A commit between snapshots leaves the stored snapshot untouched');
    assert.equal(Number(between.revision), Number(enrolled.revision) + 3);
    const logged = (await pool.query('SELECT sequence,ledger FROM doc_live_updates WHERE doc_id=$1 ORDER BY sequence', [f.doc.id])).rows as { sequence: string; ledger: { nodes: unknown[] } }[];
    assert.deepEqual(logged.map((row) => Number(row.sequence)), [1, 2, 3]);
    assert.ok(logged.every((row) => row.ledger.nodes.length === 1), 'Each logged update carries the ledger entries it added');
    for (let index = 4; index <= 64; index++) await writer.type(`${index}. `);
    const compacted = await liveHead(f.doc.id);
    assert.equal(Number(compacted.snapshot_sequence), 64); assert.equal(JSON.parse(compacted.codec).sequence, 64);
    assert.equal(JSON.parse(compacted.codec).receipts, undefined, 'Receipts stay in the immutable intent rows');
    await writer.type('Sixty-five. ');
    assert.equal(Number((await liveHead(f.doc.id)).snapshot_sequence), 64);
    assert.equal((await pool.query('SELECT count(*)::int n FROM doc_live_updates WHERE doc_id=$1', [f.doc.id])).rows[0].n, 65, 'Compaction never removes history');
  } finally { await authority.close(); }
});

test('a fresh API process rebuilds a room from its snapshot and the log after it, and continues it (crash replay)', { timeout: 30_000 }, async () => {
  const f = await scene(); const first = wikiAuthority({ pool }); let second: ReturnType<typeof wikiAuthority> | null = null;
  try {
    const owner = await context(f.owner); const head = await first.bootstrap(owner, f.doc.id); const writer = typist(first, owner, head);
    await first.enroll(owner, f.doc.id, { generation: head.generation, replicaId: writer.doc.clientID });
    for (let index = 1; index <= 70; index++) await writer.type(index % 7 ? `${index} ` : `\n${index}. `);
    assert.equal(Number((await liveHead(f.doc.id)).snapshot_sequence), 64);
    const before = first.rooms.get(f.doc.id, head.generation)!.state;
    await first.close();
    second = wikiAuthority({ pool });
    const restarted = await second.bootstrap(owner, f.doc.id);
    assert.equal(restarted.sequence, 70); assert.equal(restarted.body, writer.doc.getText('body').toString());
    const rebuilt = second.rooms.get(f.doc.id, head.generation)!.state;
    for (const field of ['sequence', 'body', 'nodes', 'deleted', 'splits', 'enrollments'] as const) assert.deepEqual(rebuilt[field], before[field], field);
    const check = new Y.Doc(); try { Y.applyUpdate(check, Buffer.from(restarted.checkpoint, 'base64')); assert.equal(check.getText('body').toString(), restarted.body); } finally { check.destroy(); }
    const next = await writer.type('After the restart.', second);
    assert.equal(next.receipt.sequence, 71);
    assert.equal((await second.bootstrap(owner, f.doc.id)).body, writer.doc.getText('body').toString());
  } finally { await first.close(); await second?.close(); }
});

test('two API processes alternate commits on one room; an enrollment elsewhere makes a decoded room stale', { timeout: 30_000 }, async () => {
  const f = await scene(); const one = wikiAuthority({ pool }); const two = wikiAuthority({ pool });
  try {
    const owner = await context(f.owner); const peer = await context(f.peer);
    const head = await one.bootstrap(owner, f.doc.id); const ada = typist(one, owner, head);
    await one.enroll(owner, f.doc.id, { generation: head.generation, replicaId: ada.doc.clientID });
    await ada.type('Ada on one. ');
    // Kai enrolls through the other process: one's decoded room is now at an older revision.
    const kaiHead = await two.bootstrap(peer, f.doc.id); const kai = typist(two, peer, kaiHead);
    await two.enroll(peer, f.doc.id, { generation: head.generation, replicaId: kai.doc.clientID });
    for (let round = 0; round < 6; round++) {
      const fromKai = await kai.type(`Kai ${round}. `, round % 2 ? one : two); ada.learn(fromKai.bytes);
      const fromAda = await ada.type(`Ada ${round}. `, round % 2 ? two : one); kai.learn(fromAda.bytes);
    }
    const expected = ada.doc.getText('body').toString();
    assert.equal(kai.doc.getText('body').toString(), expected);
    const [viaOne, viaTwo] = [await one.bootstrap(owner, f.doc.id), await two.bootstrap(peer, f.doc.id)];
    assert.equal(viaOne.body, expected); assert.equal(viaTwo.body, expected); assert.equal(viaOne.sequence, 13); assert.equal(viaTwo.hash, viaOne.hash);
    const a = one.rooms.get(f.doc.id, head.generation)!.state; const b = two.rooms.get(f.doc.id, head.generation)!.state;
    for (const field of ['sequence', 'body', 'nodes', 'deleted', 'splits', 'enrollments'] as const) assert.deepEqual(a[field], b[field], field);
  } finally { await one.close(); await two.close(); }
});

test('one confirmed read hands off every pending update in order and the head preview with the batch that reaches it', { timeout: 30_000 }, async () => {
  const f = await scene(); const authority = wikiAuthority({ pool });
  try {
    const owner = await context(f.owner); const peer = await context(f.peer);
    const head = await authority.bootstrap(owner, f.doc.id); const writer = typist(authority, owner, head);
    await authority.enroll(owner, f.doc.id, { generation: head.generation, replicaId: writer.doc.clientID });
    for (const text of ['One. ', 'Two. ', 'Three. ']) await writer.type(text);
    const read = async (afterSequence: number, previewAfterSequence: number) => {
      let seen: { updates: number[]; preview: boolean } | null = null;
      await authority.deliver(peer, f.doc.id, head.generation, afterSequence, (result) => {
        seen = { updates: result.updates.map((item) => item.sequence), preview: result.preview !== null };
      }, { previewAfterSequence, includeContent: true });
      return seen;
    };
    assert.deepEqual(await read(0, -1), { updates: [1, 2, 3], preview: true });
    assert.deepEqual(await read(1, 3), { updates: [2, 3], preview: false }, 'The head preview was already delivered');
    assert.deepEqual(await read(3, 0), { updates: [], preview: true });
    // The byte bound stops a batch before its stored size exceeds it, but never below one update.
    const sizes = (await pool.query('SELECT octet_length(bytes)::int n FROM doc_live_updates WHERE doc_id=$1 ORDER BY sequence', [f.doc.id])).rows.map((row) => row.n as number);
    const rows = liveEditingRows(db, (value) => value as never);
    assert.deepEqual((await rows.updates(f.doc.id, head.generation, 0, 64, 1)).map((row) => row.sequence), [1]);
    assert.deepEqual((await rows.updates(f.doc.id, head.generation, 0, 64, sizes[0]! + sizes[1]!)).map((row) => row.sequence), [1, 2]);
    assert.deepEqual((await rows.updates(f.doc.id, head.generation, 0, 2, 1024 * 1024)).map((row) => row.sequence), [1, 2]);
  } finally { await authority.close(); }
});
