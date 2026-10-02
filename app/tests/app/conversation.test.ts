import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, ConversationMessage, Material, MaterialVersion, Page, Project, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { expectStatus, person, type Person } from './support/people.js';


describe('project capture and inline conversation', () => {
  let owner: Person;
  let partner: Person;
  let outsider: Person;
  let ws: Workspace;
  let project: Project;

  before(async () => {
    [owner, partner, outsider] = await Promise.all(['capture-owner', 'capture-partner', 'capture-outsider'].map(person));
    ws = expectStatus(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Lamp ideas' } }), 201) as Workspace;
    expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`,
      { body: { email: partner.email, role: 'member' } }), 201);
    project = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
      { body: { name: 'Lamp', visibility: 'restricted' } }), 201) as Project;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'human', id: partner.id }, role: 'contributor' } }), 201);
  });

  test('private draft remains private; selected redacted text becomes a versioned project material', async () => {
    const draft = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/drafts`,
      { body: { title: 'private thought', body: 'personal address; camera privacy', projectId: project.id } }), 201) as { id: string; version: number };
    expectStatus(await partner.browser.request('GET', `/api/v1/drafts/${draft.id}`), 404);
    const created = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Camera option', body: 'Camera privacy', sourceDraftId: draft.id, sourceDraftVersion: draft.version } }), 201) as Material;
    assert.equal(created.version, 1);
    assert.deepEqual(created.sourceDraft, { id: draft.id, version: draft.version });
    const partnerView = expectStatus(await partner.browser.request('GET', `/api/v1/materials/${created.materialId}`), 200) as Material;
    assert.equal(partnerView.body, 'Camera privacy');
    assert.equal(partnerView.sourceDraft, null);
    assert.equal(JSON.stringify(partnerView).includes('personal address'), false);
    expectStatus(await outsider.browser.request('GET', `/api/v1/materials/${created.materialId}`), 404);
    expectStatus(await partner.browser.request('POST', `/api/v1/projects/${project.id}/materials`, { body: {
      clientMutationId: randomUUID(), title: 'Cannot publish someone else draft', body: 'copy',
      sourceDraftId: draft.id, sourceDraftVersion: draft.version,
    } }), 404);
    const editKey = randomUUID();
    const edit = { clientMutationId: editKey, expectedVersion: 1, body: 'Camera fails in low light' };
    const v2 = expectStatus(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: edit }), 200) as Material;
    assert.equal(v2.version, 2);
    const repeated = expectStatus(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: edit }), 200) as Material;
    assert.equal(repeated.version, 2);
    assert.equal(repeated.body, v2.body);
    expectStatus(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: { ...edit, body: 'reused key for other content' } }), 409);
    expectStatus(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'stale overwrite' } }), 409);
    const v3 = expectStatus(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 2, body: 'Sensor alternative' } }), 200) as Material;
    assert.equal(v3.version, 3);
    const lateRetry = expectStatus(await owner.browser.request('PATCH', `/api/v1/materials/${created.materialId}`,
      { body: edit }), 200) as Material;
    assert.equal(lateRetry.version, 2, 'late retry returns original committed revision');
    assert.equal((expectStatus(await owner.browser.request('GET', `/api/v1/materials/${created.materialId}`), 200) as Material).version, 3);
    const old = expectStatus(await partner.browser.request('GET', `/api/v1/materials/${created.materialId}/versions/1`), 200) as MaterialVersion;
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
    const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`, { body: command }), 201) as Conversation;
    assert.equal(thread.messages[0]?.sequence, 1);
    assert.equal(thread.audience.projectId, project.id);
    const retry = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`, { body: command }), 201) as Conversation;
    assert.equal(retry.id, thread.id);
    expectStatus(await owner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
      { body: command }), 409, 'an opening key cannot impersonate a later reply');
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`,
      { body: { ...command, body: 'different send' } }), 409);
    const item = expectStatus(await partner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Experiment', body: 'Low light test' } }), 201) as Material;
    const secondProject = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
      { body: { name: 'Unrelated private project', visibility: 'restricted' } }), 201) as Project;
    const foreign = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${secondProject.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Other project', body: 'Separate audience' } }), 201) as Material;
    expectStatus(await owner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: {
      body: 'Bad cross-project citation', clientMessageId: randomUUID(),
      source: { materialId: foreign.materialId, version: 1 },
    } }), 404);
    const replyCommand = { body: 'Test in a dim room', clientMessageId: randomUUID(),
      source: { materialId: item.materialId, version: 1 } };
    const first = expectStatus(await partner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
      { body: replyCommand }), 201) as ConversationMessage;
    const replay = expectStatus(await partner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
      { body: replyCommand }), 201) as ConversationMessage;
    assert.equal(replay.id, first.id);
    expectStatus(await partner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`,
      { body: replyCommand }), 409, 'a reply key cannot impersonate a conversation opening');
    const concurrent = await Promise.all(Array.from({ length: 4 }, (_, i) => owner.browser.request('POST',
      `/api/v1/conversations/${thread.id}/messages`, { body: { body: `note ${i}`, clientMessageId: randomUUID() } })));
    concurrent.forEach((response) => expectStatus(response, 201));
    expectStatus(await partner.browser.request('PATCH', `/api/v1/materials/${item.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Negative: low light failed' } }), 200);
    const loaded = expectStatus(await partner.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation;
    assert.equal(loaded.firstMessageBody, 'Could a camera sense the gesture?');
    assert.deepEqual(loaded.messages.map((m) => m.sequence), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(loaded.messages[1]?.source, { materialId: item.materialId, version: 1 });
    assert.deepEqual(loaded.messages.map((m) => m.authorId), [owner.id, partner.id, owner.id, owner.id, owner.id, owner.id]);
    const newest = expectStatus(await partner.browser.request('GET', `/api/v1/conversations/${thread.id}?limit=2`), 200) as Conversation;
    assert.equal(newest.firstMessageBody, 'Could a camera sense the gesture?');
    assert.deepEqual(newest.messages.map((m) => m.sequence), [5, 6]);
    assert.deepEqual(newest.messagePage, { hasMoreBefore: true, nextBeforeSequence: 5, limit: 2 });
    const middle = expectStatus(await partner.browser.request('GET',
      `/api/v1/conversations/${thread.id}?limit=2&beforeSequence=${newest.messagePage.nextBeforeSequence}`), 200) as Conversation;
    assert.deepEqual(middle.messages.map((m) => m.sequence), [3, 4]);
    const oldest = expectStatus(await partner.browser.request('GET',
      `/api/v1/conversations/${thread.id}?limit=2&beforeSequence=${middle.messagePage.nextBeforeSequence}`), 200) as Conversation;
    assert.deepEqual(oldest.messages.map((m) => m.sequence), [1, 2]);
    assert.equal(oldest.messagePage.hasMoreBefore, false);
    expectStatus(await partner.browser.request('GET', `/api/v1/conversations/${thread.id}?limit=101`), 400);
    const stored = await pool.query('SELECT count(*)::int AS count FROM project_messages WHERE conversation_id = $1', [thread.id]);
    assert.equal(stored.rows[0].count, 6);
    const listed = expectStatus(await partner.browser.request('GET', `/api/v1/projects/${project.id}/conversations?limit=10`), 200) as Page<Conversation>;
    assert.equal(listed.total >= 1, true);
    assert.equal(listed.items.some((row) => row.id === thread.id), true);
    assert.equal(listed.items.find((row) => row.id === thread.id)?.firstMessageBody, 'Could a camera sense the gesture?');
  });

  test('material publication retry and access revocation never expose cached project content', async () => {
    const key = randomUUID();
    const command = { clientMutationId: key, title: 'Sensor', url: 'https://example.org/sensor' };
    const first = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`, { body: command }), 201) as Material;
    const same = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`, { body: command }), 201) as Material;
    assert.equal(same.materialId, first.materialId);
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { ...command, title: 'Changed' } }), 409);
    const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`,
      { body: { body: 'Sensor idea', clientMessageId: randomUUID(), source: { materialId: first.materialId, version: 1 } } }), 201) as Conversation;
    const grants = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${project.id}/grants`), 200) as { id: string; principal: { id: string } }[];
    const partnerGrant = grants.find((grant) => grant.principal.id === partner.id);
    assert.ok(partnerGrant);
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${project.id}/grants/${partnerGrant.id}`), 204);
    for (const path of [`/api/v1/projects/${project.id}/conversations`, `/api/v1/projects/${project.id}/materials`,
      `/api/v1/conversations/${thread.id}`, `/api/v1/materials/${first.materialId}`, `/api/v1/materials/${first.materialId}/versions/1`]) {
      expectStatus(await partner.browser.request('GET', path), 404, path);
    }
    expectStatus(await partner.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`,
      { body: { body: 'after revoke', clientMessageId: randomUUID() } }), 404);
    expectStatus(await partner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { ...command, clientMutationId: randomUUID() } }), 404);
  });
});
