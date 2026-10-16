import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { CreatedThought, Sketch, WorkItem } from '@flux/contracts';
import { pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect } from './support/mcp.js';
import { fillThread, threadBudget, type ThreadNativeScene } from './support/internal-agent-threads.js';

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

/**
 * Erases a whole project. The first three deletes clear existing references outside the agent-thread tables
 * (agent action receipts and standing grants, task discussions) that block any project deletion today; they are
 * not part of 0098. Guard events reference receipts through a deferred key, so they go with the project below.
 */
async function eraseProject(projectId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM agent_command_receipts WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM agent_standing_grants WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM project_task_discussions WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM projects WHERE id=$1', [projectId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function upload(f: ThreadNativeScene, text: string) {
  const response = await fetch(new URL(`/api/v1/projects/${f.projectId}/files?uploadId=${randomUUID()}&name=erasure.txt`, f.owner.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: f.owner.cookieHeader(), origin: f.owner.defaultOrigin }, body: text,
  });
  assert.equal(response.status, 201);
  return await response.json() as { id: string };
}

/** One project with every installed artifact kind, a real thread (native turns and a human boundary) and resets. */
async function fullProject() {
  const f = await actionScene(pool), grant = await f.grant('conversation.reply', 'execute', 100);
  const task = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Erased with its project' } }), 201) as unknown as WorkItem;
  await fillThread(f, task.id, grant.id);
  expect(await f.owner.request('POST', `/api/v1/work/${task.id}/agent-thread`,
    { body: { body: 'A person answers in the thread.', clientMessageId: randomUUID() } }), 201);
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/docs`,
    { body: { title: 'Erasure notes', body: `[The task](flux:work/${task.id}) has a measured note.`, state: 'published' } }), 201);
  expect(await f.owner.request('PATCH', `/api/v1/materials/${f.source.materialId}`,
    { body: { clientMutationId: randomUUID(), expectedVersion: f.source.version, body: 'A revised release plan.' } }), 200);
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/results`,
    { body: { title: 'Measured', finding: 'positive', evidence: 'Observed behavior', work: [task.id], clientCommandId: randomUUID() } }), 201);
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/decisions`,
    { body: { title: 'Keep the rule', rationale: 'Observed data', affects: [task.id] } }), 201);
  const map = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/sketches`,
    { body: { title: 'Erasure map', scope: 'project', projectId: f.projectId } }), 201) as unknown as Sketch;
  const { thought } = expect(await f.owner.request('POST', `/api/v1/sketches/${map.id}/thoughts`,
    { body: { id: randomUUID(), text: 'First thought', x: 20, y: 20 }, headers: { 'idempotency-key': randomUUID() } }), 201) as unknown as CreatedThought;
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/links`,
    { body: { from: { type: 'work', id: task.id }, to: { type: 'thought', id: thought.id } } }), 201);
  expect(await f.owner.request('PATCH', `/api/v1/sketches/${map.id}/thoughts/${thought.id}`,
    { body: { text: 'A changed thought' }, headers: { 'if-match': `"${thought.version}"`, 'idempotency-key': randomUUID() } }), 200);
  const file = await upload(f, `erasure ${randomUUID()}`);
  expect(await f.owner.request('POST', `/api/v1/work/${task.id}/discussion`,
    { body: { body: 'A published work product', attachmentIds: [file.id], clientMessageId: randomUUID() } }), 201);
  return { ...f, task };
}

test('erasing a project removes its thread rows and provenance; ordinary updates and deletes stay refused', { timeout: 120_000 }, async () => {
  const f = await fullProject();
  // A second project in the same workspace keeps every row.
  const kept = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`,
    { body: { name: 'Kept project', visibility: 'restricted' } }), 201) as { id: string };
  expect(await f.owner.request('POST', `/api/v1/projects/${kept.id}/docs`, { body: { title: 'Kept doc', body: 'Kept body', state: 'published' } }), 201);
  const keptBefore = await rows(kept.id);
  assert.ok(keptBefore.agent_thread_artifact_boundaries > 0 && keptBefore.agent_thread_artifact_mutations > 0);

  const p = f.projectId, before = await rows(p);
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
