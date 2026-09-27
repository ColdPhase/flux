import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { Conversation, ConversationMessage, Material, MaterialVersion, Page, Project, Workspace } from '@flux/contracts';
import { Browser, register, uniqueEmail, type ClientResponse } from './support/http.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());
const password = 'correct horse battery staple';

interface Person { id: string; email: string; browser: Browser }
async function person(label: string): Promise<Person> {
  const email = uniqueEmail(label);
  const { browser } = await register(email, password, label);
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200);
  return { id: (me.json as { user: { id: string } }).user.id, email, browser };
}
function expect(response: ClientResponse, status: number, label = 'request') {
  assert.equal(response.status, status, `${label}: ${response.text}`);
  return response.json;
}

describe('project capture and inline conversation', () => {
  let owner: Person;
  let partner: Person;
  let outsider: Person;
  let ws: Workspace;
  let project: Project;

  before(async () => {
    [owner, partner, outsider] = await Promise.all(['capture-owner', 'capture-partner', 'capture-outsider'].map(person));
    ws = expect(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Lamp ideas' } }), 201) as Workspace;
    expect(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`,
      { body: { email: partner.email, role: 'member' } }), 201);
    project = expect(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
      { body: { name: 'Lamp', visibility: 'restricted' } }), 201) as Project;
    expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'human', id: partner.id }, role: 'contributor' } }), 201);
  });

  test('private draft remains private; selected redacted text becomes a versioned project material', async () => {
    const draft = expect(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/drafts`,
      { body: { title: 'private thought', body: 'personal address; camera privacy', projectId: project.id } }), 201) as { id: string; version: number };
    expect(await partner.browser.request('GET', `/api/v1/drafts/${draft.id}`), 404);
    const created = expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Camera option', body: 'Camera privacy', sourceDraftId: draft.id, sourceDraftVersion: draft.version } }), 201) as Material;
    assert.equal(created.version, 1);
    assert.deepEqual(created.sourceDraft, { id: draft.id, version: draft.version });
    const partnerView = expect(await partner.browser.request('GET', `/api/v1/materials/${created.materialId}`), 200) as Material;
    assert.equal(partnerView.body, 'Camera privacy');
    assert.equal(partnerView.sourceDraft, null);
    assert.equal(JSON.stringify(partnerView).includes('personal address'), false);
    expect(await outsider.browser.request('GET', `/api/v1/materials/${created.materialId}`), 404);
    expect(await partner.browser.request('POST', `/api/v1/projects/${project.id}/materials`, { body: {
      clientMutationId: randomUUID(), title: 'Cannot publish someone else draft', body: 'copy',
      sourceDraftId: draft.id, sourceDraftVersion: draft.version,
    } }), 404);
    const editKey = randomUUID();
    const edit = { clientMutationId: editKey, expectedVersion: 1, body: 'Camera fails in low light' };
    const v2 = expect(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: edit }), 200) as Material;
    assert.equal(v2.version, 2);
    const repeated = expect(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: edit }), 200) as Material;
    assert.equal(repeated.version, 2);
    assert.equal(repeated.body, v2.body);
    expect(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: { ...edit, body: 'reused key for other content' } }), 409);
    expect(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'stale overwrite' } }), 409);
    const v3 = expect(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 2, body: 'Sensor alternative' } }), 200) as Material;
    assert.equal(v3.version, 3);
    const lateRetry = expect(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: edit }), 200) as Material;
    assert.equal(lateRetry.version, 2, 'late retry returns original committed revision');
    assert.equal((expect(await owner.browser.request('GET', `/api/v1/materials/${created.materialId}`), 200) as Material).version, 3);
    const old = expect(await partner.browser.request('GET', `/api/v1/materials/${created.materialId}/versions/1`), 200) as MaterialVersion;
    assert.equal(old.body, 'Camera privacy');
    const stored = await pool.query('SELECT version, body FROM project_material_versions WHERE material_id = $1 ORDER BY version', [created.materialId]);
    assert.deepEqual(stored.rows.map((row) => [row.version, row.body]),
      [[1, 'Camera privacy'], [2, 'Camera fails in low light'], [3, 'Sensor alternative']]);
    const snapshot = await pool.query('SELECT version, body FROM draft_versions WHERE draft_id = $1', [draft.id]);
    assert.equal(snapshot.rows[0].body, 'personal address; camera privacy');
  });

  test('two people send inline, retry safely, and keep a historical material citation', async () => {
    const key = randomUUID();
    const command = { body: 'Could a camera sense the gesture?', clientMessageId: key };
    const thread = expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`, { body: command }), 201) as Conversation;
    assert.equal(thread.messages[0]?.sequence, 1);
    assert.equal(thread.audience.projectId, project.id);
    const retry = expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`, { body: command }), 201) as Conversation;
    assert.equal(retry.id, thread.id);
    expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`,
      { body: { ...command, body: 'different send' } }), 409);
    const item = expect(await partner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Experiment', body: 'Low light test' } }), 201) as Material;
    const secondProject = expect(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
      { body: { name: 'Unrelated private project', visibility: 'restricted' } }), 201) as Project;
    const foreign = expect(await owner.browser.request('POST', `/api/v1/projects/${secondProject.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Other project', body: 'Separate audience' } }), 201) as Material;
    expect(await owner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: {
      body: 'Bad cross-project citation', clientMessageId: randomUUID(),
      source: { materialId: foreign.materialId, version: 1 },
    } }), 404);
    const replyCommand = { body: 'Test in a dim room', clientMessageId: randomUUID(),
      source: { materialId: item.materialId, version: 1 } };
    const first = expect(await partner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
      { body: replyCommand }), 201) as ConversationMessage;
    const replay = expect(await partner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
      { body: replyCommand }), 201) as ConversationMessage;
    assert.equal(replay.id, first.id);
    const concurrent = await Promise.all(Array.from({ length: 4 }, (_, i) => owner.browser.request('POST',
      `/api/v1/conversations/${thread.id}/messages`, { body: { body: `note ${i}`, clientMessageId: randomUUID() } })));
    concurrent.forEach((response) => expect(response, 201));
    expect(await partner.browser.request('PATCH', `/api/v1/materials/${item.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Negative: low light failed' } }), 200);
    const loaded = expect(await partner.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation;
    assert.deepEqual(loaded.messages.map((m) => m.sequence), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(loaded.messages[1]?.source, { materialId: item.materialId, version: 1 });
    assert.deepEqual(loaded.messages.map((m) => m.authorId), [owner.id, partner.id, owner.id, owner.id, owner.id, owner.id]);
    const newest = expect(await partner.browser.request('GET', `/api/v1/conversations/${thread.id}?limit=2`), 200) as Conversation;
    assert.deepEqual(newest.messages.map((m) => m.sequence), [5, 6]);
    assert.deepEqual(newest.messagePage, { hasMoreBefore: true, nextBeforeSequence: 5, limit: 2 });
    const middle = expect(await partner.browser.request('GET',
      `/api/v1/conversations/${thread.id}?limit=2&beforeSequence=${newest.messagePage.nextBeforeSequence}`), 200) as Conversation;
    assert.deepEqual(middle.messages.map((m) => m.sequence), [3, 4]);
    const oldest = expect(await partner.browser.request('GET',
      `/api/v1/conversations/${thread.id}?limit=2&beforeSequence=${middle.messagePage.nextBeforeSequence}`), 200) as Conversation;
    assert.deepEqual(oldest.messages.map((m) => m.sequence), [1, 2]);
    assert.equal(oldest.messagePage.hasMoreBefore, false);
    expect(await partner.browser.request('GET', `/api/v1/conversations/${thread.id}?limit=101`), 400);
    const stored = await pool.query('SELECT count(*)::int AS count FROM project_messages WHERE conversation_id = $1', [thread.id]);
    assert.equal(stored.rows[0].count, 6);
    const listed = expect(await partner.browser.request('GET', `/api/v1/projects/${project.id}/conversations?limit=10`), 200) as Page<Conversation>;
    assert.equal(listed.total >= 1, true);
    assert.equal(listed.items.some((row) => row.id === thread.id), true);
  });

  test('material publication retry and access revocation never expose cached project content', async () => {
    const key = randomUUID();
    const command = { clientMutationId: key, title: 'Sensor', url: 'https://example.org/sensor' };
    const first = expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`, { body: command }), 201) as Material;
    const same = expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`, { body: command }), 201) as Material;
    assert.equal(same.materialId, first.materialId);
    expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { ...command, title: 'Changed' } }), 409);
    const thread = expect(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`,
      { body: { body: 'Sensor idea', clientMessageId: randomUUID(), source: { materialId: first.materialId, version: 1 } } }), 201) as Conversation;
    const grants = expect(await owner.browser.request('GET', `/api/v1/projects/${project.id}/grants`), 200) as { id: string; principal: { id: string } }[];
    const partnerGrant = grants.find((grant) => grant.principal.id === partner.id);
    assert.ok(partnerGrant);
    expect(await owner.browser.request('DELETE', `/api/v1/projects/${project.id}/grants/${partnerGrant.id}`), 204);
    for (const path of [`/api/v1/projects/${project.id}/conversations`, `/api/v1/projects/${project.id}/materials`,
      `/api/v1/conversations/${thread.id}`, `/api/v1/materials/${first.materialId}`, `/api/v1/materials/${first.materialId}/versions/1`]) {
      expect(await partner.browser.request('GET', path), 404, path);
    }
    expect(await partner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
      { body: { body: 'after revoke', clientMessageId: randomUUID() } }), 404);
    expect(await partner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { ...command, clientMutationId: randomUUID() } }), 404);
  });
});
