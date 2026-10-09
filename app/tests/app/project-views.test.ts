import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { Project, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, workspace, type Person } from './support/people.js';

// Project templates and optional views (#351, migration 0064): a template sets the views a project
// starts with, More adds one, and every project that existed before the migration has all of them.

describe('project templates and views over HTTP', () => {
  let owner: Person;
  let writer: Person;
  let reader: Person;
  let ws: Workspace;

  const create = (body: Record<string, unknown>) => owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body, headers: { 'idempotency-key': crypto.randomUUID() } });
  const add = (actor: Person, projectId: string, view: unknown) => actor.browser.request('POST', `/api/v1/projects/${projectId}/views`, { body: { view }, headers: { 'idempotency-key': crypto.randomUUID() } });

  before(async () => {
    [owner, writer, reader] = await Promise.all(['owner', 'writer', 'reader'].map(person));
    ws = await workspace(owner, 'Gardens');
    await addMember(owner, ws.id, writer, 'member');
    await addMember(owner, ws.id, reader, 'member');
  });

  test('a template sets the starting views and a project without one has every view', async () => {
    const research = expectStatus(await create({ name: 'Herbs', visibility: 'restricted', template: 'research' }), 201) as Project;
    assert.deepEqual(research.views, ['docs']);
    for (const template of ['build', 'event', 'blank']) {
      assert.deepEqual((expectStatus(await create({ name: `From ${template}`, template }), 201) as Project).views, []);
    }
    assert.deepEqual((expectStatus(await create({ name: 'No template' }), 201) as Project).views, ['map', 'docs', 'agents']);
    expectStatus(await create({ name: 'Bad', template: 'castle' }), 400);
  });

  test('a writer adds a view once, a reader cannot, and an unknown view is refused', async () => {
    const created = expectStatus(await create({ name: 'Plan', visibility: 'restricted', template: 'blank' }), 201) as Project;
    await grant(owner, created.id, writer, 'contributor');
    await grant(owner, created.id, reader, 'viewer');
    const first = expectStatus(await add(writer, created.id, 'map'), 200) as Project;
    assert.deepEqual(first.views, ['map']);
    assert.equal(first.version, created.version + 1);
    const again = expectStatus(await add(writer, created.id, 'map'), 200) as Project;
    assert.deepEqual(again.views, ['map']);
    assert.equal(again.version, first.version, 'adding a view it has changes nothing');
    expectStatus(await add(reader, created.id, 'agents'), 403);
    expectStatus(await add(owner, created.id, 'tasks'), 400);
    const read = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${created.id}`), 200) as Project;
    assert.deepEqual(read.views, ['map']);
  });

  test('concurrent additions of different views on one project both succeed and are kept once (no lock-upgrade deadlock)', async () => {
    for (let round = 0; round < 12; round += 1) {
      const created = expectStatus(await create({ name: `Race ${round}`, visibility: 'restricted', template: 'blank' }), 201) as Project;
      await grant(owner, created.id, writer, 'contributor');
      const results = await Promise.all([add(owner, created.id, 'map'), add(writer, created.id, 'docs'), add(owner, created.id, 'agents'), add(writer, created.id, 'map')]);
      for (const result of results) expectStatus(result, 200);
      const read = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${created.id}`), 200) as Project;
      assert.deepEqual([...read.views].sort(), ['agents', 'docs', 'map']);
      assert.equal(read.version, created.version + 3, 'one version per view actually added');
    }
  });

  test('the views column is required and starts empty for new rows (migration 0064 backfilled existing projects)', async () => {
    const columns = await pool.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'views'");
    assert.equal(columns.rows[0]?.is_nullable, 'NO');
    assert.match(String(columns.rows[0]?.column_default), /'\{\}'/);
  });
});
