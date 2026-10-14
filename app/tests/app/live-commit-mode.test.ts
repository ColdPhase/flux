import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import type { Doc, Sketch } from '@flux/contracts';
import { schema } from '@flux/db';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import { mapBackend } from '../../apps/server/src/editing/map-backend.js';
import { mapAuthority } from '../../apps/server/src/editing/map-authority.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { db, pool } from './support/db.js';
import { expectStatus, person, project, workspace } from './support/people.js';

const TRANSIENT = 'SET LOCAL synchronous_commit = off';

/** Records each pooled transaction's statements; PostgreSQL runs every one of them. */
function recording() {
  const transactions: string[][] = [];
  const recorded = { async connect() {
    const client = await pool.connect(); const query = client.query; const release = client.release; const statements: string[] = [];
    transactions.push(statements);
    client.query = function (...args: unknown[]) { if (typeof args[0] === 'string') statements.push(args[0]); return Reflect.apply(query, client, args); } as typeof client.query;
    client.release = function (discard?: Error | boolean) { client.query = query; client.release = release; Reflect.apply(release, client, [discard]); };
    return client;
  } };
  /** The commit mode of every transaction `action` ran. */
  async function modes(action: () => Promise<unknown>) {
    const from = transactions.length; await action();
    const ran = transactions.slice(from).filter((statements) => statements.includes('COMMIT'));
    assert.ok(ran.length > 0, 'The operation committed a transaction');
    return [...new Set(ran.map((statements) => statements.includes(TRANSIENT) ? 'transient' : 'durable'))];
  }
  return { pool: recorded, modes };
}
async function context(user: Awaited<ReturnType<typeof person>>): Promise<SessionContext> {
  const row = (await pool.query('SELECT s.id,s.expires_at,u.name,u.email FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 1', [user.id])).rows[0];
  return { sessionId: row.id, expiresAt: row.expires_at, principal: { kind: 'human', id: user.id }, user: { id: user.id, name: row.name, email: row.email } };
}

// #228 Gate 4: a read, a handoff fence or presence writes nothing that must survive a crash, so its
// COMMIT need not wait for the WAL flush; durable writes (text, enrollment, saves) still do.
test('live wiki commits only reads, fences and presence without waiting for the WAL flush', { timeout: 15_000 }, async () => {
  const owner = await person('commit-mode-wiki'); const ws = await workspace(owner, 'Commit modes');
  const place = await project(owner, ws.id, 'Commit modes', 'restricted');
  const doc = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Modes', body: 'Saved. ' } }), 201) as Doc;
  const who = await context(owner); const record = recording(); const authority = wikiAuthority({ pool: record.pool }); const local = new Y.Doc();
  try {
    let head!: Awaited<ReturnType<typeof authority.bootstrap>>;
    assert.deepEqual(await record.modes(async () => { head = await authority.bootstrap(who, doc.id); }), ['durable'], 'bootstrap initializes the room');
    assert.deepEqual(await record.modes(() => authority.enroll(who, doc.id, { generation: head.generation, replicaId: local.clientID })), ['durable']);
    Y.applyUpdate(local, Buffer.from(head.checkpoint, 'base64')); local.getText('body').insert(head.body.length, 'Typed. ');
    const bytes = Y.encodeStateAsUpdate(local);
    const envelope = { workspace: head.workspaceId, kind: 'wiki' as const, room: doc.id, generation: head.generation, actor: owner.id,
      operation: 'text' as const, uuid: randomUUID(), replica: local.clientID, parameters: null };
    assert.deepEqual(await record.modes(() => authority.submit(who, doc.id, envelope, bytes, authority.reserve(bytes))), ['durable'], 'A text is durable before its ACK');
    assert.deepEqual(await record.modes(() => authority.deliverReceipt(who, doc.id, envelope.uuid, (receipt) => assert.equal(receipt?.sequence, 1))), ['transient']);
    const updates: number[] = [];
    assert.deepEqual(await record.modes(() => authority.deliver(who, doc.id, head.generation, 0, (result) => updates.push(...result.updates.map((update) => update.sequence)), { includeContent: true })), ['transient']);
    assert.deepEqual(updates, [1], 'A transient read hands off the durable update');
    assert.deepEqual(await record.modes(() => authority.cursor(who, doc.id, head.generation, randomUUID(), null)), ['transient']);
    assert.deepEqual(await record.modes(() => authority.handoff(who, doc.id, () => {})), ['transient']);
    assert.deepEqual(await record.modes(() => authority.receipt(who, doc.id, envelope.uuid)), ['transient']);
  } finally { local.destroy(); await authority.close(); }
});

test('live map commits fences, leases, previews and presence without waiting for the WAL flush', { timeout: 15_000 }, async () => {
  const owner = await person('commit-mode-map'); const ws = await workspace(owner, 'Map commit modes');
  const place = await project(owner, ws.id, 'Map commit modes', 'restricted');
  const sketch = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { scope: 'project', projectId: place.id, title: 'Modes' } }), 201) as Sketch;
  const thought = randomUUID();
  await db.insert(schema.sketchThoughts).values({ id: thought, workspaceId: ws.id, sketchId: sketch.id, text: 'Seed', x: 0, y: 0, createdByUserId: owner.id });
  const session = await context(owner); const who = { sessionId: session.sessionId, actorId: owner.id };
  const record = recording(); const backend = mapBackend({ pool: record.pool }); const authority = mapAuthority(backend, new EditingOutputBudget());
  try {
    let generation = '';
    assert.deepEqual(await record.modes(() => backend.bootstrap(who, sketch.id, (head) => { generation = head.generation; })), ['durable'], 'bootstrap may create the room head');
    let lease!: Awaited<ReturnType<typeof authority.acquire>>;
    assert.deepEqual(await record.modes(async () => { lease = await authority.acquire(session, sketch.id, { gestureId: randomUUID(), thoughts: [{ id: thought, expectedVersion: 1 }] }); }), ['transient']);
    const connection = randomUUID();
    const command = { generation, gestureId: lease.gestureId, leaseId: lease.leaseId, sequence: 1, positions: [{ id: thought, x: 40, y: 50 }] };
    assert.deepEqual(await record.modes(() => authority.move(session, sketch.id, connection, command, Buffer.byteLength(JSON.stringify(command)))), ['transient']);
    const previews: unknown[] = [];
    assert.deepEqual(await record.modes(() => backend.deliver(who, sketch.id, generation, 0, (result) => previews.push(...result.transient))), ['transient']);
    assert.equal(previews.length, 1, 'A transient read hands off the preview');
    assert.deepEqual(await record.modes(() => backend.presence(who, sketch.id, connection, { generation, selected: [thought], cursor: null })), ['transient']);
    assert.deepEqual(await record.modes(() => backend.authorize(who, sketch.id, () => {})), ['transient']);
  } finally { await backend.close(); }
});
