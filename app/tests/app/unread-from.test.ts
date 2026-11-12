import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { agentChatMessagesPath, taskDiscussionPath, type AgentChatLines, type Conversation, type Dm, type DmMessage, type DmThread, type Project, type TaskDiscussion, type Workspace } from '@flux/contracts';
import { assistantScene, human } from './support/assistant-scene.js';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// Where a person left off in a conversation (#1246): `unreadFrom` is the first message by someone else after the newest one they observed in
// it (the viewing receipts of #534 are the only read state), the first message of all when they have observed none (a conversation never
// opened is all new), and `null` when they have observed everything. It is the person's own read: another person, a removed message and a DM's
// "used AI here" line change nothing. An agent's chat says when its owner last had it open (`readAt`, null: never).

describe('where the person left off (#1246)', () => {
  let ada: Person;
  let bob: Person;
  let carol: Person;
  let ws: Workspace;
  let garden: Project;

  const dmOf = async (actor: Person, others: Person[], title: string) =>
    expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: others.map((o) => o.id), title } }), 201) as Dm;
  const say = async (actor: Person, dmId: string, body: string) =>
    expectStatus(await actor.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as DmMessage;
  const reply = async (actor: Person, dmId: string, rootId: string, body: string) =>
    expectStatus(await actor.browser.request('POST', `/api/v1/dms/${dmId}/threads/${rootId}/replies`, { body: { body, clientMessageId: randomUUID() } }), 201) as DmMessage;
  const observe = async (actor: Person, dmId: string, ids: string[]) => expectStatus(await actor.browser.request('POST', `/api/v1/dms/${dmId}/observations`, { body: { messageIds: ids } }), 200);
  const readDm = async (actor: Person, dmId: string) => expectStatus(await actor.browser.request('GET', `/api/v1/dms/${dmId}`), 200) as Dm;
  const readThread = async (actor: Person, dmId: string, rootId: string) => expectStatus(await actor.browser.request('GET', `/api/v1/dms/${dmId}/threads/${rootId}`), 200) as DmThread;

  const start = async (actor: Person, body: string) =>
    expectStatus(await actor.browser.request('POST', `/api/v1/projects/${garden.id}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation;
  const post = async (actor: Person, conversationId: string, body: string) =>
    expectStatus(await actor.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
  const watch = async (actor: Person, ids: string[]) => expectStatus(await actor.browser.request('POST', `/api/v1/projects/${garden.id}/observations`, { body: { messageIds: ids } }), 200);
  const readConversation = async (actor: Person, conversationId: string) => expectStatus(await actor.browser.request('GET', `/api/v1/conversations/${conversationId}`), 200) as Conversation;

  before(async () => {
    [ada, bob, carol] = await Promise.all(['left-ada', 'left-bob', 'left-carol'].map(person));
    ws = await workspace(ada, 'Riverside');
    await addMember(ada, ws.id, bob, 'member');
    await addMember(ada, ws.id, carol, 'member');
    garden = await project(ada, ws.id, 'Garden sensors', 'restricted');
    await grant(ada, garden.id, bob, 'contributor');
    await grant(ada, garden.id, carol, 'contributor');
  });

  describe('a direct message and its thread', () => {
    test('names the first message of a conversation never opened, then where the person left off, and null when they are caught up', async () => {
      const dm = await dmOf(ada, [bob, carol], 'Lamp crew');
      const first = await say(bob, dm.id, 'First');
      const second = await say(bob, dm.id, 'Second');
      assert.equal((await readDm(ada, dm.id)).unreadFrom, first.id, 'nothing observed: all of it is new, from its first message');
      await observe(ada, dm.id, [first.id]);
      assert.equal((await readDm(ada, dm.id)).unreadFrom, second.id, 'the first message after the newest one observed');
      const third = await say(carol, dm.id, 'Third');
      await observe(ada, dm.id, [second.id]);
      assert.equal((await readDm(ada, dm.id)).unreadFrom, third.id);
      await observe(ada, dm.id, [third.id]);
      assert.equal((await readDm(ada, dm.id)).unreadFrom, null, 'caught up');
      // Ada's own message is nobody's to read; the read is each person's own, and a conversation of one's own words has nothing new.
      await say(ada, dm.id, 'Mine');
      assert.equal((await readDm(ada, dm.id)).unreadFrom, null);
      assert.equal((await readDm(carol, dm.id)).unreadFrom, first.id, 'Carol has observed nothing');
      assert.equal((await readDm(bob, dm.id)).unreadFrom, third.id, 'Bob\'s first message by someone else is Carol\'s');
      const lonely = await dmOf(ada, [bob, carol], 'Notes to self');
      await say(ada, lonely.id, 'Only mine');
      assert.equal((await readDm(ada, lonely.id)).unreadFrom, null, 'nothing by anyone else');
    });

    test('a thread keeps its own level, and a removed message and the AI line never count', async () => {
      const dm = await dmOf(ada, [bob, carol], 'Lamp thread');
      const root = await say(bob, dm.id, 'Wave to dim?');
      const other = await say(bob, dm.id, 'Unrelated');
      const one = await reply(bob, dm.id, root.id, 'Yes.');
      const two = await reply(carol, dm.id, root.id, 'Or a knob.');
      await observe(ada, dm.id, [root.id]);
      // The root observed says where Ada is among the roots; no reply was observed, so every reply is new.
      assert.equal((await readDm(ada, dm.id)).unreadFrom, other.id);
      assert.equal((await readThread(ada, dm.id, root.id)).unreadFrom, one.id);
      await observe(ada, dm.id, [one.id]);
      assert.equal((await readThread(ada, dm.id, root.id)).unreadFrom, two.id);
      assert.equal((await readDm(ada, dm.id)).unreadFrom, other.id, 'a reply observed does not move the roots');
      // A message its author deleted, and the line that AI was used, are not new.
      expectStatus(await carol.browser.request('DELETE', `/api/v1/dms/${dm.id}/messages/${two.id}`), 200);
      assert.equal((await readThread(ada, dm.id, root.id)).unreadFrom, null);
      await pool.query(`INSERT INTO dm_messages (id, workspace_id, dm_id, author_id, client_message_id, request_fingerprint, sequence, body, kind)
        SELECT $1::uuid, workspace_id, id, $3::text, $2::uuid, 'ai_used', next_sequence, 'Anthropic', 'ai_used' FROM dms WHERE id = $4::uuid`, [randomUUID(), randomUUID(), bob.id, dm.id]);
      await pool.query('UPDATE dms SET next_sequence = next_sequence + 1 WHERE id = $1', [dm.id]);
      await observe(ada, dm.id, [other.id]);
      assert.equal((await readDm(ada, dm.id)).unreadFrom, null, 'the "used AI here" line is not a message');
    });
  });

  describe('a project thread and a task\'s discussion', () => {
    test('a thread says where its reader left off, from what they observed in it', async () => {
      const opened = await start(bob, 'Which bed first?');
      const rootId = opened.messages[0]!.id;
      const one = await post(bob, opened.id, 'The north one.');
      const two = await post(carol, opened.id, 'Or the east.');
      assert.equal((await readConversation(ada, opened.id)).unreadFrom, one.id, 'nothing observed: every reply is new, the root is the thread\'s header');
      await watch(ada, [rootId, one.id]);
      assert.equal((await readConversation(ada, opened.id)).unreadFrom, two.id);
      await watch(ada, [two.id]);
      assert.equal((await readConversation(ada, opened.id)).unreadFrom, null);
      const three = await post(bob, opened.id, 'East it is.');
      assert.equal((await readConversation(ada, opened.id)).unreadFrom, three.id);
      // Another conversation's observations say nothing here, and the read is the person's own.
      const elsewhere = await start(bob, 'Something else');
      assert.equal((await readConversation(ada, elsewhere.id)).unreadFrom, null, 'a root with no reply has nothing to read');
      const answer = await post(carol, elsewhere.id, 'Carol answers');
      assert.equal((await readConversation(ada, elsewhere.id)).unreadFrom, answer.id);
      assert.equal((await readConversation(carol, opened.id)).unreadFrom, one.id, 'Carol has observed nothing in it');
    });

    test('a task\'s discussion is read the same way', async () => {
      const task = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${garden.id}/work`, { body: { title: 'Order the sensors', clientCommandId: randomUUID() } }), 201) as { id: string };
      const contribute = async (actor: Person, body: string) =>
        expectStatus(await actor.browser.request('POST', taskDiscussionPath(task.id), { body: { body, clientMessageId: randomUUID() } }), 201) as { id: string };
      const root = await contribute(bob, 'Which supplier?');
      const next = await contribute(bob, 'The second one.');
      const talk = expectStatus(await ada.browser.request('GET', taskDiscussionPath(task.id)), 200) as TaskDiscussion;
      await watch(ada, [root.id]);
      const conversation = await readConversation(ada, talk.conversationId!);
      assert.equal(conversation.unreadFrom, next.id);
      assert.ok(conversation.task, 'it is a task\'s discussion');
    });
  });

  describe('an agent\'s chat', () => {
    test('says when its owner last had it open, before the chat\'s own read moves it, and nobody else\'s', async () => {
      const scene = await assistantScene('left');
      const read = async () => expectStatus(await scene.owner.browser.request('GET', agentChatMessagesPath(scene.agentId)), 200) as AgentChatLines;
      assert.equal((await read()).readAt, null, 'never opened: all of it is new');
      const before = Date.now();
      await scene.runs.readAgentChat(human(scene.owner), scene.agentId);
      const opened = (await read()).readAt;
      assert.ok(opened && Date.parse(opened) >= before - 1000 && Date.parse(opened) <= Date.now() + 1000, `opened at ${opened}`);
      assert.deepEqual((await read()).items, []);
      await assert.rejects(scene.runs.agentChatReadAt(human(scene.peer), scene.agentId), { code: 'AGENT_NOT_FOUND' });
      assert.equal((await scene.peer.browser.request('GET', agentChatMessagesPath(scene.agentId))).status, 404);
    });
  });
});
