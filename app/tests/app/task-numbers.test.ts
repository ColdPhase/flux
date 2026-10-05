import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WorkItem } from '@flux/contracts';
import { createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { guardFixturePool } from './support/fixture-database.js';
import { expectStatus, person, project, workspace } from './support/people.js';

// #276 (F-023 FF-1): each project numbers its tasks "#1", "#2", … in creation order; a number is never reused or
// changed. Migration 0055 numbers existing tasks by creation time, and a trigger numbers every new one.

test('0055 numbers existing tasks in creation order per project, numbers new ones next and refuses changes', async () => {
  const dir = 'packages/db/migrations';
  const manifest = await readMigrationManifest(dir, FLUX_SCHEMA_VERSION);
  const migration = manifest.find((entry) => entry.version === 55)!;
  assert.equal(migration.name, '0055_task_numbers.sql');
  const name = `flux_task_numbers_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  let history: ReturnType<typeof createDatabase>['pool'] | undefined;
  let guard: ReturnType<typeof guardFixturePool> | undefined;
  try {
    const createFixture = { text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 };
    await admin.query(createFixture);
    history = createDatabase(url.toString()).pool;
    guard = guardFixturePool(history);
    for (const file of manifest.filter((entry) => entry.version < 55)) await history.query(await readFile(join(dir, file.name), 'utf8'));
    const user = 'task-number-person';
    const ws = randomUUID();
    const [garden, bikes, empty] = [randomUUID(), randomUUID(), randomUUID()];
    await history.query('INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)', [user, 'Historical planner', 'task-number@example.test']);
    await history.query('INSERT INTO workspaces(id,name,created_by) VALUES($1,$2,$3)', [ws, 'Historical workspace', user]);
    for (const [id, title] of [[garden, 'Garden'], [bikes, 'Bikes'], [empty, 'Empty']]) {
      await history.query('INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)', [id, ws, title, 'restricted', user]);
    }
    // Inserted out of creation order, so the backfill must sort by creation time, not by insertion.
    const tasks = [
      { id: randomUUID(), project: garden, title: 'Third', at: '2026-09-03T10:00:00Z' },
      { id: randomUUID(), project: garden, title: 'First', at: '2026-09-01T10:00:00Z' },
      { id: randomUUID(), project: bikes, title: 'Only bike task', at: '2026-09-02T10:00:00Z' },
      { id: randomUUID(), project: garden, title: 'Second', at: '2026-09-02T10:00:00Z' },
    ];
    for (const task of tasks) {
      await history.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,'human',$5,$6,$6)`, [task.id, ws, task.project, task.title, user, task.at]);
    }
    const numbers = async () => (await history!.query('SELECT p.name AS project, w.title, w.number FROM project_work_items w JOIN projects p ON p.id = w.project_id ORDER BY p.name, w.number')).rows;
    const forward = await readFile(join(dir, migration.name), 'utf8');
    const reverse = await readFile(join(dir, 'reverse', '0055_task_numbers.down.sql'), 'utf8');
    await history.query(forward);
    const expected = [
      { project: 'Bikes', title: 'Only bike task', number: 1 },
      { project: 'Garden', title: 'First', number: 1 },
      { project: 'Garden', title: 'Second', number: 2 },
      { project: 'Garden', title: 'Third', number: 3 },
    ];
    assert.deepEqual(await numbers(), expected);
    // Reversible before and after use: a second 0055 numbers the same tasks the same way.
    await history.query(reverse);
    await history.query(forward);
    assert.deepEqual(await numbers(), expected);

    const insert = (projectId: string, title: string) => history!.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id)
      VALUES($1,$2,$3,$4,'human',$5) RETURNING number`, [randomUUID(), ws, projectId, title, user]);
    assert.equal((await insert(garden, 'Fourth')).rows[0].number, 4, 'a new task takes the next number');
    assert.equal((await insert(empty, 'A first task')).rows[0].number, 1, 'each project counts on its own');
    // A number given by the caller is replaced; a number is never changed afterwards.
    const chosen = await history.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id,number)
      VALUES($1,$2,$3,'Picked a number','human',$4,99) RETURNING number`, [randomUUID(), ws, garden, user]);
    assert.equal(chosen.rows[0].number, 5);
    await assert.rejects(history.query('UPDATE project_work_items SET number = 7 WHERE id = $1', [tasks[1]!.id]), /a task number never changes/);
    await history.query('UPDATE project_work_items SET title = $1 WHERE id = $2', ['First, renamed', tasks[1]!.id]);
    assert.equal((await history.query('SELECT number FROM project_work_items WHERE id = $1', [tasks[1]!.id])).rows[0].number, 1);
    await assert.rejects(history.query('UPDATE project_work_items SET project_id = $1 WHERE id = $2', [bikes, tasks[1]!.id]));
  } finally {
    guard?.cleanup();
    await history?.end();
    const dropFixture = { text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await admin.query(dropFixture);
    await admin.end();
  }
  guard?.assertNoEarlyErrors();
});

test('tasks created over the API get distinct consecutive numbers, also when created at once', async () => {
  const owner = await person('Task numbers owner');
  const ws = await workspace(owner, 'Numbers');
  const place = await project(owner, ws.id, 'Numbered tasks', 'restricted');
  const other = await project(owner, ws.id, 'Second project', 'restricted');
  const create = async (projectId: string, title: string) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/work`,
    { body: { title }, headers: { 'idempotency-key': randomUUID() } }), 201) as WorkItem;
  const first = await create(place.id, 'Order probes');
  assert.equal(first.number, 1);
  const burst = await Promise.all(Array.from({ length: 20 }, (_, index) => create(place.id, `Burst ${index}`)));
  assert.deepEqual(burst.map((item) => item.number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 2));
  assert.equal((await create(other.id, 'Elsewhere')).number, 1, 'each project counts on its own');
  const read = expectStatus(await owner.browser.request('GET', `/api/v1/work/${first.id}`), 200) as WorkItem;
  assert.equal(read.number, 1);
  const changed = expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${first.id}`,
    { body: { title: 'Order six probes', clientCommandId: randomUUID() }, headers: { 'if-match': `"${read.version}"` } }), 200) as WorkItem;
  assert.equal(changed.number, 1, 'a change keeps the number');
});
