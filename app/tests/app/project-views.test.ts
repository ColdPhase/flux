import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { Project, ProjectGrant, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, workspace, type Person } from './support/people.js';

// Spaces (F-037, #874): every new space starts the same way, with Conversation, Tasks, Map and Wiki, and no template or
// goal; its creator is its first space admin and nobody else is in it until they are added. Optional views (#351) can
// still be added once.

describe('new spaces and their views over HTTP', () => {
  let owner: Person;
  let writer: Person;
  let reader: Person;
  let ws: Workspace;

  const create = (actor: Person, body: Record<string, unknown>) => actor.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body, headers: { 'idempotency-key': crypto.randomUUID() } });
  const add = (actor: Person, projectId: string, view: unknown) => actor.browser.request('POST', `/api/v1/projects/${projectId}/views`, { body: { view }, headers: { 'idempotency-key': crypto.randomUUID() } });

  before(async () => {
    [owner, writer, reader] = await Promise.all(['owner', 'writer', 'reader'].map(person));
    ws = await workspace(owner, 'Gardens');
    await addMember(owner, ws.id, writer, 'member');
    await addMember(owner, ws.id, reader, 'member');
  });

  test('a new space starts with Map and Wiki, has no template and no goal, and is closed to others by default', async () => {
    const herbs = expectStatus(await create(owner, { name: 'Herbs' }), 201) as Project;
    assert.equal(herbs.visibility, 'restricted');
    assert.deepEqual(herbs.views, ['map', 'docs']);
    assert.equal('goal' in herbs, false);
    // There are no templates: the field is dropped like any unknown one, and the space starts the same way.
    assert.deepEqual((expectStatus(await create(owner, { name: 'Templated', template: 'research' }), 201) as Project).views, ['map', 'docs']);
    // A member who was not added does not see it, not even its name.
    expectStatus(await reader.browser.request('GET', `/api/v1/projects/${herbs.id}`), 404);
    const listed = expectStatus(await reader.browser.request('GET', `/api/v1/workspaces/${ws.id}/projects`), 200) as { items: Project[] };
    assert.equal(listed.items.some((item) => item.id === herbs.id), false);
  });

  test('a member starts a space and is its admin: the creator holds the one manager grant', async () => {
    const own = expectStatus(await create(writer, { name: 'Writer’s space' }), 201) as Project;
    assert.equal(own.access, 'manager');
    const grants = expectStatus(await writer.browser.request('GET', `/api/v1/projects/${own.id}/grants`), 200) as ProjectGrant[];
    assert.deepEqual(grants.map((item) => [item.principal.kind, item.principal.id, item.role]), [['human', writer.id, 'manager']]);
    // A space admin adds people as members or admins; a member does not change the people.
    await grant(writer, own.id, reader, 'contributor');
    assert.equal((expectStatus(await reader.browser.request('GET', `/api/v1/projects/${own.id}`), 200) as Project).access, 'contributor');
    expectStatus(await reader.browser.request('GET', `/api/v1/projects/${own.id}/grants`), 403);
    await grant(writer, own.id, reader, 'manager');
    assert.equal((expectStatus(await reader.browser.request('GET', `/api/v1/projects/${own.id}`), 200) as Project).access, 'manager');
  });

  test('a space starts with its Map and Wiki, adding one again changes nothing, and Agents or any other view is refused', async () => {
    const created = expectStatus(await create(owner, { name: 'Plan' }), 201) as Project;
    await grant(owner, created.id, writer, 'contributor');
    assert.deepEqual(created.views, ['map', 'docs']);
    const again = expectStatus(await add(writer, created.id, 'docs'), 200) as Project;
    assert.equal(again.version, created.version, 'adding a view it has changes nothing');
    expectStatus(await add(owner, created.id, 'tasks'), 400);
    expectStatus(await add(owner, created.id, 'agents'), 400); // There is no Agents view (F-026).
  });

  test('the views column is required and starts empty for new rows', async () => {
    const columns = await pool.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'views'");
    assert.equal(columns.rows[0]?.is_nullable, 'NO');
    assert.match(String(columns.rows[0]?.column_default), /'\{\}'/);
  });
});
