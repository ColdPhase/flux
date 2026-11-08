import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileRows, notificationFactRows, personalRunRows, sql } from '@flux/db';
import { createFileUseCases } from '@flux/core';
import { REMOVED_BY_AUTHOR_BODY, type Conversation, type ConversationMessage, type Dm, type DmMessage, type DmThread, type Project, type SearchResponse, type StagedFile, type Workspace } from '@flux/contracts';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';
import { fileUnitOfWork } from '../../apps/server/src/files/adapters.js';
import { db, pool } from './support/db.js';
import { createSealed, lock, passphrase } from './support/encryption.js';
import { expectStatus, person, type Person } from './support/people.js';

// #1006: a person edits and deletes their own messages, in a space and in a direct message. Only the author; not the company's owner or admin,
// not another contributor, not an outsider, not through another conversation's id. An edit keeps the message in its place with "edited"; a delete
// leaves a marker and the words go: from search, from the notices that carried them, from the files and from the rows, encrypted spaces too.

const word = (label: string) => `${label}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const codeOf = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;
const filesDir = process.env.FLUX_TEST_FILES_DIR ?? '/data/files';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('an author edits and deletes their own message (#1006)', () => {
  let ada: Person; // owner of the company
  let max: Person; // admin: reaches every space and still changes no one's words
  let ben: Person; // contributor of the space
  let cy: Person; // contributor of the space
  let dan: Person; // member of the company, not added to the space
  let eve: Person; // another company
  let ws: Workspace;
  let lamp: Project;
  let other: Project; // ben is not in it

  before(async () => {
    [ada, max, ben, cy, dan, eve] = await Promise.all(['ed-ada', 'ed-max', 'ed-ben', 'ed-cy', 'ed-dan', 'ed-eve'].map(person));
    ws = expectStatus(await ada.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Edits' } }), 201) as Workspace;
    await workspaceOf(eve, 'Elsewhere');
    for (const [who, role] of [[max, 'admin'], [ben, 'member'], [cy, 'member'], [dan, 'member']] as const)
      expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { email: who.email, role } }), 201);
    lamp = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Lamp', visibility: 'restricted' } }), 201) as Project;
    other = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Other', visibility: 'restricted' } }), 201) as Project;
    for (const who of [ben, cy]) expectStatus(await ada.browser.request('POST', `/api/v1/projects/${lamp.id}/grants`, { body: { principal: { kind: 'human', id: who.id }, role: 'contributor' } }), 201);
  });

  const workspaceOf = async (who: Person, name: string) => expectStatus(await who.browser.request('POST', '/api/v1/workspaces', { body: { name } }), 201) as Workspace;
  const start = async (who: Person, projectId: string, body: string, extra: Record<string, unknown> = {}) =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID(), ...extra } }), 201) as Conversation;
  const reply = async (who: Person, conversationId: string, body: string) =>
    expectStatus(await who.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  const edit = (who: Person, conversationId: string, messageId: string, body: string) =>
    who.browser.request('PATCH', `/api/v1/conversations/${conversationId}/messages/${messageId}`, { body: { body } });
  const remove = (who: Person, conversationId: string, messageId: string) => who.browser.request('DELETE', `/api/v1/conversations/${conversationId}/messages/${messageId}`);
  const row = async (messageId: string) => (await pool.query('SELECT body, edited_at, removed_at, attachment_count FROM project_messages WHERE id = $1', [messageId])).rows[0] as
    { body: string; edited_at: Date | null; removed_at: Date | null; attachment_count: number };
  const events = async (objectId: string, kind: string) => (await pool.query('SELECT data FROM events WHERE object_id = $1 AND kind = $2 ORDER BY seq', [objectId, kind])).rows.map((r) => r.data as Record<string, unknown>);
  const found = async (who: Person, q: string) => ((expectStatus(await who.browser.request('GET', `/api/v1/search?q=${encodeURIComponent(q)}`), 200) as SearchResponse).items);
  const read = async (who: Person, conversationId: string) => (expectStatus(await who.browser.request('GET', `/api/v1/conversations/${conversationId}`), 200) as Conversation).messages;
  /** A notice as the generator stores it: about the message, with its words. */
  const notice = async (who: Person, project: string, url: string, body: string, title = 'Ben mentioned you in Lamp', reason = 'mention') => {
    const id = randomUUID();
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason, ai_origin) VALUES ($1, $2, $3, 'project', $4, $5, $6, $7, $8, false)`,
      [id, who.id, ws.id, project, title, body, url, reason]);
    return id;
  };
  const noticeExists = async (id: string) => (await pool.query('SELECT 1 FROM notifications WHERE id = $1', [id])).rowCount === 1;
  /** Every row of every table as text: the words are nowhere in it. */
  const databaseText = async () => {
    const tables = (await pool.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows;
    const parts: string[] = [];
    for (const { name } of tables) for (const r of (await pool.query(`SELECT row_to_json(t)::text AS row FROM ${JSON.stringify(name)} t`)).rows) parts.push(r.row as string);
    return parts.join('\n');
  };

  describe('Edit', () => {
    test('the author changes the words in place: edited, found by the new words only, one event with no words, a retry changes nothing', async () => {
      const before = word('before'); const after = word('after');
      const thread = await start(ben, lamp.id, before);
      const rootId = thread.messages[0]!.id;
      const sibling = await reply(cy, thread.id, 'a reply that stays');
      assert.equal((await found(ben, before)).length, 1, 'control: the first words are found');

      const edited = expectStatus(await edit(ben, thread.id, rootId, after), 200) as ConversationMessage;
      assert.equal(edited.body, after);
      assert.equal(edited.id, rootId);
      assert.equal(edited.sequence, 1, 'it keeps its place');
      assert.ok(edited.editedAt, 'it says it was edited');
      assert.equal(edited.removedAt, undefined);
      assert.deepEqual((await found(cy, before)).map((item) => item.kind), [], 'the first words are no longer found');
      assert.equal((await found(cy, after)).length, 1, 'the new words are');
      const stored = await row(rootId);
      assert.equal(stored.body, after, 'the earlier words are not kept');
      assert.ok(stored.edited_at && !stored.removed_at);
      const messages = await read(cy, thread.id);
      assert.deepEqual(messages.map((m) => [m.id, m.body]), [[rootId, after], [sibling.id, 'a reply that stays']]);
      assert.equal(messages[0]!.editedAt, edited.editedAt);

      const recorded = await events(lamp.id, 'project.message_edited.v1');
      const mine = recorded.filter((data) => data.messageId === rootId);
      assert.deepEqual(mine, [{ conversationId: thread.id, messageId: rootId }], 'one event: ids only, not the words');
      const again = expectStatus(await edit(ben, thread.id, rootId, after), 200) as ConversationMessage;
      assert.equal(again.editedAt, edited.editedAt, 'the same words again change nothing');
      assert.equal((await events(lamp.id, 'project.message_edited.v1')).filter((data) => data.messageId === rootId).length, 1, 'and record nothing');
    });

    test('a reply is edited too; the words are trimmed; an empty edit, a long one and a wrong shape are refused', async () => {
      const thread = await start(ben, lamp.id, 'first words');
      const mine = await reply(ben, thread.id, 'a reply');
      assert.equal((expectStatus(await edit(ben, thread.id, mine.id, '  padded  '), 200) as ConversationMessage).body, 'padded');
      assert.equal((await edit(ben, thread.id, mine.id, '   ')).status, 400, 'a message without files needs words');
      assert.equal((await edit(ben, thread.id, mine.id, 'x'.repeat(100_001))).status, 400);
      const extra = await ben.browser.request('PATCH', `/api/v1/conversations/${thread.id}/messages/${mine.id}`, { body: { body: 'padded', authorId: cy.id } });
      assert.equal((extra.json as ConversationMessage).authorId, ben.id, 'a field the command does not have is dropped, not obeyed');
      assert.equal((await ben.browser.request('PATCH', `/api/v1/conversations/${thread.id}/messages/${mine.id}`, { body: { text: 'ok' } })).status, 400);
      assert.equal((await edit(ben, thread.id, 'not-a-uuid', 'ok')).status, 400);
      assert.equal((await row(mine.id)).body, 'padded');
    });

    test('nobody edits a message that was deleted', async () => {
      const thread = await start(ben, lamp.id, word('gone'));
      expectStatus(await remove(ben, thread.id, thread.messages[0]!.id), 200);
      const refused = await edit(ben, thread.id, thread.messages[0]!.id, 'back again');
      assert.equal(refused.status, 409);
      assert.equal(codeOf(refused), 'MESSAGE_REMOVED');
      assert.equal((await row(thread.messages[0]!.id)).body, REMOVED_BY_AUTHOR_BODY);
    });
  });

  describe('Delete', () => {
    test('the words go and a marker stays in the place: replies, search, the notices that carried them, a retry and the event', async () => {
      const secret = word('secret'); const replied = word('replied');
      const thread = await start(ben, lamp.id, `${secret} opening`);
      const rootId = thread.messages[0]!.id;
      const answer = await reply(cy, thread.id, replied);
      await reply(ben, thread.id, 'I cite the opening');
      // The notice of this message and a reply notice that quotes the opening go; another conversation's stays.
      const mention = await notice(cy, lamp.id, `/projects/${lamp.id}/conversations/${thread.id}#message-${rootId}`, `${secret} opening`);
      const quoting = await notice(ben, lamp.id, `/projects/${lamp.id}/conversations/${thread.id}#message-${answer.id}`, replied, `Cy replied in “${secret} opening”`, 'reply');
      const unrelated = await notice(ben, lamp.id, `/projects/${lamp.id}/conversations/${randomUUID()}#message-${randomUUID()}`, 'another conversation', 'Cy replied in “other”', 'reply');
      assert.ok((await found(cy, secret)).length === 1);

      const removed = expectStatus(await remove(ben, thread.id, rootId), 200) as ConversationMessage;
      assert.equal(removed.body, REMOVED_BY_AUTHOR_BODY);
      assert.ok(removed.removedAt);
      assert.equal(removed.editedAt, undefined);
      assert.equal(removed.sequence, 1, 'it keeps its place');
      assert.deepEqual((await found(cy, secret)), [], 'it is not found');
      assert.deepEqual((await found(cy, REMOVED_BY_AUTHOR_BODY.split(' ')[0]!)).filter((item) => item.kind === 'message'), [], 'neither is its marker');
      assert.equal((await read(cy, thread.id)).map((m) => m.body).join('|'), `${REMOVED_BY_AUTHOR_BODY}|${replied}|I cite the opening`, 'the replies stay in order');
      assert.equal(await noticeExists(mention), false, 'the notice of this message is gone');
      assert.equal(await noticeExists(quoting), false, 'the reply notice that quoted the opening is gone');
      assert.equal(await noticeExists(unrelated), true, 'another conversation\'s notice stays');
      assert.ok(!(await databaseText()).includes(secret), 'the words are nowhere in the database');

      assert.equal((expectStatus(await remove(ben, thread.id, rootId), 200) as ConversationMessage).removedAt, removed.removedAt, 'deleting a deleted message answers the same');
      assert.deepEqual((await events(lamp.id, 'project.message_removed.v1')).filter((data) => data.messageId === rootId), [{ conversationId: thread.id, messageId: rootId }], 'one event');
    });

    test('the citations a message made go with it', async () => {
      const map = expectStatus(await ben.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'Lamp ideas', scope: 'project', projectId: lamp.id } }), 201) as { id: string };
      const idea = (expectStatus(await ben.browser.request('POST', `/api/v1/sketches/${map.id}/thoughts`, { body: { text: 'Vent on the north wall', x: 10, y: 10 } }), 201) as { thought: { id: string } }).thought;
      const thread = await start(ben, lamp.id, word('about the vent'));
      const citing = expectStatus(await ben.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: { body: 'see the idea', clientMessageId: randomUUID(), references: [{ kind: 'thought', id: idea.id }] } }), 201) as ConversationMessage;
      assert.equal(citing.references?.[0]?.state, 'available');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_references WHERE project_message_id = $1', [citing.id])).rows[0].n, 1);
      const removed = expectStatus(await remove(ben, thread.id, citing.id), 200) as ConversationMessage;
      assert.equal(removed.references, undefined, 'the marker cites nothing');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM message_references WHERE project_message_id = $1', [citing.id])).rows[0].n, 0);
      // The thought itself is not the message's: it stays on its map.
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM sketch_thoughts WHERE id = $1', [idea.id])).rows[0].n, 1);
    });

    test('its files go: the rows, and the bytes after the cleanup', async () => {
      const bytes = Buffer.from(`${word('bank')},statement\n`);
      const staged = await fetch(new URL(`/api/v1/projects/${lamp.id}/files?uploadId=${randomUUID()}&name=statement.csv`, ben.browser.base), {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: ben.browser.cookieHeader(), origin: ben.browser.defaultOrigin }, body: bytes });
      assert.equal(staged.status, 201);
      const file = await staged.json() as StagedFile;
      const thread = await start(ben, lamp.id, 'my statement', { attachmentIds: [file.id] });
      const messageId = thread.messages[0]!.id;
      const path = join(filesDir, 'attachments', 'objects', file.id.slice(0, 2), file.id);
      assert.deepEqual(await readFile(path), bytes, 'control: the bytes are stored');
      const removed = expectStatus(await remove(ben, thread.id, messageId), 200) as ConversationMessage;
      assert.equal(removed.files, undefined);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_files WHERE message_id = $1', [messageId])).rows[0].n, 0);
      assert.equal((await row(messageId)).attachment_count, 0);
      assert.ok((await fileRows(db).pendingGarbage(500)).includes(file.id), 'the bytes are queued for cleanup');
      await createFileUseCases(fileUnitOfWork(db), await diskFileStorage(filesDir)).cleanup();
      await assert.rejects(readFile(path), /ENOENT/, 'and removed from the volume');
    });

    test('a deleted message is not given to a model, and an edited one is given with its new words', async () => {
      const gone = word('modelgone'); const kept = word('modelkept'); const fixed = word('modelfixed');
      const thread = await start(ben, lamp.id, 'the opening');
      const removed = await reply(ben, thread.id, gone);
      const edited = await reply(cy, thread.id, kept);
      await reply(cy, thread.id, 'the last one');
      const bodies = async () => (await personalRunRows(db).messages(thread.id, 10)).map((m) => m.body);
      assert.deepEqual(await bodies(), ['the opening', gone, kept, 'the last one'], 'control: a model reads all of them');
      expectStatus(await remove(ben, thread.id, removed.id), 200);
      expectStatus(await edit(cy, thread.id, edited.id, fixed), 200);
      assert.deepEqual(await bodies(), ['the opening', fixed, 'the last one']);
      assert.deepEqual((await personalRunRows(db).messages(thread.id, 2)).map((m) => m.body), [fixed, 'the last one'], 'a deleted message does not take a place in the window');
    });

    test('a message that said "via Assistant" no longer names the agent once its words change or go; a delete also drops the digest of the sent words', async () => {
      const edited = await start(ben, lamp.id, word('assisted'));
      const removed = await start(ben, lamp.id, word('assisted again'));
      const fingerprint = async (id: string) => (await pool.query('SELECT request_fingerprint AS f FROM project_messages WHERE id = $1', [id])).rows[0].f as string;
      for (const thread of [edited, removed])
        await pool.query(`UPDATE project_messages SET via = 'Assistant' WHERE id = $1`, [thread.messages[0]!.id]);
      const sentFingerprint = await fingerprint(removed.messages[0]!.id);
      const editedFingerprint = await fingerprint(edited.messages[0]!.id);
      assert.equal((await read(cy, edited.id))[0]!.via, 'Assistant', 'control: the mark shows');
      const afterEdit = expectStatus(await edit(ben, edited.id, edited.messages[0]!.id, word('my own words')), 200) as ConversationMessage;
      assert.equal(afterEdit.via, undefined, 'the edited words are the person\'s');
      assert.equal((await read(cy, edited.id))[0]!.via, undefined);
      assert.equal(await fingerprint(edited.messages[0]!.id), editedFingerprint, 'an edit keeps the identity of the send, so a retry of it finds the message');
      const afterDelete = expectStatus(await remove(ben, removed.id, removed.messages[0]!.id), 200) as ConversationMessage;
      assert.equal(afterDelete.via, undefined);
      const kept = await fingerprint(removed.messages[0]!.id);
      assert.notEqual(kept, sentFingerprint, 'the digest of the sent words is gone');
      assert.match(kept, /^[a-f0-9]{64}$/);
    });

    test('a delete that arrives while the notices of the message are being made waits for them and then removes them', async () => {
      const thread = await start(ben, lamp.id, word('racing'));
      const messageId = thread.messages[0]!.id;
      const url = `/projects/${lamp.id}/conversations/${thread.id}#message-${messageId}`;
      const made = randomUUID();
      let deleting: ReturnType<typeof remove> | undefined;
      // The generator's batch: it reads the message, the author's Delete arrives, the batch writes its notice and commits.
      await db.transaction(async (tx) => {
        const facts = await notificationFactRows(tx).projectMessage(messageId);
        assert.ok(facts, 'the message is read');
        deleting = remove(ben, thread.id, messageId);
        await pause(600);
        assert.equal((await row(messageId)).removed_at, null, 'the delete waits for the batch');
        await tx.execute(sql`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason, ai_origin)
          VALUES (${made}, ${cy.id}, ${ws.id}, 'project', ${lamp.id}, 'Ben mentioned you in Lamp', ${facts.body}, ${url}, 'mention', false)`);
      });
      assert.equal((await deleting!).status, 200);
      assert.equal(await noticeExists(made), false, 'the notice made from the words is removed with them');
      assert.equal(await notificationFactRows(db).projectMessage(messageId), null, 'and a message that is removed tells no one anything');
    });
  });

  describe('only the author', () => {
    test('no other contributor, no company owner or admin, no outsider and no one signed out changes or deletes it; nothing changed', async () => {
      const words = word('mine');
      const thread = await start(ben, lamp.id, words);
      const id = thread.messages[0]!.id;
      for (const who of [cy, ada, max]) {
        const edited = await edit(who, thread.id, id, 'rewritten');
        assert.equal(edited.status, 403, `${who.email} may read it and may not change it`);
        assert.equal(codeOf(edited), 'MESSAGE_NOT_YOURS');
        const deleted = await remove(who, thread.id, id);
        assert.equal(deleted.status, 403);
        assert.equal(codeOf(deleted), 'MESSAGE_NOT_YOURS');
      }
      for (const who of [dan, eve]) {
        assert.equal((await edit(who, thread.id, id, 'rewritten')).status, 404, 'someone who cannot read the space learns nothing');
        assert.equal((await remove(who, thread.id, id)).status, 404);
      }
      const signedOut = await fetch(new URL(`/api/v1/conversations/${thread.id}/messages/${id}`, ben.browser.base), { method: 'DELETE', headers: { origin: ben.browser.defaultOrigin } });
      assert.equal(signedOut.status, 401);
      const stored = await row(id);
      assert.deepEqual([stored.body, stored.edited_at, stored.removed_at], [words, null, null]);
      for (const kind of ['project.message_edited.v1', 'project.message_removed.v1']) assert.equal((await events(lamp.id, kind)).filter((data) => data.messageId === id).length, 0);
    });

    test('an id from another conversation cannot ride on a conversation you may write to', async () => {
      const mineThread = await start(ben, lamp.id, 'ben writes here');
      const forbidden = await start(ada, other.id, word('private'));
      const victim = forbidden.messages[0]!.id;
      for (const run of [() => edit(ben, mineThread.id, victim, 'taken'), () => remove(ben, mineThread.id, victim)]) {
        assert.equal((await run()).status, 404, 'the message is not in that conversation');
      }
      // Nor can a contributor of both conversations use one conversation for another one's message.
      const theirs = await start(cy, lamp.id, 'cy writes here');
      assert.equal((await edit(ben, mineThread.id, theirs.messages[0]!.id, 'taken')).status, 404);
      assert.equal((await edit(ben, theirs.id, theirs.messages[0]!.id, 'taken')).status, 403);
      assert.match((await row(victim)).body, /^private/);
      assert.equal((await row(theirs.messages[0]!.id)).body, 'cy writes here');
    });

    test('a person who lost the space, or the company, changes nothing', async () => {
      const thread = await start(cy, lamp.id, 'cy before leaving');
      const id = thread.messages[0]!.id;
      const grants = expectStatus(await ada.browser.request('GET', `/api/v1/projects/${lamp.id}/grants`), 200) as { id: string; principal: { id: string } }[];
      expectStatus(await ada.browser.request('DELETE', `/api/v1/projects/${lamp.id}/grants/${grants.find((g) => g.principal.id === cy.id)!.id}`), 204);
      assert.equal((await edit(cy, thread.id, id, 'still mine?')).status, 404);
      assert.equal((await remove(cy, thread.id, id)).status, 404);
      expectStatus(await ada.browser.request('POST', `/api/v1/projects/${lamp.id}/grants`, { body: { principal: { kind: 'human', id: cy.id }, role: 'contributor' } }), 201);
      assert.equal((await row(id)).body, 'cy before leaving');
    });

    test('an agent\'s line and a task\'s record are not changed here; a deleted agent line is its owner\'s alone', async () => {
      const thread = await start(ben, lamp.id, 'opening');
      const agentId = randomUUID();
      await pool.query('INSERT INTO agents (id, workspace_id, name, owner_user_id, created_by) VALUES ($1, $2, $3, $4, $4)', [agentId, ws.id, 'Helper', ben.id]);
      const lineId = randomUUID();
      await pool.query(`INSERT INTO project_messages (id, workspace_id, project_id, conversation_id, author_agent_id, client_message_id, request_fingerprint, sequence, body)
        VALUES ($1, $2, $3, $4, $5, $6, 'test', 2, 'the agent says so')`, [lineId, ws.id, lamp.id, thread.id, agentId, randomUUID()]);
      await pool.query('UPDATE project_conversations SET next_sequence = 3 WHERE id = $1', [thread.id]);
      for (const who of [ben, ada]) {
        assert.equal((await edit(who, thread.id, lineId, 'my words')).status, 403, 'not even its owner, through this route');
        assert.equal((await remove(who, thread.id, lineId)).status, 403);
      }
      // A saved blocker is the task's record: refused with a reason, whoever wrote it.
      const blocker = randomUUID();
      await pool.query(`INSERT INTO project_messages (id, workspace_id, project_id, conversation_id, author_id, client_message_id, request_fingerprint, sequence, body, contribution_kind)
        VALUES ($1, $2, $3, $4, $5, $6, 'test', 3, 'blocked by the supplier', 'blocker')`, [blocker, ws.id, lamp.id, thread.id, ben.id, randomUUID()]);
      await pool.query('UPDATE project_conversations SET next_sequence = 4 WHERE id = $1', [thread.id]);
      const refused = await remove(ben, thread.id, blocker);
      assert.equal(refused.status, 409);
      assert.equal(codeOf(refused), 'MESSAGE_NOT_CHANGEABLE');
      assert.equal((await row(lineId)).body, 'the agent says so');
      assert.equal((await row(blocker)).body, 'blocked by the supplier');
    });
  });

  describe('a direct message', () => {
    let people: [Person, Person, Person];
    let dm: Dm;
    const send = async (who: Person, body: string) => expectStatus(await who.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as DmMessage;
    const dmEdit = (who: Person, id: string, body: string, dmId = dm.id) => who.browser.request('PATCH', `/api/v1/dms/${dmId}/messages/${id}`, { body: { body } });
    const dmRemove = (who: Person, id: string, dmId = dm.id) => who.browser.request('DELETE', `/api/v1/dms/${dmId}/messages/${id}`);
    const dmRow = async (id: string) => (await pool.query('SELECT body, edited_at, removed_at FROM dm_messages WHERE id = $1', [id])).rows[0] as { body: string; edited_at: Date | null; removed_at: Date | null };
    const thread = async (who: Person, rootId: string) => expectStatus(await who.browser.request('GET', `/api/v1/dms/${dm.id}/threads/${rootId}`), 200) as DmThread;

    before(async () => {
      people = [ben, cy, dan];
      dm = expectStatus(await ben.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [cy.id, dan.id], title: 'Lamp crew' } }), 201) as Dm;
    });

    test('the author edits a root and a reply; the words are found by the new ones only; the event carries no words', async () => {
      const before = word('dmbefore'); const after = word('dmafter');
      const root = await send(ben, before);
      const answer = expectStatus(await cy.browser.request('POST', `/api/v1/dms/${dm.id}/threads/${root.id}/replies`, { body: { body: 'a private reply', clientMessageId: randomUUID() } }), 201) as DmMessage;
      assert.equal((await found(cy, before)).length, 1);
      const edited = expectStatus(await dmEdit(ben, root.id, after), 200) as DmMessage;
      assert.deepEqual([edited.body, edited.sequence, edited.replyCount, edited.removedAt], [after, root.sequence, 1, undefined]);
      assert.ok(edited.editedAt);
      assert.deepEqual(await found(cy, before), []);
      assert.equal((await found(cy, after)).length, 1);
      const mine = expectStatus(await dmEdit(cy, answer.id, 'a better reply'), 200) as DmMessage;
      assert.equal(mine.threadRootId, root.id);
      assert.equal((await thread(dan, root.id)).replies[0]!.body, 'a better reply');
      const recorded = (await events(dm.id, 'dm.message_edited.v1')).filter((data) => data.messageId === root.id || data.messageId === answer.id);
      assert.deepEqual(recorded, [{ messageId: root.id }, { messageId: answer.id, rootId: root.id }]);
      assert.equal(((await dmEdit(ben, root.id, after)).json as DmMessage).editedAt, edited.editedAt, 'the same words again change nothing');
      assert.equal((await dmEdit(ben, root.id, '  ')).status, 400);
    });

    test('a delete leaves a marker; the replies stay; the words leave search, the notices and the database', async () => {
      const secret = word('dmsecret');
      const root = await send(ben, secret);
      expectStatus(await cy.browser.request('POST', `/api/v1/dms/${dm.id}/threads/${root.id}/replies`, { body: { body: 'still here', clientMessageId: randomUUID() } }), 201);
      const id = randomUUID();
      await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason, ai_origin) VALUES ($1, $2, $3, 'dm', $4, 'Ben sent you a message', $5, $6, 'dm', false)`,
        [id, cy.id, ws.id, dm.id, secret, `/dm/${dm.id}#message-${root.id}`]);
      const removed = expectStatus(await dmRemove(ben, root.id), 200) as DmMessage;
      assert.deepEqual([removed.body, removed.sequence, removed.replyCount], [REMOVED_BY_AUTHOR_BODY, root.sequence, 1]);
      assert.ok(removed.removedAt);
      assert.deepEqual(await found(cy, secret), []);
      assert.equal(await noticeExists(id), false);
      assert.equal((await thread(dan, root.id)).root.body, REMOVED_BY_AUTHOR_BODY);
      assert.equal((await thread(dan, root.id)).replies[0]!.body, 'still here');
      assert.ok(!(await databaseText()).includes(secret));
      assert.equal(((await dmRemove(ben, root.id)).json as DmMessage).removedAt, removed.removedAt, 'a retry answers the same');
      assert.equal((await dmEdit(ben, root.id, 'back')).status, 409);
      const list = expectStatus(await ben.browser.request('GET', `/api/v1/workspaces/${ws.id}/dms`), 200) as { items: { id: string; lastMessageBody: string | null }[] };
      assert.ok(!JSON.stringify(list).includes(secret), 'the list shows no trace of it either');
    });

    test('a send made under an Idempotency-Key leaves no stored answer with the words after an edit or a delete; "via" and the digest go as for a space', async () => {
      const first = word('dmkeyed'); const second = word('dmkeyedafter'); const third = word('dmkeyedgone');
      const keyed = async (body: string) => expectStatus(await ben.browser.request('POST', `/api/v1/dms/${dm.id}/messages`,
        { body: { body, clientMessageId: randomUUID() }, headers: { 'idempotency-key': randomUUID() } }), 201) as DmMessage;
      const stored = async (words: string) => (await pool.query(`SELECT 1 FROM idempotency_keys WHERE principal = $1 AND response_body::text LIKE $2`, [`human:${ben.id}`, `%${words}%`])).rowCount;
      const fingerprint = async (id: string) => (await pool.query('SELECT request_fingerprint AS f FROM dm_messages WHERE id = $1', [id])).rows[0].f as string;
      const one = await keyed(first);
      const two = await keyed(third);
      assert.equal(await stored(first), 1, 'control: the answer is stored with the words');
      await pool.query(`UPDATE dm_messages SET via = 'Assistant' WHERE id = ANY($1)`, [[one.id, two.id]]);
      const edited = expectStatus(await dmEdit(ben, one.id, second), 200) as DmMessage;
      assert.equal(edited.via, undefined, 'the edited words are the person\'s');
      assert.equal(await stored(first), 0, 'the words as sent are not kept in the stored answer');
      const sentFingerprint = await fingerprint(two.id);
      const removed = expectStatus(await dmRemove(ben, two.id), 200) as DmMessage;
      assert.equal(removed.via, undefined);
      assert.equal(await stored(third), 0, 'nor the deleted ones');
      assert.notEqual(await fingerprint(two.id), sentFingerprint, 'the digest of the sent words is gone');
      assert.match(await fingerprint(two.id), /^[a-f0-9]{64}$/);
    });

    test('a deleted direct message is not given to a model', async () => {
      const gone = word('dmmodelgone'); const kept = word('dmmodelkept');
      const first = await send(ben, gone);
      await send(cy, kept);
      const bodies = async () => (await personalRunRows(db).dmMessages(dm.id, 500)).map((m) => m.body).filter((body) => body === gone || body === kept || body === REMOVED_BY_AUTHOR_BODY);
      assert.deepEqual(await bodies(), [gone, kept], 'control: a model reads both');
      expectStatus(await dmRemove(ben, first.id), 200);
      assert.deepEqual(await bodies(), [kept], 'the deleted one, and its marker, are not read');
    });

    test('a delete that arrives while the notices of the message are being made waits for them and then removes them', async () => {
      const root = await send(ben, word('dmracing'));
      const made = randomUUID();
      let deleting: ReturnType<typeof dmRemove> | undefined;
      await db.transaction(async (tx) => {
        const facts = await notificationFactRows(tx).dmMessage(dm.id, root.id);
        assert.ok(facts, 'the message is read');
        deleting = dmRemove(ben, root.id);
        await pause(600);
        assert.equal((await dmRow(root.id)).removed_at, null, 'the delete waits for the batch');
        await tx.execute(sql`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason, ai_origin)
          VALUES (${made}, ${cy.id}, ${ws.id}, 'dm', ${dm.id}, 'Ben sent you a message', ${facts.body}, ${`/dm/${dm.id}#message-${root.id}`}, 'dm', false)`);
      });
      assert.equal((await deleting!).status, 200);
      assert.equal(await noticeExists(made), false, 'the notice made from the words is removed with them');
      assert.equal(await notificationFactRows(db).dmMessage(dm.id, root.id), null);
    });

    test('only the author: another participant, the company\'s owner and admin who are not in the DM, and an outsider change nothing', async () => {
      const root = await send(ben, word('dmmine'));
      const reply = expectStatus(await cy.browser.request('POST', `/api/v1/dms/${dm.id}/threads/${root.id}/replies`, { body: { body: word('cyreply'), clientMessageId: randomUUID() } }), 201) as DmMessage;
      for (const [who, id] of [[cy, root.id], [dan, root.id], [ben, reply.id], [dan, reply.id]] as const) {
        const edited = await dmEdit(who, id, 'rewritten');
        assert.equal(edited.status, 403, 'a participant reads it and may not change it');
        assert.equal(codeOf(edited), 'MESSAGE_NOT_YOURS');
        assert.equal((await dmRemove(who, id)).status, 403);
      }
      for (const who of [ada, max, eve]) {
        assert.equal((await dmEdit(who, root.id, 'rewritten')).status, 404, 'not a participant: the DM does not exist for them');
        assert.equal((await dmRemove(who, root.id)).status, 404);
      }
      // An id of another DM cannot ride on this one.
      const second = expectStatus(await ben.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [cy.id] } }), 201) as Dm;
      const there = expectStatus(await ben.browser.request('POST', `/api/v1/dms/${second.id}/messages`, { body: { body: word('elsewhere'), clientMessageId: randomUUID() } }), 201) as DmMessage;
      assert.equal((await dmEdit(dan, there.id, 'taken')).status, 404, 'dan is in this DM only');
      assert.equal((await dmRemove(ben, there.id)).status, 404, 'ben wrote it, but not in this DM');
      assert.equal((await dmEdit(ben, there.id, 'moved', second.id)).status, 200);
      assert.equal((await dmRow(root.id)).removed_at, null);
      assert.equal((await dmRow(reply.id)).edited_at, null);
      assert.equal(people.length, 3);
    });

    test('a person who left the DM changes nothing in it; a 1:1 whose other person left still lets its author delete', async () => {
      const group = expectStatus(await ben.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [cy.id, dan.id] } }), 201) as Dm;
      const line = expectStatus(await dan.browser.request('POST', `/api/v1/dms/${group.id}/messages`, { body: { body: word('dangone'), clientMessageId: randomUUID() } }), 201) as DmMessage;
      expectStatus(await dan.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 204);
      assert.equal((await dmEdit(dan, line.id, 'hello?', group.id)).status, 404);
      assert.equal((await dmRemove(dan, line.id, group.id)).status, 404);
      const pair = expectStatus(await ben.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [dan.id] } }), 201) as Dm;
      const mine = expectStatus(await ben.browser.request('POST', `/api/v1/dms/${pair.id}/messages`, { body: { body: word('bensaid'), clientMessageId: randomUUID() } }), 201) as DmMessage;
      expectStatus(await dan.browser.request('POST', `/api/v1/dms/${pair.id}/leave`), 204);
      expectStatus(await dmEdit(ben, mine.id, 'corrected', pair.id), 200);
      expectStatus(await dmRemove(ben, mine.id, pair.id), 200);
    });
  });

  describe('an encrypted workspace', () => {
    test('the words are sealed as they are changed, the old ones are not kept, the deleted ones are nowhere; a locked workspace refuses', async () => {
      const password = passphrase();
      const sealed = await createSealed(ada, 'Sealed edits', password);
      const sealedId = sealed.workspace.id;
      expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${sealedId}/members`, { body: { email: ben.email, role: 'member' } }), 201);
      const space = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${sealedId}/projects`, { body: { name: 'Vault', visibility: 'workspace' } }), 201) as Project;
      const first = word('sealfirst'); const second = word('sealsecond'); const gone = word('sealgone'); const dmWords = word('sealdm');
      const thread = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${space.id}/conversations`, { body: { body: first, clientMessageId: randomUUID() } }), 201) as Conversation;
      const id = thread.messages[0]!.id;
      const edited = expectStatus(await edit(ada, thread.id, id, second), 200) as ConversationMessage;
      assert.equal(edited.body, second, 'the author reads the words');
      const sealedRow = (await pool.query('SELECT body FROM project_messages WHERE id = $1', [id])).rows[0].body as string;
      assert.ok(!sealedRow.includes(second) && !sealedRow.includes(first), 'the stored text is an envelope');
      assert.ok(!(await databaseText()).includes(first), 'the first words are nowhere');
      const own = await reply(ada, thread.id, gone);
      assert.equal((expectStatus(await ada.browser.request('GET', `/api/v1/conversations/${thread.id}`), 200) as Conversation).messages.at(-1)!.body, gone);
      const removed = expectStatus(await remove(ada, thread.id, own.id), 200) as ConversationMessage;
      assert.equal(removed.body, REMOVED_BY_AUTHOR_BODY);
      const stored = (await pool.query('SELECT body FROM project_messages WHERE id = $1', [own.id])).rows[0].body as string;
      assert.ok(!stored.includes(REMOVED_BY_AUTHOR_BODY), 'the marker is sealed too');
      const dm = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${sealedId}/dms`, { body: { participantIds: [ben.id] } }), 201) as Dm;
      const line = expectStatus(await ada.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: dmWords, clientMessageId: randomUUID() } }), 201) as DmMessage;
      expectStatus(await ada.browser.request('DELETE', `/api/v1/dms/${dm.id}/messages/${line.id}`), 200);
      assert.ok(!(await databaseText()).includes(gone) && !(await databaseText()).includes(dmWords), 'the deleted words are nowhere in the database');
      // Someone else in the workspace still cannot.
      assert.equal((await edit(ben, thread.id, id, 'mine now')).status, 403);
      // Locked, the workspace answers 423 and nothing changes.
      expectStatus(await lock(ada.browser, sealedId), 200);
      const locked = await edit(ada, thread.id, id, 'while locked');
      assert.equal(locked.status, 423);
      assert.equal(codeOf(locked), 'WORKSPACE_LOCKED');
      assert.equal((await remove(ada, thread.id, id)).status, 423);
    });
  });
});
