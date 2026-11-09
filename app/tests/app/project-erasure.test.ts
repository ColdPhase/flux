import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { expect } from './support/mcp.js';
import { eraseProject, erasedWithProject, fullProject, projectReferences } from './support/project-erasure-scene.js';

// #530 / 0098, #551 / 0101: a project leaves with everything that names it, in one transaction, and a second project of the workspace keeps every row.
test('erasing a project removes every row that names it, its task discussion included, and leaves another project untouched', { timeout: 120_000 }, async () => {
  const f = await fullProject();
  const kept = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`,
    { body: { name: 'Kept project', visibility: 'restricted' } }), 201) as { id: string };
  expect(await f.owner.request('POST', `/api/v1/projects/${kept.id}/docs`, { body: { title: 'Kept doc', body: 'Kept body' } }), 201);
  const p = f.projectId;
  const references = await projectReferences(p);
  for (const table of erasedWithProject) assert.ok(references[table]! > 0, `${table} is seeded`);
  const discussion = (await pool.query(`SELECT count(*)::int n FROM project_messages m JOIN project_task_discussions d ON d.conversation_id = m.conversation_id
    WHERE d.project_id = $1`, [p])).rows[0].n as number;
  assert.ok(discussion >= 2, 'the discussion holds the agent\'s message and the person\'s');
  const keptReferences = await projectReferences(kept.id);

  await eraseProject(p);
  assert.equal((await pool.query('SELECT count(*)::int n FROM projects WHERE id=$1', [p])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM project_messages WHERE project_id=$1', [p])).rows[0].n, 0);
  // Nothing in any table that names a project still names the erased one, and the other project is untouched.
  for (const [table, count] of Object.entries(await projectReferences(p))) assert.equal(count, 0, `${table} keeps no row of the erased project`);
  assert.deepEqual(await projectReferences(kept.id), keptReferences);
});
