import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { Conversation } from '@flux/contracts';
import { conversationUseCases } from '@flux/core';
import { notificationRows } from '@flux/db';
import { conversationStore } from '../../apps/server/src/conversation/store.js';
import { inboxAudience, notificationRepository } from '../../apps/server/src/push/adapters.js';
import { pool } from './support/db.js';
import { expectStatus, person, project, workspace } from './support/people.js';
import { explainAnalyze, recordingDatabase, rowsRead, type PlanNode } from './support/statements.js';
import { inboxVolume } from './support/inbox-volume.js';

// Regression tests for the slow paths measured in #298 (docs/development/performance-2026-10.md).
// They assert work that grows with the data (how often a subplan runs, how many statements a
// request sends) rather than wall-clock time, so they hold on a loaded host.

const { db, statements } = recordingDatabase();

describe('inbox unread count (#298)', () => {
  test('follows the reader\'s own notifications, not the workspace\'s DMs and projects, and compiles no JIT', async () => {
    const volume = await inboxVolume();
    const { result, sent } = await statements(() => notificationRepository(db).listReadable(volume.member.id, 1));
    const total = volume.notifications.project + volume.notifications.dm;
    assert.equal(result.unread, total, 'every notification about a readable source is counted');
    const count = sent.find((statement) => /^select count\(\*\) from "notifications"/i.test(statement.text));
    assert.ok(count, 'the unread count is one statement');
    // JIT on for this check, whatever the application's connections use: the plan itself must stay
    // below the JIT thresholds.
    const explained = await explainAnalyze(count, { jit: 'on' });
    const threshold = Number((await pool.query<{ jit_above_cost: string }>('SHOW jit_above_cost')).rows[0]!.jit_above_cost);
    // Before #298 the DM checks were correlated subplans costed once per notification (JIT
    // compiled from about a thousand notifications); 3f6b3207 built the set of every readable DM
    // of the workspace (20,000 rows: 313 ms, mostly JIT). Each set now starts from the
    // reader's own notifications of that kind, so with 20,000 DMs the plan reads
    // only the hundred they are about. All three facts are reported together.
    assert.deepEqual({
      jitFunctions: explained.JIT?.Functions ?? 0,
      costBelowJitThreshold: explained.Plan['Total Cost'] < threshold,
      dmsRead: rowsRead(explained.Plan, 'dms') <= volume.notifications.dm,
    }, { jitFunctions: 0, costBelowJitThreshold: true, dmsRead: true },
    `cost ${explained.Plan['Total Cost']} (jit_above_cost ${threshold}), `
      + `DMs read ${rowsRead(explained.Plan, 'dms')} of ${volume.workspaceRows.dms}`);
  });
});

describe('the Inbox needs read (sweep-34 C1)', () => {
  test('reads only the notifications that can be items, however many ordinary ones are newer, by its partial index and with no JIT', async () => {
    const volume = await inboxVolume();
    // Three mentions older than every one of the member's 2,900 ordinary notifications.
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, reason, ai_origin, created_at)
      SELECT gen_random_uuid(), $1, $2, 'project', id, 'Someone mentioned you', 'mention', false, now() - interval '1 hour'
      FROM (SELECT id FROM projects WHERE workspace_id = $2 ORDER BY id LIMIT 3) AS chosen`, [volume.member.id, volume.workspaceId]);
    await pool.query('ANALYZE notifications');
    const audience = await inboxAudience(db, volume.member.id);
    const since = new Date(Date.now() - 14 * 86_400_000);
    const { result, sent } = await statements(() => notificationRows(db).listNeeds(volume.member.id, audience, { since, keep: [], limit: 400 }));
    assert.deepEqual(result.map((note) => note.reason), ['mention', 'mention', 'mention'], 'the mentions under the flood are found');
    const read = sent.find((statement) => /^select .* from "notifications"/is.test(statement.text) && statement.text.includes("IN ('mention', 'question', 'invitation', 'assigned')"));
    assert.ok(read, 'the needs are one statement');
    const explained = await explainAnalyze(read, { jit: 'on' });
    const threshold = Number((await pool.query<{ jit_above_cost: string }>('SHOW jit_above_cost')).rows[0]!.jit_above_cost);
    const scans: PlanNode[] = [];
    const visit = (node: PlanNode) => { if ((node as PlanNode & { 'Index Name'?: string })['Index Name'] === 'notifications_needs_idx') scans.push(node); node.Plans?.forEach(visit); };
    visit(explained.Plan);
    const needRows = scans.reduce((sum, node) => sum + ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 0), 0);
    // Reported for the record (sweep-34 C1): the time on this host, beside the facts the test holds to.
    console.log(`needs read: ${explained['Execution Time']} ms executing, ${explained['Planning Time']} ms planning, cost ${explained.Plan['Total Cost']}`);
    assert.deepEqual({ byNeedsIndex: scans.length > 0, needRowsRead: needRows, jitFunctions: explained.JIT?.Functions ?? 0, costBelowJitThreshold: explained.Plan['Total Cost'] < threshold },
      { byNeedsIndex: true, needRowsRead: 3, jitFunctions: 0, costBelowJitThreshold: true }, JSON.stringify(explained.Plan).slice(0, 4000));
  });
});

describe('application database connections (#298)', () => {
  test('never JIT-compile: a short statement with an inflated estimate is not compiled', async () => {
    // createDatabase is what the API, the worker and these tests connect with.
    const { rows } = await pool.query<{ jit: string; idle: string }>(
      "SELECT current_setting('jit') AS jit, current_setting('idle_in_transaction_session_timeout') AS idle");
    assert.deepEqual(rows[0], { jit: 'off', idle: '1min' });
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
    // F-030 (S2a): the first read in a process looks the workspace up once to learn it is not encrypted; then never again.
    await pages();
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
});
