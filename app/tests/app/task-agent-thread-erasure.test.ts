import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { expect } from './support/mcp.js';
import { threadBudget } from './support/internal-agent-threads.js';
import { eraseProject, erasedWithProject, fullProject, projectReferences } from './support/project-erasure-scene.js';

// #530 / 0098: agent-thread rows and their content-free provenance leave only together with their owner.
const threadTables = ['agent_thread_artifact_boundaries', 'agent_thread_artifact_resets', 'agent_thread_artifact_mutations',
  'agent_thread_guard_events'] as const;

async function rows(projectId: string) {
  const count = async (query: string) => (await pool.query(query, [projectId])).rows[0].n as number;
  const out: Record<string, number> = {};
  for (const table of threadTables) out[table] = await count(`SELECT count(*)::int n FROM ${table} WHERE project_id=$1`);
  out.threads = await count("SELECT count(*)::int n FROM project_conversations WHERE project_id=$1 AND space='agents'");
  out.threadMessages = await count(`SELECT count(*)::int n FROM project_messages m JOIN project_conversations c ON c.id=m.conversation_id
    WHERE c.project_id=$1 AND c.space='agents'`);
  return out;
}
const boundaryKinds = async (projectId: string) => (await pool.query(
  'SELECT DISTINCT kind FROM agent_thread_artifact_boundaries WHERE project_id=$1 ORDER BY kind', [projectId])).rows.map((r) => r.kind as string);
const refused = (constraint: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === '23514' && 'constraint' in error && error.constraint === constraint;

test('erasing a project removes its thread rows and provenance; ordinary updates and deletes stay refused', { timeout: 120_000 }, async () => {
  const f = await fullProject();
  // A second project in the same workspace keeps every row.
  const kept = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`,
    { body: { name: 'Kept project', visibility: 'restricted' } }), 201) as { id: string };
  expect(await f.owner.request('POST', `/api/v1/projects/${kept.id}/docs`, { body: { title: 'Kept doc', body: 'Kept body', state: 'published' } }), 201);
  const keptBefore = await rows(kept.id);
  assert.ok(keptBefore.agent_thread_artifact_boundaries > 0 && keptBefore.agent_thread_artifact_mutations > 0);

  const p = f.projectId, before = await rows(p);
  const references = await projectReferences(p);
  for (const table of erasedWithProject) assert.ok(references[table]! > 0, `${table} is seeded`);
  const keptReferences = await projectReferences(kept.id);
  assert.deepEqual(await boundaryKinds(p), ['decision', 'doc', 'file', 'material', 'result', 'thought']);
  for (const [key, value] of Object.entries(before)) assert.ok(value > 0, `${key} is seeded`);
  assert.equal(before.agent_thread_guard_events, 6, 'five native turns and one human boundary');
  const budget = await threadBudget(f.task.id);

  // While the project and task exist, provenance is immutable and the thread cannot be removed.
  for (const [statement, constraint] of [
    ['UPDATE agent_thread_artifact_boundaries SET revision=revision WHERE project_id=$1', 'agent_thread_guard_immutable'],
    ['DELETE FROM agent_thread_artifact_boundaries WHERE project_id=$1', 'agent_thread_guard_immutable'],
    ['UPDATE agent_thread_artifact_resets SET sequence=NULL WHERE project_id=$1', 'agent_thread_guard_immutable'],
    ['DELETE FROM agent_thread_artifact_resets WHERE project_id=$1', 'agent_thread_guard_immutable'],
    ['UPDATE agent_thread_guard_events SET turn_count=0 WHERE project_id=$1', 'agent_thread_guard_immutable'],
    ['DELETE FROM agent_thread_guard_events WHERE project_id=$1', 'agent_thread_guard_immutable'],
    ['DELETE FROM agent_thread_artifact_mutations WHERE project_id=$1', 'agent_thread_artifact_witness'],
    ["DELETE FROM project_messages WHERE conversation_id=(SELECT id FROM project_conversations WHERE project_id=$1 AND space='agents')", 'agent_thread_guard_identity'],
    // Removing only the thread would refund the task's turns; its guard events refuse.
    ["DELETE FROM project_conversations WHERE project_id=$1 AND space='agents'", 'agent_thread_guard_immutable'],
  ] as const) await assert.rejects(pool.query(statement, [p]), refused(constraint), statement);
  assert.deepEqual(await rows(p), before);
  assert.equal(await threadBudget(f.task.id), budget);

  await eraseProject(p);
  assert.equal((await pool.query('SELECT count(*)::int n FROM projects WHERE id=$1', [p])).rows[0].n, 0);
  for (const [key, value] of Object.entries(await rows(p))) assert.equal(value, 0, `${key} is erased with the project`);
  assert.equal((await pool.query('SELECT count(*)::int n FROM agent_thread_artifact_resets WHERE task_id=$1', [f.task.id])).rows[0].n, 0);
  assert.deepEqual(await rows(kept.id), keptBefore);
  // Nothing in any table that names a project still names the erased one, and the other project is untouched.
  for (const [table, count] of Object.entries(await projectReferences(p))) assert.equal(count, 0, `${table} keeps no row of the erased project`);
  assert.deepEqual(await projectReferences(kept.id), keptReferences);
  assert.equal((await pool.query('SELECT count(*)::int n FROM agent_command_receipts WHERE grant_id IN (SELECT id FROM agent_standing_grants WHERE project_id=$1)', [p])).rows[0].n, 0);
});

test('erasing a task removes its own thread, guard events and resets; the project keeps boundaries and witnesses', { timeout: 120_000 }, async () => {
  const f = await fullProject();
  const before = await rows(f.projectId);
  const own = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM agent_thread_guard_events WHERE task_id=$1) AS guard,
    (SELECT count(*)::int FROM agent_thread_artifact_resets WHERE task_id=$1) AS resets,
    (SELECT count(*)::int FROM project_conversations WHERE work_id=$1) AS threads`, [f.task.id])).rows[0];
  const seeded = await own();
  assert.ok(seeded.guard > 0 && seeded.resets > 0 && seeded.threads === 1);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM project_work_items WHERE id=$1', [f.task.id]);
    const left = (await client.query(`SELECT
      (SELECT count(*)::int FROM agent_thread_guard_events WHERE task_id=$1) AS guard,
      (SELECT count(*)::int FROM agent_thread_artifact_resets WHERE task_id=$1) AS resets,
      (SELECT count(*)::int FROM project_conversations WHERE work_id=$1) AS threads,
      (SELECT count(*)::int FROM agent_thread_artifact_boundaries WHERE project_id=$2) AS boundaries,
      (SELECT count(*)::int FROM agent_thread_artifact_mutations WHERE project_id=$2) AS witnesses`, [f.task.id, f.projectId])).rows[0];
    assert.deepEqual(left, { guard: 0, resets: 0, threads: 0,
      boundaries: before.agent_thread_artifact_boundaries, witnesses: before.agent_thread_artifact_mutations });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.deepEqual(await own(), seeded);
  // Leave no guarded history behind for later reversal checks.
  await eraseProject(f.projectId);
  assert.deepEqual(Object.values(await rows(f.projectId)), [0, 0, 0, 0, 0, 0]);
});

test('guard lookups by conversation use an index (0098)', async () => {
  const index = (await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename='agent_thread_guard_events' AND indexname='agent_thread_guard_conversation'")).rows[0];
  assert.match(index?.indexdef ?? '', /\(conversation_id\)/);
});
