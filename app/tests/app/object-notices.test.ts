import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Conversation, ConversationMessage, Decision, ObjectNotice, Page } from '@flux/contracts';
import { NEEDS_YOU_PATH, type InboxResponse, type NeedsYouResponse, type WorkItem } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';
import { waitFor } from './support/wait.js';
import { pool } from './support/db.js';
import { StreamClient } from './support/stream.js';

// What the conversation says about decisions (#694): a decision proposed in a thread is one card with who, where from and the
// object's state now; accepting it changes that card in place, with who accepted it and when, and adds no line (#1424 D). A
// proposal reaches everyone at once and its proposer's Undo withdraws it for everyone, with its notifications and Inbox items
// (#1424 L). Read by exactly the people who can read the project; the live events carry identifiers only.

async function scene() {
  const [owner, writer, reader, outsider, stranger] = await Promise.all(['trace-owner', 'trace-writer', 'trace-reader', 'trace-outsider', 'trace-stranger'].map(person));
  const ws = await workspace(owner, 'Decision trace checks');
  for (const other of [writer, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Night lamp', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, place.id, reader, 'contributor');
  const elsewhere = await project(owner, ws.id, 'Other room', 'restricted');
  const root = expectStatus(await writer.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Should the lamp wake up when someone waves?', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const replyOne = expectStatus(await owner.browser.request('POST', `/api/v1/conversations/${root.id}/messages`, {
    body: { body: 'A ToF sensor works in the dark.', clientMessageId: randomUUID() },
  }), 201) as ConversationMessage;
  const otherRoot = expectStatus(await writer.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'A different thread about the base.', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const noticePath = `/api/v1/projects/${place.id}/object-notices`;
  const notices = async (who = reader, path = noticePath) => expectStatus(await who.browser.request('GET', `${path}?limit=100`), 200) as Page<ObjectNotice>;
  const propose = async (body: Record<string, unknown>, who = writer) =>
    expectStatus(await who.browser.request('POST', `/api/v1/projects/${place.id}/decisions`, { body }), 201) as Decision;
  const accept = async (decision: Decision, who = owner) =>
    expectStatus(await who.browser.request('POST', `/api/v1/decisions/${decision.id}/accept`, { body: {}, headers: { 'if-match': `"${decision.version}"` } }), 200) as Decision;
  return { owner, writer, reader, outsider, stranger, ws, place, elsewhere, root, replyOne, otherRoot, noticePath, notices, propose, accept };
}

test('a decision proposed from a reply in a thread shows as one line with its thread, state and proposer', async () => {
  const f = await scene();
  assert.equal((await f.notices()).total, 0, 'nothing is announced before there is a decision');
  const decision = await f.propose({ title: 'Use a ToF sensor', rationale: 'It works in the dark', sources: [{ type: 'message', id: f.replyOne.id }] });
  const page = await f.notices();
  assert.equal(page.total, 1);
  const line = page.items[0]!;
  assert.equal(line.kind, 'decision.proposed');
  assert.deepEqual({ ...line, id: undefined }, { id: undefined, kind: 'decision.proposed', decisionId: decision.id, status: 'proposed', workspaceId: f.ws.id, projectId: f.place.id,
    title: 'Use a ToF sensor', by: decision.proposedBy, sources: [{ type: 'message', id: f.replyOne.id }], conversationId: f.root.id, createdAt: decision.createdAt, decided: null, discussion: null });
  assert.equal(line.by.id, f.writer.id);
  assert.ok(line.by.name, 'the line names who proposed it');
  assert.equal(line.id, `${decision.id}:proposed`, 'a stable identity per object');
  // The same page for every reader of the project; opening and reading again manufacture nothing.
  assert.deepEqual(await f.notices(f.owner), page);
  assert.deepEqual(await f.notices(), page);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id = $1', [f.place.id])).rows[0].n, 3, 'a line is never a message');
});

test('accepting changes its one card in place, with who accepted it and when, and adds no line (#1424 D)', async () => {
  const f = await scene();
  const decision = await f.propose({ title: 'Use a ToF sensor', sources: [{ type: 'message', id: f.replyOne.id }] });
  const accepted = await f.accept(decision);
  const page = await f.notices();
  assert.equal(page.total, 1, 'still one card: no "accepted it" line');
  const card = page.items[0]!;
  assert.equal(card.id, `${decision.id}:proposed`);
  assert.equal(card.kind, 'decision.proposed');
  assert.equal(card.status, 'accepted', 'the card shows where the decision stands now');
  assert.equal(card.by.id, f.writer.id, 'the card still names who proposed it');
  assert.equal(card.createdAt, decision.createdAt, 'it keeps its place, where and when it was proposed');
  assert.deepEqual(card.decided, { by: { kind: 'human', id: f.owner.id, name: 'trace-owner' }, at: accepted.decidedAt }, 'who accepted it and when, on the card');
  assert.equal(card.conversationId, f.root.id);
  assert.deepEqual(card.sources, [{ type: 'message', id: f.replyOne.id }]);
});

test('a replaced decision shows as replaced on its card and the new rule leads', async () => {
  const f = await scene();
  const first = await f.accept(await f.propose({ title: 'Wake on a wave', sources: [{ type: 'message', id: f.root.messages[0]!.id }] }));
  const second = await f.propose({ title: 'Wake on a wave or a step', supersedes: first.id });
  await f.accept(second);
  const page = await f.notices();
  assert.equal(page.total, 2);
  const states = Object.fromEntries(page.items.map((line) => [line.id, line.status]));
  assert.deepEqual(states, { [`${first.id}:proposed`]: 'superseded', [`${second.id}:proposed`]: 'accepted' });
  assert.equal(page.items[0]!.id, `${second.id}:proposed`);
  const noSource = page.items.find((line) => line.id === `${second.id}:proposed`)!;
  assert.deepEqual([noSource.sources, noSource.conversationId], [[], null], 'a decision made from nothing names no thread');
});

test('a proposal reaches a watcher at once, and its proposer\'s Undo withdraws it for everyone with its notifications and Inbox items (#1424 L)', async () => {
  const f = await scene();
  // The reader owns a task the proposal is about: the proposal reaches their Inbox and their notifications.
  const task = expectStatus(await f.reader.browser.request('POST', `/api/v1/projects/${f.place.id}/work`, { body: { title: 'Mount the sensor', owner: { kind: 'human', id: f.reader.id } } }), 201) as WorkItem;
  const watcher = await StreamClient.connect(f.reader.browser);
  await watcher.ready();
  const decision = await f.propose({ title: 'Mount it under the shade', sources: [{ type: 'message', id: f.replyOne.id }], affects: [task.id] });
  // At once: the event, the card, the Inbox item and the notification, with no hold.
  await watcher.event(f.place.id, 'project.decision_proposed.v1');
  assert.deepEqual((await f.notices()).items.map((card) => card.decisionId), [decision.id]);
  const needs = async () => (expectStatus(await f.reader.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items.filter((item) => item.decision?.id === decision.id);
  assert.equal((await needs()).length, 1, 'it waits in the Inbox of those who can accept it');
  const inbox = async () => (expectStatus(await f.reader.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse).items.filter((item) => item.url?.includes(decision.id));
  await waitFor(async () => (await inbox()).length > 0, 'the reader\'s notification of the proposal');
  // Not now on it, so a choice made in the Inbox is withdrawn with it too.
  expectStatus(await f.reader.browser.request('POST', `${NEEDS_YOU_PATH}/${encodeURIComponent(`decision:${decision.id}`)}`, { body: { action: 'snooze', until: new Date(Date.now() + 3_600_000).toISOString() } }), 200);

  expectStatus(await f.writer.browser.request('POST', `/api/v1/decisions/${decision.id}/withdraw`, { body: {}, headers: { 'if-match': `"${decision.version}"` } }), 204);
  await watcher.until(() => watcher.events.find((event) => event.kind === 'project.decision_withdrawn.v1'), 8000, 'the withdrawal');
  assert.equal((await f.notices()).total, 0, 'its card is gone for every reader');
  assert.equal((await f.notices(f.owner)).total, 0);
  expectStatus(await f.reader.browser.request('GET', `/api/v1/decisions/${decision.id}`), 404);
  assert.equal((await needs()).length, 0, 'gone from the Inbox');
  assert.equal((await inbox()).length, 0, 'its notification is withdrawn');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM needs_you_states WHERE item_key = $1', [`decision:${decision.id}`])).rows[0].n, 0, 'the Not now on it is gone');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_object_links WHERE from_id = $1 OR to_id = $1', [decision.id])).rows[0].n, 0, 'its links go with it');
  // The task and the message it came from stay.
  assert.equal((expectStatus(await f.reader.browser.request('GET', `/api/v1/work/${task.id}`), 200) as WorkItem).title, 'Mount the sensor');
  // Withdrawn twice is simply gone.
  expectStatus(await f.writer.browser.request('POST', `/api/v1/decisions/${decision.id}/withdraw`, { body: {}, headers: { 'if-match': `"${decision.version}"` } }), 404);
  await watcher.close();
});

test('only its proposer withdraws a proposal, and only while it is an unused proposal', async () => {
  const f = await scene();
  const withdraw = (decision: Decision, who = f.writer, version = decision.version) =>
    who.browser.request('POST', `/api/v1/decisions/${decision.id}/withdraw`, { body: {}, headers: { 'if-match': `"${version}"` } });
  const code = (response: Awaited<ReturnType<typeof withdraw>>, status: number) => (expectStatus(response, status) as { code: string }).code;
  const proposal = await f.propose({ title: 'Print the base' });
  assert.equal(code(await withdraw(proposal, f.owner), 403), 'DECISION_NOT_YOURS', 'not another person, not even the owner');
  assert.equal(code(await withdraw(proposal, f.outsider), 404), 'DECISION_NOT_FOUND');
  expectStatus(await f.writer.browser.request('POST', `/api/v1/decisions/${proposal.id}/withdraw`, { body: {} }), 428);
  assert.equal(code(await withdraw(proposal, f.writer, proposal.version + 1), 409), 'VERSION_CONFLICT');
  // Accepted, it is a decision: a change of direction is a new proposal.
  const accepted = await f.accept(await f.propose({ title: 'Paint it white' }));
  assert.equal(code(await withdraw(accepted, f.writer, accepted.version), 409), 'DECISION_NOT_PROPOSED');
  // Used since: a task waits for it, or something links to it.
  const waited = await f.propose({ title: 'Pick a colour' });
  expectStatus(await f.reader.browser.request('POST', `/api/v1/projects/${f.place.id}/work`, { body: { title: 'Paint the base', status: 'blocked', waitingOn: { kind: 'decision', id: waited.id } } }), 201);
  assert.equal(code(await withdraw(waited), 409), 'DECISION_IN_USE');
  const linked = await f.propose({ title: 'Use a matte finish' });
  const other = expectStatus(await f.reader.browser.request('POST', `/api/v1/projects/${f.place.id}/work`, { body: { title: 'Buy the paint' } }), 201) as WorkItem;
  expectStatus(await f.reader.browser.request('POST', `/api/v1/projects/${f.place.id}/links`, { body: { from: { type: 'work', id: other.id }, to: { type: 'decision', id: linked.id } } }), 201);
  assert.equal(code(await withdraw(linked), 409), 'DECISION_IN_USE');
  // Every refused one stays as it was.
  assert.deepEqual((await f.notices()).items.map((card) => card.decisionId).sort(), [proposal.id, accepted.id, waited.id, linked.id].sort());
  expectStatus(await withdraw(proposal), 204);
});

test('the lines page by the same window as the task notices', async () => {
  const f = await scene();
  await f.propose({ title: 'Rule 0', sources: [{ type: 'message', id: f.replyOne.id }] });
  for (const index of [1, 2]) await f.propose({ title: `Rule ${index}` });
  const second = expectStatus(await f.reader.browser.request('GET', `${f.noticePath}?limit=2&offset=1`), 200) as Page<ObjectNotice>;
  assert.deepEqual([second.total, second.items.length, second.limit, second.offset], [3, 2, 2, 1]);
  assert.ok(second.items.every((line) => line.kind === 'decision.proposed'));
});

test('only people who can read the project read its lines, and another project never leaks in', async () => {
  const f = await scene();
  await f.propose({ title: 'Quiet rule', sources: [{ type: 'message', id: f.replyOne.id }] });
  expectStatus(await f.outsider.browser.request('GET', f.noticePath), 404);
  expectStatus(await f.stranger.browser.request('GET', f.noticePath), 404);
  expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.elsewhere.id}/object-notices`), 404);
  assert.equal((await f.notices(f.owner, `/api/v1/projects/${f.elsewhere.id}/object-notices`)).total, 0);
  assert.equal((await f.notices()).total, 1);
});

test('the live events carry identifiers only and reach only people who can read the project', async () => {
  const f = await scene();
  const viewer = await StreamClient.connect(f.reader.browser);
  const outside = await StreamClient.connect(f.outsider.browser);
  await Promise.all([viewer.ready(), outside.ready()]);
  const decision = await f.propose({ title: 'A rule with a secret-sounding title', rationale: 'A rationale nobody outside reads', sources: [{ type: 'message', id: f.replyOne.id }] });
  const proposed = await viewer.event(f.place.id, 'project.decision_proposed.v1');
  await f.accept(decision);
  const accepted = await viewer.until(() => viewer.events.find((event) => event.kind === 'project.decision_accepted.v1'), 8000, 'the acceptance');
  for (const event of [proposed, accepted]) {
    assert.deepEqual(Object.keys(event).sort(), ['createdAt', 'cursor', 'id', 'kind', 'objectId', 'objectType', 'type', 'workspaceId'], 'the stream message has no content fields');
    assert.equal(event.objectType, 'project');
    assert.equal(event.objectId, f.place.id);
    assert.doesNotMatch(JSON.stringify(event), /secret-sounding|rationale/);
  }
  // The stored events hold the decision's id and nothing else.
  const stored = (await pool.query("SELECT kind, data FROM events WHERE object_id = $1 AND kind LIKE 'project.decision_%' ORDER BY seq", [f.place.id])).rows as { kind: string; data: Record<string, unknown> }[];
  assert.deepEqual(stored.map((row) => [row.kind, Object.keys(row.data)]), [['project.decision_proposed.v1', ['decisionId']], ['project.decision_accepted.v1', ['decisionId']]]);
  assert.deepEqual(outside.events, [], 'a member without access to the project hears nothing of it');
  await Promise.all([viewer.close(), outside.close()]);
});
