import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CreatedThought, Sketch, WorkItem } from '@flux/contracts';
import { pool } from './db.js';
import { actionScene } from './mcp-actions.js';
import { expect } from './mcp.js';
import { fillThread, type ThreadNativeScene } from './internal-agent-threads.js';

// One project with data in every feature, erased in one transaction (#530 / 0098, #551 / 0101).

/** Erases a whole project in one transaction, with no earlier clean-up (#551, migration 0101). */
export async function eraseProject(projectId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM projects WHERE id=$1', [projectId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Every table whose rows name a project, with how many rows name this one. */
export async function projectReferences(projectId: string) {
  const tables = (await pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='project_id' ORDER BY 1`)).rows.map((r) => r.table_name);
  const out: Record<string, number> = {};
  for (const table of tables) out[table] = (await pool.query(`SELECT count(*)::int n FROM "${table}" WHERE project_id=$1`, [projectId])).rows[0].n;
  return out;
}

/**
 * Rows of the features that 0101 lets leave with their project: receipts, grants, discussions and drafts;
 * and the task activity of 0112 (#488), which follows its task.
 */
export const erasedWithProject = ['agent_command_receipts', 'project_task_discussions', 'drafts', 'project_task_activity'] as const;

export async function seedDraft(f: ThreadNativeScene) {
  const owner = (await pool.query<{ created_by: string }>('SELECT created_by FROM projects WHERE id=$1', [f.projectId])).rows[0]!.created_by;
  await pool.query(`INSERT INTO drafts(id,workspace_id,project_id,owner_user_id,title,visibility,created_by) VALUES($1,$2,$3,$4,'A project draft','project',$4)`,
    [randomUUID(), f.workspaceId, f.projectId, owner]);
}

export async function upload(f: ThreadNativeScene, text: string) {
  const response = await fetch(new URL(`/api/v1/projects/${f.projectId}/files?uploadId=${randomUUID()}&name=erasure.txt`, f.owner.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: f.owner.cookieHeader(), origin: f.owner.defaultOrigin }, body: text,
  });
  assert.equal(response.status, 201);
  return await response.json() as { id: string };
}

/** One project with every installed artifact kind, a real thread (native turns and a human boundary) and resets. */
export async function fullProject() {
  const f = await actionScene(pool);
  const created = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title: 'Erased with its project' } }), 201) as unknown as WorkItem;
  // A due date makes the task's activity (#488, migration 0112) part of the scene: its rows erase with the task.
  const task = expect(await f.owner.request('PATCH', `/api/v1/work/${created.id}`,
    { body: { dueOn: '2026-12-01', clientCommandId: randomUUID() }, headers: { 'if-match': `"${created.version}"` } }), 200) as unknown as WorkItem;
  await fillThread(f, task.id);
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
  await seedDraft(f);
  return { ...f, task };
}

