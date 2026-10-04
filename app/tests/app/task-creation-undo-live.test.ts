import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import type { Doc, WorkItem } from '@flux/contracts';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';

async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function fixture() {
  const f = await actionScene(pool); const grant = await f.grant('work.create', 'execute');
  const created = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
    grantId: grant.id, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title: 'Actual live reference target' } }));
  const item = await f.read(String(created.workId)) as unknown as WorkItem;
  const owner = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  const [session] = (await pool.query('SELECT s.id,s.expires_at,u.name,u.email FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 1', [owner])).rows;
  const who: SessionContext = { sessionId: session.id, expiresAt: session.expires_at, principal: { kind: 'human', id: owner }, user: { id: owner, name: session.name, email: session.email } };
  const doc = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`, { body: { title: 'Actual shared trial', body: 'Saved. ' } }), 201) as unknown as Doc;
  const document = new Y.Doc();
  const undo = () => f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: { clientCommandId: randomUUID(), expectedVersion: item.version } });
  return { ...f, item, who, doc, document, undo };
}
async function prepare(authority: ReturnType<typeof wikiAuthority>, f: Awaited<ReturnType<typeof fixture>>) {
  const head = await authority.bootstrap(f.who, f.doc.id);
  await authority.enroll(f.who, f.doc.id, { generation: head.generation, replicaId: f.document.clientID });
  Y.applyUpdate(f.document, Buffer.from(head.checkpoint, 'base64'));
  f.document.getText('body').insert(head.body.length, `[Trial](flux:work/${f.item.id})`);
  const submit = () => {
    const bytes = Y.encodeStateAsUpdate(f.document);
    return authority.submit(f.who, f.doc.id, { workspace: f.workspaceId, kind: 'wiki', room: f.doc.id, generation: head.generation,
      actor: f.who.principal.id, operation: 'text', uuid: randomUUID(), replica: f.document.clientID, parameters: null }, bytes, authority.reserve(bytes));
  };
  return { head, submit };
}

test('actual shared-text first use commits before waiting Undo; later removal cannot restore eligibility', { timeout: 30_000 }, async () => {
  const f = await fixture(); const held = barrier<number>(); const release = barrier(); let arm = false;
  const controlledPool = { async connect() {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      const member = Reflect.get(target, property, target);
      if (property === 'query') return async (...args: unknown[]) => {
        if (arm && args[0] === 'COMMIT') {
          arm = false; const result = await target.query('SELECT pg_backend_pid() AS pid'); held.resolve(Number(result.rows[0].pid));
          await bounded(release.promise, 'live COMMIT release');
        }
        return Reflect.apply(member, target, args);
      };
      return typeof member === 'function' ? member.bind(target) : member;
    } });
  } };
  const authority = wikiAuthority({ pool: controlledPool }); let submit: Promise<unknown> | undefined; let undo: ReturnType<typeof f.undo> | undefined;
  try {
    const pending = await prepare(authority, f);
    assert.equal((await f.read(f.item.id) as unknown as WorkItem).creationUndo?.eligible, true, 'bootstrap/enrollment/read do not mark use');
    arm = true; submit = pending.submit(); void submit.catch(() => undefined);
    const pid = await bounded(held.promise, 'persisted live text'); undo = f.undo(); void undo.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid); release.resolve(); await bounded(submit, 'live COMMIT');
    assert.equal((await bounded(undo, 'Undo refusal')).status, 409);
    const stored = (await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.item.id])).rows[0].first_persisted_use_at;
    assert.ok(stored); const body = f.document.getText('body'); body.delete(pending.head.body.length, body.length - pending.head.body.length);
    await pending.submit();
    assert.deepEqual((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.item.id])).rows[0].first_persisted_use_at, stored);
    assert.equal((await f.read(f.item.id) as unknown as WorkItem).creationUndo?.reason, 'task_used');
  } finally {
    release.resolve(); try { await bounded(Promise.all([submit?.catch(() => undefined), undo?.catch(() => undefined)]), 'live race cleanup'); }
    finally { f.document.destroy(); await authority.close(); }
  }
});

test('Undo commits before blocked actual shared-text use; no head/update/intent or use latch survives refusal', { timeout: 30_000 }, async () => {
  const f = await fixture(); const authority = wikiAuthority({ pool }); const held = barrier<number>(); const release = barrier();
  let submit: Promise<unknown> | undefined; let undo: Promise<unknown> | undefined;
  try {
    const pending = await prepare(authority, f);
    undo = db.transaction(async tx => {
      const native = nativeWorkInTransaction(tx);
      await native.undoTaskCreation(f.who.principal, f.item.id, { clientCommandId: randomUUID(), expectedVersion: f.item.version });
      held.resolve(await backendPid(tx)); await bounded(release.promise, 'Undo COMMIT release'); await native.flushEvents();
    }); void undo.catch(() => undefined);
    const pid = await bounded(held.promise, 'retained Undo'); submit = pending.submit(); void submit.catch(() => undefined);
    await waitUntilBlockedBy(pool, pid); release.resolve(); await bounded(undo, 'Undo COMMIT');
    await assert.rejects(bounded(submit, 'late text refusal'), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TASK_CREATION_REVERTED');
    const head = (await pool.query('SELECT sequence,body FROM doc_live_heads WHERE doc_id=$1', [f.doc.id])).rows[0];
    assert.equal(Number(head.sequence), 0); assert.equal(head.body, pending.head.body);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM doc_live_updates WHERE doc_id=$1', [f.doc.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM live_editing_intents WHERE resource_id=$1', [f.doc.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [f.item.id])).rows[0].first_persisted_use_at, null);
  } finally {
    release.resolve(); try { await bounded(Promise.all([submit?.catch(() => undefined), undo?.catch(() => undefined)]), 'live refusal cleanup'); }
    finally { f.document.destroy(); await authority.close(); }
  }
});
