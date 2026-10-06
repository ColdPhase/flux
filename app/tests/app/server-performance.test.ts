import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { Conversation } from '@flux/contracts';
import { conversationUseCases } from '@flux/core';
import { conversationStore } from '../../apps/server/src/conversation/store.js';
import { comparisonOutcomeReads } from '../../apps/server/src/proactive-comparison/outcome-adapter.js';
import { notificationRepository } from '../../apps/server/src/push/adapters.js';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, project, workspace } from './support/people.js';
import { explainAnalyze, recordingDatabase, subplans } from './support/statements.js';

// Regression tests for the slow paths measured in #298 (docs/development/performance-2026-10.md).
// They assert work that grows with the data (how often a subplan runs, how many statements a
// request sends) rather than wall-clock time, so they hold on a loaded host.

const { db, statements } = recordingDatabase();

describe('inbox unread count (#298)', () => {
  test('stays a cheap plan however many notifications a member has: no JIT compilation per count', async () => {
    const owner = await person('Inbox owner');
    const member = await person('Inbox member');
    const space = await workspace(owner, 'Inbox volume');
    await addMember(owner, space.id, member, 'member');
    const open = await project(owner, space.id, 'Open project', 'workspace');
    const hidden = await project(owner, space.id, 'Restricted project', 'restricted');
    const insert = (projectId: string, count: number) => pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, reason)
      SELECT gen_random_uuid(), $1, $2, 'project', $3, 'Reply ' || i, 'reply' FROM generate_series(1, $4::int) AS i`, [member.id, space.id, projectId, count]);
    await insert(open.id, 3000);
    // Rows about a project the member cannot read stay out of the count, as before.
    await insert(hidden.id, 5);
    // Current statistics, so the planner estimates these rows as PostgreSQL would in use.
    await pool.query('ANALYZE notifications');

    const { result, sent } = await statements(() => notificationRepository(db).listReadable(member.id, 1));
    assert.equal(result.unread, 3000, 'only notifications about readable projects are counted');
    assert.equal(result.items.length, 1);
    const count = sent.find((statement) => /^select count\(\*\) from "notifications"/i.test(statement.text));
    assert.ok(count, 'the unread count is one statement');
    const explained = await explainAnalyze(count);
    const threshold = Number((await pool.query<{ jit_above_cost: string }>('SHOW jit_above_cost')).rows[0]!.jit_above_cost);
    // Before #298 the draft and DM checks were correlated subplans whose estimated cost the planner
    // multiplied by every notification: from about a thousand notifications the estimate crossed
    // jit_above_cost, and every count (the inbox dot, on each navigation) compiled JIT code for
    // about 50 ms to run a query of about 1 ms. As uncorrelated IN (SELECT ...) sets they are
    // hashed once and the estimate stays small.
    assert.ok(explained.Plan['Total Cost'] < threshold, `estimated cost ${explained.Plan['Total Cost']} stays below jit_above_cost ${threshold}`);
    assert.equal(explained.JIT, undefined, 'no JIT compilation');
    assert.deepEqual(subplans(explained.Plan).filter((run) => run.loops > 2), [], 'no source subplan runs per notification');
  });
});

describe('conversation and material pages (#298)', () => {
  test('one page costs the same statements for one conversation or material as for six', async () => {
    const owner = await person('Pages owner');
    const space = await workspace(owner, 'Pages');
    const place = await project(owner, space.id, 'Pages project', 'workspace');
    const principal = { id: owner.id, kind: 'human' as const };
    const store = conversationUseCases(conversationStore(db));
    const start = async (body: string) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation;
    const reply = async (conversationId: string, body: string) => expectStatus(await owner.browser.request('POST',
      `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201);
    const material = async (title: string) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/materials`,
      { body: { clientMutationId: randomUUID(), title, body: `${title} notes` } }), 201);
    const pages = async () => ({
      conversations: await statements(() => store.listConversations(principal, place.id, { limit: 100 })),
      materials: await statements(() => store.listMaterials(principal, place.id, { limit: 100 })),
    });

    const first = await start('Which probe survives a winter outside?');
    await reply(first.id, 'The capacitive one, if the housing is sealed.');
    await reply(first.id, 'Then we order six.');
    await material('Probe datasheet');
    const one = await pages();
    for (let index = 0; index < 5; index += 1) {
      await reply((await start(`Thread ${index}`)).id, `Reply ${index}`);
      await material(`Source ${index}`);
    }
    const six = await pages();

    assert.equal(six.conversations.result.items.length, 6);
    assert.equal(six.materials.result.items.length, 6);
    const summary = six.conversations.result.items.find((item) => item.id === first.id)!;
    assert.equal(summary.firstMessageBody, 'Which probe survives a winter outside?');
    assert.equal(summary.lastMessageBody, 'Then we order six.');
    assert.deepEqual(six.materials.result.items.map((item) => item.title).sort(), ['Probe datasheet', ...[0, 1, 2, 3, 4].map((index) => `Source ${index}`)].sort());
    // Before #298 each conversation added two queries (its first and last message) and each
    // material one (its current version), all sent at once on the shared pool.
    assert.deepEqual({ conversations: six.conversations.sent.length - one.conversations.sent.length, materials: six.materials.sent.length - one.materials.sent.length },
      { conversations: 0, materials: 0 }, 'extra statements for five more rows: a page costs the same however many rows it has');
  });
});

/** A read that holds one read-only snapshot and sends no row-locking clause. */
function assertSnapshotRead(sent: { text: string }[]) {
  const begin = sent.find((statement) => /^begin\b/i.test(statement.text.trim()));
  assert.match(begin?.text ?? '', /repeatable read/i, 'access and page share one snapshot');
  assert.match(begin?.text ?? '', /read only/i);
  // Before #298 these reads share-locked the project, grant and membership rows: each lock is a WAL
  // record, and the commit then waits for the WAL flush, on every open and 15 s refresh.
  assert.deepEqual(sent.filter((statement) => /\bfor (share|update|no key update|key share)\b/i.test(statement.text)).map((statement) => statement.text), []);
}

describe('reads the project views refresh (#298)', () => {
  test('the conversation stream takes no row locks: one read-only snapshot, no WAL, no flush wait', async () => {
    const owner = await person('Stream reader');
    const space = await workspace(owner, 'Stream');
    const place = await project(owner, space.id, 'Stream project', 'workspace');
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Is the gateway on the shed roof yet?', clientMessageId: randomUUID() } }), 201);
    const store = conversationUseCases(conversationStore(db));
    const { result, sent } = await statements(() => store.listRoots({ id: owner.id, kind: 'human' }, place.id, {}));
    assert.equal(result.roots.length, 1);
    assertSnapshotRead(sent);
  });

  test('the comparison outcome page (Tasks) takes no row locks either', async () => {
    const owner = await person('Outcome reader');
    const space = await workspace(owner, 'Outcomes');
    const place = await project(owner, space.id, 'Outcomes project', 'workspace');
    const { result, sent } = await statements(() => comparisonOutcomeReads(db).list({ id: owner.id, kind: 'human' }, place.id, 100, 0));
    assert.deepEqual({ items: result.items, total: result.total }, { items: [], total: 0 });
    assertSnapshotRead(sent);
  });
});
