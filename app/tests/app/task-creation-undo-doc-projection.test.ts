import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Doc } from '@flux/contracts';
import { sql, workRows, TaskUseRefusal } from '@flux/db';
import { docUseCases } from '../../apps/server/src/docs/adapters.js';
import { prepareDocWrite } from '../../apps/server/src/docs/preparation.js';
import { EditingHTTPAdmission } from '../../apps/server/src/editing/http-admission.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect } from './support/mcp.js';

const compile = (query: Parameters<typeof db.execute>[0]) => new PgDialect().sqlToQuery(typeof query === 'string' ? sql.raw(query) : query.getSQL()).sql;
async function scene() {
  const f = await actionScene(pool);
  const owner = String((await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id);
  const doc = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`, { body: { title: 'Complete counted response', body: 'Unchanged body.' } }), 201) as unknown as Doc;
  return { f, owner, doc };
}
async function ownership() {
  const budget = new EditingOutputBudget(); const admission = new EditingHTTPAdmission(budget);
  const preparation = await prepareDocWrite({}, budget, admission);
  return { budget, memory: preparation.memory, release() { preparation.release(); admission.close(); assert.equal(budget.bytes, 0); } };
}

// Bulk SQL creates historical projection data only, not production writer proof.
test('unchanged native doc update counts all incoming and outgoing links before allocation and refuses without any document/use change', { timeout: 60_000 }, async () => {
  const { f, owner, doc } = await scene();
  await pool.query(`INSERT INTO project_work_items(workspace_id,project_id,title,created_by_kind,created_by_id)
    SELECT $1,$2,'Counted historical row '||n,'human',$3 FROM generate_series(1,5000) n`, [f.workspaceId, f.projectId, owner]);
  await pool.query(`INSERT INTO project_object_links(workspace_id,project_id,role,from_type,from_id,to_type,to_id,created_by_kind,created_by_id)
    SELECT $1,$2,'related','work',id,'doc',$3,'human',$4 FROM project_work_items WHERE project_id=$2
    UNION ALL SELECT $1,$2,'related','doc',$3,'work',id,'human',$4 FROM project_work_items WHERE project_id=$2`, [f.workspaceId, f.projectId, doc.id, owner]);
  const state = async () => ({ material: (await pool.query('SELECT * FROM project_materials WHERE id=$1', [doc.id])).rows,
    versions: (await pool.query('SELECT * FROM project_material_versions WHERE material_id=$1 ORDER BY version', [doc.id])).rows,
    used: (await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1 AND first_persisted_use_at IS NOT NULL', [f.projectId])).rows });
  const before = await state(); const owned = await ownership(); let count = false; let load = false;
  const controlled = new Proxy(db, { get(target, property) {
    if (property === 'transaction') return (action: Parameters<typeof db.transaction>[0]) => target.transaction(async tx => action(new Proxy(tx, { get(connection, key) {
      if (key === 'execute') return async (query: Parameters<typeof tx.execute>[0]) => {
        const text = compile(query);
        if (text.includes('work_projection') && text.includes('project_object_links')) {
          if (text.includes('work_projection_size')) load = true; else count = true;
        }
        return connection.execute(query);
      };
      const value = Reflect.get(connection, key, connection); return typeof value === 'function' ? value.bind(connection) : value;
    } })));
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    await assert.rejects(docUseCases(controlled, owned.memory).updateDoc({ kind: 'human', id: owner }, doc.id, { body: doc.body }, 1),
      error => error instanceof Error && 'code' in error && error.code === 'EDITING_OUTPUT_CAPACITY');
    assert.equal(count, true); assert.equal(load, false); assert.deepEqual(await state(), before);
  } finally { owned.release(); }
});

test('actual unchanged REST doc update returns complete incoming/outgoing links and current titles without marking historical targets used', { timeout: 60_000 }, async () => {
  const { f, owner, doc } = await scene(); const workId = randomUUID();
  await pool.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id)
    VALUES($1,$2,$3,'Visible historical title','human',$4)`, [workId, f.workspaceId, f.projectId, owner]);
  const inserted = await pool.query(`INSERT INTO project_object_links(workspace_id,project_id,role,from_type,from_id,to_type,to_id,created_by_kind,created_by_id)
    VALUES($1,$2,'related','work',$3,'doc',$4,'human',$5),($1,$2,'related','doc',$4,'work',$3,'human',$5) RETURNING id`, [f.workspaceId, f.projectId, workId, doc.id, owner]);
  const response = expect(await f.owner.request('PATCH', `/api/v1/docs/${doc.id}`, { headers: { 'idempotency-key': randomUUID() },
    body: { expectedVersion: 1, body: doc.body } }), 200) as unknown as Doc;
  assert.equal(response.version, 1); assert.deepEqual(response.links.map(link => link.id).sort(), inserted.rows.map(row => String(row.id)).sort());
  for (const link of response.links) {
    assert.equal(link.from.type === 'work' ? link.fromTitle : link.toTitle, 'Visible historical title');
    assert.equal(link.from.type === 'doc' ? link.fromTitle : link.toTitle, doc.title);
  }
  assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [workId])).rows[0].first_persisted_use_at, null);
});

test('concurrent incoming-link growth is refused inside the complete projection SQL snapshot before any expanded rows transfer', { timeout: 60_000 }, async () => {
  const { f, owner, doc } = await scene(); const workId = randomUUID(); const owned = await ownership(); let grown = false; let returned: unknown;
  await pool.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id)
    VALUES($1,$2,$3,'Count race target','human',$4)`, [workId, f.workspaceId, f.projectId, owner]);
  const controlled = new Proxy(db, { get(target, property) {
    if (property === 'execute') return async (query: Parameters<typeof db.execute>[0]) => {
      const text = compile(query); const result = await target.execute(query);
      if (text.includes('work_projection') && text.includes('project_object_links')) {
        if (!text.includes('work_projection_size') && !grown) {
          grown = true;
          await pool.query(`INSERT INTO project_object_links(workspace_id,project_id,role,from_type,from_id,to_type,to_id,created_by_kind,created_by_id)
            VALUES($1,$2,'related','work',$3,'doc',$4,'human',$5)`, [f.workspaceId, f.projectId, workId, doc.id, owner]);
        } else if (text.includes('work_projection_size')) returned = result.rows;
      }
      return result;
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    await assert.rejects(workRows(controlled, owned.memory).links([doc.id]), error => error instanceof TaskUseRefusal && error.code === 'TASK_TARGET_SET_CHANGED');
    assert.equal(grown, true); assert.deepEqual(returned, [{ rows: null }]);
    assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1', [workId])).rows[0].first_persisted_use_at, null);
  } finally { owned.release(); }
});

test('title and unbounded human-name byte growth with unchanged row count cannot escape the counted display reservation', { timeout: 60_000 }, async () => {
  const { f, owner } = await scene(); const workId = randomUUID();
  await pool.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id)
    VALUES($1,$2,$3,'A','human',$4)`, [workId, f.workspaceId, f.projectId, owner]);
  const originalName = String((await pool.query('SELECT name FROM auth_users WHERE id=$1', [owner])).rows[0].name);
  try {
    for (const kind of ['title', 'name'] as const) {
      const owned = await ownership(); let grown = false; let returned: unknown;
      const controlled = new Proxy(db, { get(target, property) {
        if (property === 'execute') return async (query: Parameters<typeof db.execute>[0]) => {
          const text = compile(query); const result = await target.execute(query);
          if (text.includes('work_projection')) {
            if (!text.includes('work_projection_size') && !grown) {
              grown = true;
              if (kind === 'title') await pool.query('UPDATE project_work_items SET title=$2 WHERE id=$1', [workId, 'B'.repeat(200)]);
              else await pool.query('UPDATE auth_users SET name=$2 WHERE id=$1', [owner, 'N'.repeat(100000)]);
            } else if (text.includes('work_projection_size')) returned = result.rows;
          }
          return result;
        };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      try {
        const rows = workRows(controlled, owned.memory);
        await assert.rejects(kind === 'title' ? rows.titles(f.projectId, [{ type: 'work', id: workId }]) : rows.names([{ kind: 'human', id: owner }]),
          error => error instanceof TaskUseRefusal && error.code === 'TASK_TARGET_SET_CHANGED');
        assert.equal(grown, true); assert.deepEqual(returned, [{ rows: null }]);
      } finally { owned.release(); }
    }
  } finally { await pool.query('UPDATE auth_users SET name=$2 WHERE id=$1', [owner, originalName]); }
});

test('protected material title lookup counts and returns only the exact requested immutable version despite long history', { timeout: 60_000 }, async () => {
  const { doc } = await scene(); const owned = await ownership(); let counted: unknown;
  await pool.query(`INSERT INTO project_material_versions(material_id,workspace_id,project_id,version,title,body,author_id,author_agent_id,reason,state)
    SELECT material_id,workspace_id,project_id,n,'Historical version '||n,body,author_id,author_agent_id,reason,state
    FROM project_material_versions CROSS JOIN generate_series(2,300) n WHERE material_id=$1 AND version=1`, [doc.id]);
  const controlled = new Proxy(db, { get(target, property) {
    if (property === 'execute') return async (query: Parameters<typeof db.execute>[0]) => {
      const result = await target.execute(query); const text = compile(query);
      if (text.includes('work_projection') && !text.includes('work_projection_size')) counted = result.rows;
      return result;
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const found = await workRows(controlled, owned.memory).titles(doc.projectId, [{ type: 'material', id: doc.id, version: 1 }]);
    assert.equal((counted as Array<{ count: string }>)[0]!.count, '1'); assert.equal(found.size, 1);
    assert.equal(found.get(`material:${doc.id}:1`)?.title, doc.title); assert.equal(found.has(`material:${doc.id}:2`), false);
  } finally { owned.release(); }
});

test('a legally padded historical title repeated on1000 incoming links is charged for every display copy before the complete no-op response is constructed', { timeout: 60_000 }, async () => {
  const { f, owner, doc } = await scene(); const padded = `${' '.repeat(40960)}X`;
  // Retained SQL history can satisfy length(btrim(title))<=200 without a raw
  // title-length bound. Add a genuine immutable fixture version, never UPDATE it.
  await pool.query(`INSERT INTO project_material_versions(material_id,workspace_id,project_id,version,title,body,author_id,author_agent_id,reason,state)
    SELECT material_id,workspace_id,project_id,2,$2,body,author_id,author_agent_id,reason,state
    FROM project_material_versions WHERE material_id=$1 AND version=1`, [doc.id, padded]);
  await pool.query('UPDATE project_materials SET current_version=2 WHERE id=$1', [doc.id]);
  await pool.query(`INSERT INTO project_work_items(workspace_id,project_id,title,created_by_kind,created_by_id)
    SELECT $1,$2,'Multiplicity fixture '||n,'human',$3 FROM generate_series(1,1000) n`, [f.workspaceId, f.projectId, owner]);
  await pool.query(`INSERT INTO project_object_links(workspace_id,project_id,role,from_type,from_id,to_type,to_id,created_by_kind,created_by_id)
    SELECT $1,$2,'related','work',id,'doc',$3,'human',$4 FROM project_work_items WHERE project_id=$2 AND title LIKE 'Multiplicity fixture %'`,
  [f.workspaceId, f.projectId, doc.id, owner]);
  const state = async () => ({ material: (await pool.query('SELECT * FROM project_materials WHERE id=$1', [doc.id])).rows,
    versions: (await pool.query('SELECT * FROM project_material_versions WHERE material_id=$1 ORDER BY version', [doc.id])).rows,
    links: (await pool.query('SELECT count(*)::int AS n FROM project_object_links WHERE to_id=$1', [doc.id])).rows,
    used: (await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1 AND first_persisted_use_at IS NOT NULL', [f.projectId])).rows });
  const before = await state(); const owned = await ownership(); let multiplicity = false;
  const memory = { temporary: owned.memory.temporary, reserve(bytes: number) {
    if (bytes > 1000 * padded.length * 48) multiplicity = true;
    owned.memory.reserve(bytes);
  } };
  try {
    await assert.rejects(docUseCases(db, memory).updateDoc({ kind: 'human', id: owner }, doc.id, { body: doc.body }, 2),
      error => error instanceof Error && 'code' in error && error.code === 'EDITING_OUTPUT_CAPACITY');
    assert.equal(multiplicity, true, 'Source rows and titles fit; the actual repeated display allowance refuses before array/wire construction');
    assert.deepEqual(await state(), before);
  } finally { owned.release(); }
});
