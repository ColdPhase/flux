import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { Project, ProjectGrant, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, workspace, type Person } from './support/people.js';

// Spaces (F-037, #874): every new space starts the same way and shows Conversation, Tasks, Map and Wiki, with no template, no
// goal and no views stored on the server (#1043); its creator is its first space admin and nobody else is in it until they
// are added.

describe('new spaces over HTTP', () => {
  let owner: Person;
  let writer: Person;
  let reader: Person;
  let ws: Workspace;

  const create = (actor: Person, body: Record<string, unknown>) => actor.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body, headers: { 'idempotency-key': crypto.randomUUID() } });

  before(async () => {
    [owner, writer, reader] = await Promise.all(['owner', 'writer', 'reader'].map(person));
    ws = await workspace(owner, 'Gardens');
    await addMember(owner, ws.id, writer, 'member');
    await addMember(owner, ws.id, reader, 'member');
  });

  test('a new space has no views, template or goal, and is closed to others by default', async () => {
    const herbs = expectStatus(await create(owner, { name: 'Herbs' }), 201) as Project;
    assert.equal(herbs.visibility, 'restricted');
    assert.equal('goal' in herbs, false);
    assert.equal('views' in herbs, false, 'every space shows the same four views; the server stores none');
    // There are no templates: the field is dropped like any unknown one, and the space starts the same way.
    assert.equal('views' in (expectStatus(await create(owner, { name: 'Templated', template: 'research' }), 201) as Project), false);
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

  test('there is no route to add a view, and the projects table has no views column', async () => {
    const created = expectStatus(await create(owner, { name: 'Plan' }), 201) as Project;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${created.id}/views`, { body: { view: 'docs' }, headers: { 'idempotency-key': crypto.randomUUID() } }), 404);
    assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'views'")).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM events WHERE kind = 'project.view_added.v1'")).rowCount, 0);
  });
});
