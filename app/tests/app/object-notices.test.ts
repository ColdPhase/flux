import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Conversation, ConversationMessage, Decision, ObjectNotice, Page, WorkResult } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';
import { pool } from './support/db.js';
import { StreamClient } from './support/stream.js';

// What the conversation says about decisions and results (#694): a decision proposed or accepted in a thread, and a
// result recorded, leave a line with who, where from and the object's state now. Read by exactly the people who
// can read the project; the live events carry identifiers only.

async function scene() {
  const [owner, writer, reader, outsider, stranger] = await Promise.all(['trace-owner', 'trace-writer', 'trace-reader', 'trace-outsider', 'trace-stranger'].map(person));
  const ws = await workspace(owner, 'Decision trace checks');
  for (const other of [writer, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Night lamp', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, place.id, reader, 'viewer');
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
    title: 'Use a ToF sensor', by: decision.proposedBy, sources: [{ type: 'message', id: f.replyOne.id }], conversationId: f.root.id, createdAt: decision.createdAt });
  assert.equal(line.by.id, f.writer.id);
  assert.ok(line.by.name, 'the line names who proposed it');
  assert.equal(line.id, `${decision.id}:proposed`, 'a stable identity per object and moment');
  // The same page for every reader of the project; opening and reading again manufacture nothing.
  assert.deepEqual(await f.notices(f.owner), page);
  assert.deepEqual(await f.notices(), page);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE project_id = $1', [f.place.id])).rows[0].n, 3, 'a line is never a message');
});

test('accepting changes the state on both lines and adds the acceptance by the person who decided', async () => {
  const f = await scene();
  const decision = await f.propose({ title: 'Use a ToF sensor', sources: [{ type: 'message', id: f.replyOne.id }] });
  const accepted = await f.accept(decision);
  const page = await f.notices();
  assert.equal(page.total, 2);
  const [latest, first] = page.items as [ObjectNotice, ObjectNotice];
  assert.deepEqual([latest.id, first.id], [`${decision.id}:accepted`, `${decision.id}:proposed`], 'newest first');
  assert.equal(latest.kind, 'decision.accepted');
  assert.equal(latest.createdAt, accepted.decidedAt);
  assert.equal(latest.by.id, f.owner.id, 'the person who accepted it, not the proposer');
  for (const line of [latest, first]) {
    assert.equal(line.kind === 'result.recorded' ? null : line.status, 'accepted', 'both lines show where the decision stands now');
    assert.equal(line.conversationId, f.root.id, 'the acceptance stays in the thread of the proposal');
    assert.deepEqual(line.sources, [{ type: 'message', id: f.replyOne.id }]);
  }
});

test('a replaced decision shows as replaced on its lines and the new rule leads', async () => {
  const f = await scene();
  const first = await f.accept(await f.propose({ title: 'Wake on a wave', sources: [{ type: 'message', id: f.root.messages[0]!.id }] }));
  const second = await f.propose({ title: 'Wake on a wave or a step', supersedes: first.id });
  await f.accept(second);
  const page = await f.notices();
  assert.equal(page.total, 4);
  const states = Object.fromEntries(page.items.map((line) => [line.id, line.kind === 'result.recorded' ? null : line.status]));
  assert.deepEqual(states, { [`${first.id}:proposed`]: 'superseded', [`${first.id}:accepted`]: 'superseded', [`${second.id}:proposed`]: 'accepted', [`${second.id}:accepted`]: 'accepted' });
  assert.equal(page.items[0]!.id, `${second.id}:accepted`);
  const noSource = page.items.find((line) => line.id === `${second.id}:proposed`)!;
  assert.deepEqual([noSource.sources, noSource.conversationId], [[], null], 'a decision made from nothing names no thread');
});

test('a result recorded from a thread shows with its finding, and pages by the same window as the task notices', async () => {
  const f = await scene();
  const result = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/results`, {
    body: { title: 'The camera fails below 10 lux', finding: 'negative', evidence: 'Ten runs in the dark room', sources: [{ type: 'message', id: f.replyOne.id }] },
  }), 201) as WorkResult;
  const [line] = (await f.notices()).items;
  assert.deepEqual({ ...line, id: undefined }, { id: undefined, kind: 'result.recorded', resultId: result.id, finding: 'negative', workspaceId: f.ws.id, projectId: f.place.id,
    title: result.title, by: result.createdBy, sources: [{ type: 'message', id: f.replyOne.id }], conversationId: f.root.id, createdAt: result.createdAt });
  for (const index of [1, 2]) await f.propose({ title: `Rule ${index}` });
  const second = expectStatus(await f.reader.browser.request('GET', `${f.noticePath}?limit=2&offset=1`), 200) as Page<ObjectNotice>;
  assert.deepEqual([second.total, second.items.length, second.limit, second.offset], [3, 2, 2, 1]);
});

test('only people who can read the project read its lines, and another project never leaks in', async () => {
  const f = await scene();
  await f.propose({ title: 'Quiet rule', sources: [{ type: 'message', id: f.replyOne.id }] });
  expectStatus(await f.outsider.browser.request('GET', f.noticePath), 404);
  expectStatus(await f.stranger.browser.request('GET', f.noticePath), 404);
  expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.elsewhere.id}/object-notices`), 404);
  assert.equal((await f.notices(f.owner, `/api/v1/projects/${f.elsewhere.id}/object-notices`)).total, 0);
  // A viewer reads but cannot make a line: proposing is refused and changes nothing.
  expectStatus(await f.reader.browser.request('POST', `/api/v1/projects/${f.place.id}/decisions`, { body: { title: 'Not mine' } }), 403);
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
