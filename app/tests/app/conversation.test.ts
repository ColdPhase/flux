import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, ConversationMessage, Decision, DecisionDiscussion, Material, MaterialVersion, ObjectNotice, Page, Project, SearchResponse, TaskCreationNotice,
  TaskDiscussion, WorkItem, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, removeMember, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';

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

  test('a text becomes a versioned project material; its readers are the project\'s', async () => {
    const created = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Camera option', body: 'Camera privacy' } }), 201) as Material;
    assert.equal(created.version, 1);
    const partnerView = expectStatus(await partner.browser.request('GET', `/api/v1/materials/${created.materialId}`), 200) as Material;
    assert.equal(partnerView.body, 'Camera privacy');
    expectStatus(await outsider.browser.request('GET', `/api/v1/materials/${created.materialId}`), 404);
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

  test('someone removed from the company is "Name (removed)" in messages, threads, discussions, notices and Search, until Restore (#1424, 2026-11-17)', async () => {
    // Founder decision (Hubert, 2026-11-17, #1424; personas-37 P3-3): one removed person read "Former member" in a task's discussion and a
    // decision's, "Former member" in the thread opened from Search and "Stefan Kowal" (no mark) in Search's list, beside "Stefan Kowal
    // (removed)" on the task. Their name is already in the space's history, so its readers see it with the mark everywhere.
    const stefan = await person('Stefan Kowal');
    await pool.query('UPDATE auth_users SET name = $1 WHERE id = $2', ['Stefan Kowal', stefan.id]);
    await addMember(owner, ws.id, stefan, 'member');
    await grant(owner, project.id, stefan, 'contributor');
    const word = `millday${randomUUID().slice(0, 6)}`;
    const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/conversations`,
      { body: { body: 'When does the mill deliver?', clientMessageId: randomUUID() } }), 201) as Conversation;
    expectStatus(await stefan.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: { body: `I called the mill, they deliver on Tuesdays ${word}.`, clientMessageId: randomUUID() } }), 201);
    const task = expectStatus(await stefan.browser.request('POST', `/api/v1/projects/${project.id}/work`, { body: { title: 'Call the mill' } }), 201) as WorkItem;
    expectStatus(await stefan.browser.request('POST', `/api/v1/work/${task.id}/discussion`, { body: { body: 'They deliver on Tuesdays.', clientMessageId: randomUUID() } }), 201);
    const decision = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/decisions`, { body: { title: 'Bread prices go up', rationale: 'Flour costs more.' } }), 201) as Decision;
    expectStatus(await stefan.browser.request('POST', `/api/v1/decisions/${decision.id}/discussion`, { body: { body: 'Fine for me, I tell the café.', clientMessageId: randomUUID() } }), 201);
    const stefans = await stefan.browser.request('POST', `/api/v1/projects/${project.id}/decisions`, { body: { title: 'Open on Sundays', rationale: 'People walk by.' } });
    const proposed = expectStatus(stefans, 201) as Decision;
    const found = await waitFor(async () => ((expectStatus(await owner.browser.request('GET', `/api/v1/search?q=${word}`), 200) as SearchResponse).items.find((item) => item.kind === 'message')), 'the message in Search');
    assert.equal(found.author, 'Stefan Kowal');
    assert.equal(found.mine, undefined, 'not the reader\'s');

    const names = async (reader: Person) => {
      const read = expectStatus(await reader.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation;
      const discussion = expectStatus(await reader.browser.request('GET', `/api/v1/work/${task.id}/discussion`), 200) as TaskDiscussion;
      const decided = expectStatus(await reader.browser.request('GET', `/api/v1/decisions/${decision.id}/discussion`), 200) as DecisionDiscussion;
      const notices = (expectStatus(await reader.browser.request('GET', `/api/v1/projects/${project.id}/task-notices`), 200) as Page<TaskCreationNotice>).items;
      const objects = (expectStatus(await reader.browser.request('GET', `/api/v1/projects/${project.id}/object-notices`), 200) as Page<ObjectNotice>).items;
      const search = (expectStatus(await reader.browser.request('GET', `/api/v1/search?q=${word}`), 200) as SearchResponse).items.find((item) => item.kind === 'message');
      const by = (messages: readonly ConversationMessage[]) => messages.find((message) => message.authorId === stefan.id);
      return {
        thread: by(read.messages)?.removedAuthorName ?? null, task: by(discussion.messages.length ? discussion.messages : [discussion.root!])?.removedAuthorName ?? null,
        decision: by(decided.messages)?.removedAuthorName ?? null,
        notice: notices.find((notice) => notice.workId === task.id)?.createdBy.name, proposed: objects.find((notice) => notice.decisionId === proposed.id)?.by.name,
        proposedBy: (expectStatus(await reader.browser.request('GET', `/api/v1/decisions/${proposed.id}`), 200) as Decision).proposedBy.name,
        search: search?.author,
      };
    };
    assert.deepEqual(await names(owner), { thread: null, task: null, decision: null, notice: 'Stefan Kowal', proposed: 'Stefan Kowal', proposedBy: 'Stefan Kowal', search: 'Stefan Kowal' });
    await removeMember(owner, ws.id, stefan);
    const removed = { thread: 'Stefan Kowal', task: 'Stefan Kowal', decision: 'Stefan Kowal', notice: 'Stefan Kowal (removed)', proposed: 'Stefan Kowal (removed)',
      proposedBy: 'Stefan Kowal (removed)', search: 'Stefan Kowal (removed)' };
    // Every reader of the space, the owner and a member alike; the web shows the message names as "Stefan Kowal (removed)" (`removedName`).
    assert.deepEqual(await names(owner), removed);
    assert.deepEqual(await names(partner), removed);
    // Someone who cannot read the space reads none of it, so is told no name.
    expectStatus(await outsider.browser.request('GET', `/api/v1/conversations/${thread.id}`), 404);
    // Restore takes the mark off.
    expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/removed-people/${stefan.id}/restore`, { body: {} }), 201);
    assert.deepEqual(await names(owner), { thread: null, task: null, decision: null, notice: 'Stefan Kowal', proposed: 'Stefan Kowal', proposedBy: 'Stefan Kowal', search: 'Stefan Kowal' });
  });

  test('Search marks what the reader wrote, and a person result that is the reader, so the row says "(you)" (personas-37 P3-5)', async () => {
    const ana = await person('Ana Costa');
    await addMember(owner, ws.id, ana, 'member');
    await grant(owner, project.id, ana, 'contributor');
    const word = `ownword${randomUUID().slice(0, 6)}`;
    expectStatus(await ana.browser.request('POST', `/api/v1/projects/${project.id}/conversations`, { body: { body: `My own note ${word}`, clientMessageId: randomUUID() } }), 201);
    const mine = await waitFor(async () => ((expectStatus(await ana.browser.request('GET', `/api/v1/search?q=${word}`), 200) as SearchResponse).items.find((item) => item.kind === 'message')), 'the note in Search');
    assert.equal(mine.author, 'Ana Costa');
    assert.equal(mine.mine, true);
    const theirs = (expectStatus(await owner.browser.request('GET', `/api/v1/search?q=${word}`), 200) as SearchResponse).items.find((item) => item.kind === 'message');
    assert.equal(theirs?.mine, undefined, 'another reader did not write it');
    const person_ = (reader: Person) => async () => (expectStatus(await reader.browser.request('GET', `/api/v1/search?q=${encodeURIComponent('Ana Costa')}`), 200) as SearchResponse).items
      .find((item) => item.kind === 'person' && item.target.type === 'person' && item.target.userId === ana.id);
    assert.equal((await waitFor(person_(ana), 'Ana among People')).mine, true, 'the reader among People');
    assert.equal((await waitFor(person_(owner), 'Ana among People for the owner')).mine, undefined);
  });
});
