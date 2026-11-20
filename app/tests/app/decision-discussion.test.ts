import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  NEEDS_YOU_PATH, NOTIFICATION_FOLLOWS_PATH, NOTIFICATION_PREFERENCES_PATH, decisionDiscussionPath, type NeedsYouResponse,
  type Conversation, type ConversationRootWindow, type Decision, type DecisionDiscussion, type ObjectNotice, type Page, type Project, type SentConversationMessage,
} from '@flux/contracts';
import { pool } from './support/db.js';
import { createSealed, passphrase } from './support/encryption.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';

// A decision's one discussion (founder decision, Hubert, 2026-11-15, #1424): Discuss starts a thread on the decision's card in the space's
// conversation, and the decision's panel shows the same thread with a field to write. Writing in the panel posts to that thread; a reply in
// the thread shows in the panel; the card counts it; the thread's notification rules apply, and whoever proposed the decision follows it.

async function scene() {
  const [owner, proposer, writer, guest, outsider] = await Promise.all(['dd-owner', 'dd-proposer', 'dd-writer', 'dd-guest', 'dd-outsider'].map(person));
  const ws = await workspace(owner, 'Decision talk checks');
  for (const member of [proposer, writer, outsider]) await addMember(owner, ws.id, member, 'member');
  await addMember(owner, ws.id, guest, 'guest');
  const place = await project(owner, ws.id, 'Night lamp', 'restricted');
  for (const member of [proposer, writer, guest]) await grant(owner, place.id, member, 'contributor');
  // Replies reach their followers at every level; Everything makes a reply a notification of its own for each of them.
  for (const someone of [owner, proposer, writer, guest])
    expectStatus(await someone.browser.request('PATCH', NOTIFICATION_PREFERENCES_PATH, { body: { level: 'everything' } }), 200);
  const decision = expectStatus(await proposer.browser.request('POST', `/api/v1/projects/${place.id}/decisions`,
    { body: { title: 'Use a ToF sensor', rationale: 'It works in the dark' } }), 201) as Decision;
  return { owner, proposer, writer, guest, outsider, ws, place, decision };
}

const discussion = async (who: Person, decisionId: string) => expectStatus(await who.browser.request('GET', decisionDiscussionPath(decisionId)), 200) as DecisionDiscussion;
const write = async (who: Person, decisionId: string, body: string, clientMessageId = randomUUID()) =>
  expectStatus(await who.browser.request('POST', decisionDiscussionPath(decisionId), { body: { body, clientMessageId } }), 201) as SentConversationMessage;
const reply = async (who: Person, conversationId: string, body: string) =>
  expectStatus(await who.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201) as SentConversationMessage;
const card = async (who: Person, projectId: string, decisionId: string) =>
  (expectStatus(await who.browser.request('GET', `/api/v1/projects/${projectId}/object-notices?limit=100`), 200) as Page<ObjectNotice>).items.find((item) => item.decisionId === decisionId)!;
const setFollow = async (who: Person, conversationId: string, following: boolean) =>
  expectStatus(await who.browser.request('PUT', NOTIFICATION_FOLLOWS_PATH, { body: { conversationId, following } }), 200);
const notificationsOf = async (who: Person, conversationId: string) =>
  (await pool.query<{ reason: string; url: string }>('SELECT reason, url FROM notifications WHERE user_id = $1 AND url LIKE $2 ORDER BY created_at', [who.id, `%/conversations/${conversationId}#%`])).rows;

test('writing in the panel starts the thread on the decision\'s card, and a reply in that thread shows in the panel', async () => {
  const f = await scene();
  const empty = await discussion(f.writer, f.decision.id);
  assert.equal(empty.conversationId, null, 'no thread before anyone writes');
  assert.deepEqual(empty.messages, []);
  assert.equal((await card(f.writer, f.place.id, f.decision.id)).discussion, null, 'the card has no count yet');

  const first = await write(f.writer, f.decision.id, 'Does it see through the lamp shade?');
  const started = await discussion(f.owner, f.decision.id);
  assert.ok(started.conversationId);
  assert.equal(first.conversationId, started.conversationId, 'the panel wrote in the decision\'s thread');
  assert.deepEqual(started.messages.map((message) => message.body), ['Does it see through the lamp shade?']);

  // The same thread opens from the card: it names its decision, and it is a conversation of the space, not a root of the stream.
  const thread = expectStatus(await f.owner.browser.request('GET', `/api/v1/conversations/${started.conversationId}`), 200) as Conversation;
  assert.deepEqual(thread.decision, { decisionId: f.decision.id, title: 'Use a ToF sensor' });
  const roots = expectStatus(await f.owner.browser.request('GET', `/api/v1/projects/${f.place.id}/conversation-roots`), 200) as ConversationRootWindow;
  assert.equal(roots.roots.some((root) => root.conversationId === started.conversationId), false, 'its place is the card, not the stream');

  // A reply in the thread (its own composer, or anything that replies to a conversation) is in the panel.
  const answer = await reply(f.owner, started.conversationId!, 'Yes, through 3 mm of opal acrylic.');
  const both = await discussion(f.writer, f.decision.id);
  assert.deepEqual(both.messages.map((message) => message.id), [first.id, answer.id], 'oldest first, the newest at the bottom');

  // The card counts every message of the thread and says when the newest came.
  const counted = (await card(f.writer, f.place.id, f.decision.id)).discussion;
  assert.deepEqual(counted, { conversationId: started.conversationId, replyCount: 2, lastReplyAt: answer.createdAt });

  // The panel writes into the same thread from then on.
  const again = await write(f.proposer, f.decision.id, 'Then the shade stays.');
  assert.equal(again.conversationId, started.conversationId);
  assert.equal((await discussion(f.writer, f.decision.id)).messages.length, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_decision_discussions WHERE decision_id = $1', [f.decision.id])).rows[0].n, 1, 'one discussion per decision');
});

test('two first messages at once make one thread, a retry stores nothing twice, and the same id for other words conflicts', async () => {
  const f = await scene();
  const [a, b] = await Promise.all([write(f.writer, f.decision.id, 'First from the writer'), write(f.owner, f.decision.id, 'First from the owner')]);
  assert.equal(a.conversationId, b.conversationId, 'one thread');
  assert.deepEqual([a.sequence, b.sequence].sort(), [1, 2]);
  const id = randomUUID();
  const sent = await write(f.writer, f.decision.id, 'Said once', id);
  const retried = await write(f.writer, f.decision.id, 'Said once', id);
  assert.equal(retried.id, sent.id);
  assert.equal((await discussion(f.owner, f.decision.id)).messages.length, 3);
  expectStatus(await f.writer.browser.request('POST', decisionDiscussionPath(f.decision.id), { body: { body: 'Other words', clientMessageId: id } }), 409);
});

test('who reads and writes it: the space\'s people and its guest; nobody outside the space; a decision written about stays', async () => {
  const f = await scene();
  const guestSays = await write(f.guest, f.decision.id, 'A guest of the space can say this.');
  assert.equal((await discussion(f.guest, f.decision.id)).messages[0]!.id, guestSays.id);
  expectStatus(await f.outsider.browser.request('GET', decisionDiscussionPath(f.decision.id)), 404, 'outside the space it is not there');
  expectStatus(await f.outsider.browser.request('POST', decisionDiscussionPath(f.decision.id), { body: { body: 'Let me in', clientMessageId: randomUUID() } }), 404);
  expectStatus(await f.writer.browser.request('GET', decisionDiscussionPath(randomUUID())), 404);
  // Its proposer's Undo no longer withdraws it: what was written about it stays.
  const withdrawn = await f.proposer.browser.request('POST', `/api/v1/decisions/${f.decision.id}/withdraw`, { body: {}, headers: { 'if-match': `"${f.decision.version}"` } });
  assert.equal(withdrawn.status, 409);
  assert.equal((withdrawn.json as { code?: string }).code, 'DECISION_IN_USE');
});

test('notifications follow the thread\'s rules, and whoever proposed the decision follows it from its first message', async () => {
  const f = await scene();
  const first = await write(f.writer, f.decision.id, 'A ToF sensor should be bright enough at night.');
  const conversationId = first.conversationId;
  // The proposer did not write, yet follows: the first message reaches them as a reply in the thread.
  const toProposer = await waitFor(async () => (await notificationsOf(f.proposer, conversationId)).find((row) => row.url.endsWith(first.id)), 'the proposer is told');
  assert.equal(toProposer.reason, 'reply');
  assert.equal((await pool.query<{ title: string }>('SELECT title FROM notifications WHERE user_id = $1 AND url LIKE $2', [f.proposer.id, `%${first.id}`])).rows[0]!.title,
    'dd-writer replied about “Use a ToF sensor”', 'the notice names the decision, not the first comment');
  // A reply in the thread reaches its starter (the writer) and the proposer, never its author; the owner, who has not written, is not told.
  const answer = await reply(f.guest, conversationId, 'It has its own infrared light.');
  await waitFor(async () => (await notificationsOf(f.writer, conversationId)).find((row) => row.url.endsWith(answer.id)), 'the starter is told');
  await waitFor(async () => (await notificationsOf(f.proposer, conversationId)).find((row) => row.url.endsWith(answer.id)), 'the proposer is told of the reply');
  // A mention of someone in the panel reaches them as a mention, as in any thread.
  const named = await write(f.proposer, f.decision.id, '@dd-owner can you accept it?');
  const toOwner = await waitFor(async () => (await notificationsOf(f.owner, conversationId)).find((row) => row.url.endsWith(named.id)), 'the named owner is told');
  assert.equal(toOwner.reason, 'question');
  assert.equal((await notificationsOf(f.guest, conversationId)).some((row) => row.url.endsWith(answer.id)), false, 'the author is never told of their own message');
  assert.equal((await notificationsOf(f.owner, conversationId)).some((row) => row.url.endsWith(answer.id)), false, 'someone outside the thread is not told of a reply');
  // The proposer's choice wins: after Unfollow the thread's replies stop reaching them.
  await setFollow(f.proposer, conversationId, false);
  const later = await reply(f.writer, conversationId, 'Agreed, then.');
  await waitFor(async () => (await notificationsOf(f.guest, conversationId)).find((row) => row.url.endsWith(later.id)), 'the guest who wrote is told');
  assert.equal((await notificationsOf(f.proposer, conversationId)).some((row) => row.url.endsWith(later.id)), false, 'Unfollow wins');
});

test('an encrypted space seals the decision\'s discussion as any thread\'s', async () => {
  const ada = await person('dd-sealed-ada');
  const ws = (await createSealed(ada, 'Sealed lamp club', passphrase())).workspace.id;
  const place = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws}/projects`, { body: { name: 'Shade', visibility: 'workspace' } }), 201) as Project;
  const decision = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${place.id}/decisions`, { body: { title: 'Opal acrylic shade' } }), 201) as Decision;
  const sent = await write(ada, decision.id, 'The opal shade diffuses the sensor light well.');
  assert.deepEqual((await discussion(ada, decision.id)).messages.map((message) => message.body), ['The opal shade diffuses the sensor light well.']);
  const stored = (await pool.query<{ body: string }>('SELECT body FROM project_messages WHERE id = $1', [sent.id])).rows[0]!;
  assert.ok(!stored.body.includes('opal shade'), 'the words are sealed at rest');
  const thread = expectStatus(await ada.browser.request('GET', `/api/v1/conversations/${sent.conversationId}`), 200) as Conversation;
  assert.equal(thread.decision?.title, 'Opal acrylic shade', 'the decision\'s title is opened for its reader');
});

test('an edit or a delete of a message in the discussion tells its panel to read again, and the panel shows it', async () => {
  const f = await scene();
  const said = await write(f.writer, f.decision.id, 'The shade is 2 mm thick.');
  const decided = async () => Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE kind = 'project.decision_discussed.v1' AND data->>'decisionId' = $1",
    [f.decision.id])).rows[0]!.n);
  assert.equal(await decided(), 1, 'the message told the panel');
  expectStatus(await f.writer.browser.request('PATCH', `/api/v1/conversations/${said.conversationId}/messages/${said.id}`, { body: { body: 'The shade is 3 mm thick.' } }), 200);
  assert.equal(await decided(), 2, 'the edit tells it too');
  const edited = (await discussion(f.owner, f.decision.id)).messages[0]!;
  assert.equal(edited.body, 'The shade is 3 mm thick.');
  assert.ok(edited.editedAt);
  expectStatus(await f.writer.browser.request('DELETE', `/api/v1/conversations/${said.conversationId}/messages/${said.id}`), 200);
  assert.equal(await decided(), 3, 'and so does the delete');
  assert.ok((await discussion(f.owner, f.decision.id)).messages[0]!.removedAt, 'the panel shows the deleted marker in its place');
  // A message of an ordinary thread tells no decision anything.
  const other = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: { body: 'Unrelated', clientMessageId: randomUUID() } }), 201) as Conversation;
  expectStatus(await f.writer.browser.request('PATCH', `/api/v1/conversations/${other.id}/messages/${other.messages[0]!.id}`, { body: { body: 'Still unrelated' } }), 200);
  assert.equal(await decided(), 3);
});

test('where you left off: the New divider can stand above the discussion\'s first message, as above any reply', async () => {
  const f = await scene();
  const first = await write(f.writer, f.decision.id, 'Is the shade 3 mm?');
  const read = async (who: Person) => expectStatus(await who.browser.request('GET', `/api/v1/conversations/${first.conversationId}`), 200) as Conversation;
  assert.equal((await read(f.owner)).unreadFrom, first.id, 'never opened: everything is new, from its first message');
  assert.equal((await read(f.writer)).unreadFrom, null, 'your own message is not new to you');
  const second = await write(f.proposer, f.decision.id, 'Yes, 3 mm.');
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/observations`, { body: { messageIds: [first.id] } }), 200);
  assert.equal((await read(f.owner)).unreadFrom, second.id, 'after the first was seen, the next one by someone else');
  // An ordinary thread's opening message is its header, never the divider's place.
  const root = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: { body: 'A thread', clientMessageId: randomUUID() } }), 201) as Conversation;
  assert.equal((expectStatus(await f.owner.browser.request('GET', `/api/v1/conversations/${root.id}`), 200) as Conversation).unreadFrom, null);
});

test('an agent\'s proposal is its owner\'s: the owner follows its discussion from the first message', async () => {
  const f = await scene();
  const agentId = randomUUID();
  await pool.query('INSERT INTO agents (id, workspace_id, name, owner_user_id, created_by) VALUES ($1, $2, $3, $4, $4)', [agentId, f.ws.id, 'Planner', f.owner.id]);
  const decisionId = randomUUID();
  await pool.query(`INSERT INTO project_decisions (id, workspace_id, project_id, title, proposed_by_kind, proposed_by_id) VALUES ($1, $2, $3, 'Dim the lamp at night', 'agent', $4)`,
    [decisionId, f.ws.id, f.place.id, agentId]);
  const first = await write(f.writer, decisionId, 'Dim it to a fifth.');
  const told = await waitFor(async () => (await notificationsOf(f.owner, first.conversationId)).find((row) => row.url.endsWith(first.id)), 'the agent\'s owner is told');
  assert.equal(told.reason, 'reply');
  const follow = (await pool.query<{ following: boolean }>('SELECT following FROM notification_follows WHERE user_id = $1 AND conversation_id = $2', [f.owner.id, first.conversationId])).rows[0];
  assert.equal(follow?.following, true);
});

test('a question that names nobody asks the decision\'s proposer, not whoever wrote first, and says which decision it is about', async () => {
  const f = await scene();
  // The writer writes first; the guest then asks a question that names nobody.
  await write(f.writer, f.decision.id, 'The lamp shade is 3 mm.');
  const asked = await write(f.guest, f.decision.id, 'Who locks the hall after we close?');
  const toProposer = await waitFor(async () => (await notificationsOf(f.proposer, asked.conversationId)).find((row) => row.url.endsWith(asked.id)), 'the proposer is asked');
  assert.equal(toProposer.reason, 'question');
  const title = (await pool.query<{ title: string }>('SELECT title FROM notifications WHERE user_id = $1 AND url LIKE $2', [f.proposer.id, `%${asked.id}`])).rows[0]!.title;
  assert.equal(title, 'dd-guest asked you about “Use a ToF sensor”');
  const toWriter = (await notificationsOf(f.writer, asked.conversationId)).find((row) => row.url.endsWith(asked.id));
  assert.notEqual(toWriter?.reason, 'question', 'the first writer is not the one asked');
  // The proposer's Inbox item says which decision it is about.
  const queue = expectStatus(await f.proposer.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse;
  const item = queue.items.find((entry) => entry.url.endsWith(`#message-${asked.id}`));
  assert.ok(item, 'the question is in the proposer\'s Inbox');
  assert.equal(item.kind, 'question');
  assert.deepEqual(item.about, { decisionId: f.decision.id, title: 'Use a ToF sensor' });
  // An ordinary question in an ordinary thread carries no decision.
  const root = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: { body: '@dd-proposer is the lamp done?', clientMessageId: randomUUID() } }), 201) as Conversation;
  const plain = await waitFor(async () => (expectStatus(await f.proposer.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.find((entry) => entry.url.includes(root.id)), 'an ordinary question');
  assert.equal(plain.about, undefined);
});

test('a discussed decision in the Inbox says how many messages its discussion holds (v0.2.2, #1563)', async () => {
  const f = await scene();
  const itemOf = async () => (expectStatus(await f.owner.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.find((entry) => entry.key === `decision:${f.decision.id}`);
  assert.equal((await itemOf())?.decision?.replies, undefined, 'nobody has written yet');
  await write(f.writer, f.decision.id, 'Does it see through the lamp shade?');
  await write(f.proposer, f.decision.id, 'Yes, up to 4 mm.');
  const removed = await write(f.writer, f.decision.id, 'Never mind, wrong thread.');
  assert.equal((await itemOf())?.decision?.replies, 3);
  expectStatus(await f.writer.browser.request('DELETE', `/api/v1/conversations/${removed.conversationId}/messages/${removed.id}`), 200);
  assert.equal((await itemOf())?.decision?.replies, 2, 'a message its author took back is not counted');
});

test('Home asks the same person as the Inbox: the proposer, never whoever wrote first in the discussion (personas-33 P2 5)', async () => {
  const f = await scene();
  type Home = { items: { kind: string; text: string; detail: string | null; source: { messageId?: string } | null }[]; nextStep: { text: string; reason: string } | null };
  const home = async (who: Person) => expectStatus(await who.browser.request('GET', `/api/v1/return?place=project&id=${f.place.id}`), 200) as Home;
  await write(f.writer, f.decision.id, 'We have a 15 m cable at the school.');
  const asked = await write(f.guest, f.decision.id, 'Is it waterproof?');
  await waitFor(async () => (await notificationsOf(f.proposer, asked.conversationId)).find((row) => row.url.endsWith(asked.id)), 'the proposer is asked');
  const writerHome = await home(f.writer);
  assert.equal(writerHome.items.some((entry) => entry.kind === 'question' && entry.source?.messageId === asked.id), false, 'the first writer is not asked on Home');
  const proposerHome = await home(f.proposer);
  const question = proposerHome.items.find((entry) => entry.kind === 'question' && entry.source?.messageId === asked.id);
  assert.ok(question, 'the proposer is asked on Home, as in the Inbox');
  assert.equal(question.detail, 'About “Use a ToF sensor”', 'named by its decision, as the Inbox names it');
  assert.deepEqual([proposerHome.nextStep?.text, proposerHome.nextStep?.reason], ['Answer dd-guest\'s question', '“Is it waterproof?” dd-guest asked you about “Use a ToF sensor”.']);
  assert.notEqual(writerHome.nextStep?.text, 'Answer dd-guest\'s question');
});

test('an agent\'s proposal: a question that names nobody asks the agent\'s owner', async () => {
  const f = await scene();
  const agentId = randomUUID();
  await pool.query('INSERT INTO agents (id, workspace_id, name, owner_user_id, created_by) VALUES ($1, $2, $3, $4, $4)', [agentId, f.ws.id, 'Planner', f.proposer.id]);
  const decisionId = randomUUID();
  await pool.query(`INSERT INTO project_decisions (id, workspace_id, project_id, title, proposed_by_kind, proposed_by_id) VALUES ($1, $2, $3, 'Close at 15:00', 'agent', $4)`,
    [decisionId, f.ws.id, f.place.id, agentId]);
  await write(f.writer, decisionId, 'Fine by me.');
  const asked = await write(f.guest, decisionId, 'Could we stay until 16:00?');
  const told = await waitFor(async () => (await notificationsOf(f.proposer, asked.conversationId)).find((row) => row.url.endsWith(asked.id)), 'the agent\'s owner is asked');
  assert.equal(told.reason, 'question');
});

test('in an encrypted space the question still asks the proposer, and its notice keeps its fixed words', async () => {
  const [ada, ben, cy] = await Promise.all(['dd-sealed-q-ada', 'dd-sealed-q-ben', 'dd-sealed-q-cy'].map(person));
  const ws = (await createSealed(ada, 'Sealed hall club', passphrase())).workspace.id;
  for (const member of [ben, cy]) await addMember(ada, ws, member, 'member');
  const place = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws}/projects`, { body: { name: 'Hall', visibility: 'workspace' } }), 201) as Project;
  const decision = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${place.id}/decisions`, { body: { title: 'Lock at six' } }), 201) as Decision;
  await write(ben, decision.id, 'Six works.');
  const asked = await write(cy, decision.id, 'Who has the key?');
  const row = await waitFor(async () => (await pool.query<{ reason: string; title: string; body: string }>('SELECT reason, title, body FROM notifications WHERE user_id = $1 AND url LIKE $2', [ada.id, `%${asked.id}`])).rows[0], 'the proposer is asked');
  assert.deepEqual([row.reason, row.title, row.body], ['question', 'dd-sealed-q-cy asked you in Sealed hall club', '']);
  const item = (expectStatus(await ada.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.find((entry) => entry.url.endsWith(`#message-${asked.id}`));
  assert.equal(item?.about?.title, 'Lock at six', 'the reader\'s own Inbox opens the decision\'s title');
});
