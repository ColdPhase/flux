import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, ConversationMessage, Dm, DmMessage, DmTaskCopyPreview, DmTaskCopyResult, DmThread, MessageReceiptsResult, Page, WorkItem, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, removeMember, workspace, type Person } from './support/people.js';

// Private DM reply threads (#536), real viewing receipts (#534) and the explicit excerpt-to-task copy (#537):
// every read, write and receipt asks the current participant row again, so outsiders, nonparticipant managers
// and people who left learn nothing; replies, observations and copies are idempotent and never leak the DM into
// a project.

const dmsOf = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/dms`;

async function openDm(actor: Person, workspaceId: string, others: Person[], title?: string) {
  const response = await actor.browser.request('POST', dmsOf(workspaceId), { body: { participantIds: others.map((o) => o.id), ...(title ? { title } : {}) } });
  assert.ok(response.status === 201 || response.status === 200, `open DM: ${response.status} ${response.text}`);
  return response.json as Dm;
}
const say = async (actor: Person, dmId: string, body: string) =>
  expectStatus(await actor.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201, 'send') as DmMessage;
const replyRaw = (actor: Person, dmId: string, rootId: string, body: string, clientMessageId: string = randomUUID(), headers: Record<string, string> = {}) =>
  actor.browser.request('POST', `/api/v1/dms/${dmId}/threads/${rootId}/replies`, { body: { body, clientMessageId }, headers });
const reply = async (actor: Person, dmId: string, rootId: string, body: string) => expectStatus(await replyRaw(actor, dmId, rootId, body), 201, 'reply') as DmMessage;
const thread = (actor: Person, dmId: string, rootId: string, query = '') => actor.browser.request('GET', `/api/v1/dms/${dmId}/threads/${rootId}${query}`);
const observe = (actor: Person, dmId: string, messageIds: string[]) => actor.browser.request('POST', `/api/v1/dms/${dmId}/observations`, { body: { messageIds } });
const receipts = (actor: Person, dmId: string, runs: string[][]) => actor.browser.request('POST', `/api/v1/dms/${dmId}/receipts`, { body: { runs } });
const read = (actor: Person, dmId: string) => actor.browser.request('GET', `/api/v1/dms/${dmId}`);
const audience = async (objectId: string, kind: string) => {
  const result = await pool.query('SELECT DISTINCT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id WHERE e.object_id = $1 AND e.kind = $2', [objectId, kind]);
  return new Set(result.rows.map((row) => row.recipient as string));
};
const seenNames = async (actor: Person, dmId: string, runs: string[][]) =>
  (expectStatus(await receipts(actor, dmId, runs), 200, 'receipts') as MessageReceiptsResult).runs.map((run) => run.seenBy.map((p) => p.name).sort());

describe('DM reply threads, viewing receipts and task copies', () => {
  let ada: Person; // workspace owner, in no DM below
  let max: Person; // admin, in no DM
  let gus: Person; // guest
  let dave: Person; // another workspace
  let ws: Workspace;

  /** Three fresh members, so each test owns its 1:1 DMs and nothing leaks between them. */
  async function trio() {
    const people = await Promise.all(['th-jo', 'th-kai', 'th-lee'].map(person));
    for (const member of people) await addMember(ada, ws.id, member, 'member');
    return people as [Person, Person, Person];
  }

  before(async () => {
    [ada, max, gus, dave] = await Promise.all(['th-ada', 'th-max', 'th-gus', 'th-dave'].map(person));
    ws = await workspace(ada, 'Makers');
    await workspace(dave, 'Elsewhere');
    await addMember(ada, ws.id, max, 'admin');
    await addMember(ada, ws.id, gus, 'guest');
  });

  describe('private reply threads (#536)', () => {
    test('replies persist, count and page, and stay out of the main window', async () => {
      const [jo, kai, lee] = await trio();
      const dm = await openDm(jo, ws.id, [kai, lee], 'Lamp crew');
      const root = await say(jo, dm.id, 'Wave to dim?');
      const other1 = await say(kai, dm.id, 'Unrelated');
      assert.equal(root.threadRootId, null);
      const first = await reply(kai, dm.id, root.id, 'Yes, wave.');
      assert.equal(first.threadRootId, root.id);
      assert.equal(first.replyCount, 0);
      await reply(lee, dm.id, root.id, 'Or a knob.');
      const last = await reply(jo, dm.id, root.id, 'Knob it is.');

      const main = expectStatus(await read(kai, dm.id), 200) as Dm;
      assert.deepEqual(main.messages.map((m) => m.id), [root.id, other1.id], 'replies are not in the conversation window');
      assert.equal(main.messages[0]!.replyCount, 3, 'the root carries the thread size');
      assert.equal(main.messages[1]!.replyCount, 0);

      const opened = expectStatus(await thread(lee, dm.id, root.id), 200) as DmThread;
      assert.equal(opened.root.id, root.id);
      assert.deepEqual(opened.replies.map((m) => m.body), ['Yes, wave.', 'Or a knob.', 'Knob it is.']);
      assert.equal(opened.messagePage.hasMoreBefore, false);
      const paged = expectStatus(await thread(jo, dm.id, root.id, '?limit=2'), 200) as DmThread;
      assert.deepEqual(paged.replies.map((m) => m.id), [opened.replies[1]!.id, last.id]);
      assert.equal(paged.messagePage.hasMoreBefore, true);
      const older = expectStatus(await thread(jo, dm.id, root.id, `?beforeSequence=${paged.messagePage.nextBeforeSequence}`), 200) as DmThread;
      assert.deepEqual(older.replies.map((m) => m.id), [first.id]);

      // The list preview and search keep the participants' audience (the DM's own); the DM sequence is shared.
      assert.ok(last.sequence > other1.sequence);
    });

    test('a retry returns the original reply; the same client id cannot be reused for another thread or text; concurrent retries store one', async () => {
      const [jo, kai] = await trio();
      const dm = await openDm(jo, ws.id, [kai]);
      const a = await say(jo, dm.id, 'First root');
      const b = await say(jo, dm.id, 'Second root');
      const clientMessageId = randomUUID();
      const one = expectStatus(await replyRaw(kai, dm.id, a.id, 'Same', clientMessageId), 201) as DmMessage;
      const again = expectStatus(await replyRaw(kai, dm.id, a.id, 'Same', clientMessageId), 201) as DmMessage;
      assert.equal(again.id, one.id);
      const textConflict = await replyRaw(kai, dm.id, a.id, 'Other text', clientMessageId);
      expectStatus(textConflict, 409);
      assert.equal((textConflict.json as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
      const rootConflict = await replyRaw(kai, dm.id, b.id, 'Same', clientMessageId);
      assert.equal((rootConflict.json as { code: string }).code, 'IDEMPOTENCY_CONFLICT', 'another thread is another request');

      const raced = randomUUID();
      const results = await Promise.all([...Array(6)].map(() => replyRaw(kai, dm.id, b.id, 'Raced', raced)));
      assert.ok(results.every((r) => r.status === 201));
      assert.equal(new Set(results.map((r) => (r.json as DmMessage).id)).size, 1);
      const rows = await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id = $1 AND client_message_id = $2', [dm.id, raced]);
      assert.equal(rows.rows[0].n, 1);

      // An Idempotency-Key replay returns the stored answer without storing again.
      const key = randomUUID();
      const sameClient = randomUUID();
      const k1 = await replyRaw(jo, dm.id, a.id, 'Keyed', sameClient, { 'idempotency-key': key });
      const k2 = await replyRaw(jo, dm.id, a.id, 'Keyed', sameClient, { 'idempotency-key': key });
      assert.equal(k1.status, 201);
      assert.equal(k2.status, 201);
      assert.equal((k2.json as DmMessage).id, (k1.json as DmMessage).id);
    });

    test('only current participants read or write a thread: owner, admin, member, guest, other tenant and cross-DM ids get 404', async () => {
      const [jo, kai, lee] = await trio();
      const dm = await openDm(jo, ws.id, [kai]);
      const root = await say(jo, dm.id, 'Private root');
      await reply(kai, dm.id, root.id, 'Private reply');
      for (const [who, label] of [[ada, 'owner'], [max, 'admin'], [lee, 'member'], [gus, 'guest'], [dave, 'other tenant']] as const) {
        const denied = await thread(who, dm.id, root.id);
        expectStatus(denied, 404, `${label} reads`);
        assert.ok(!denied.text.includes('Private'), `${label} learns no content`);
        expectStatus(await replyRaw(who, dm.id, root.id, 'hello'), 404, `${label} replies`);
      }
      // A thread of another DM, a reply used as a root, and a made-up id all look like a missing message.
      const elsewhere = await openDm(jo, ws.id, [lee]);
      const foreignRoot = await say(jo, elsewhere.id, 'Another DM');
      expectStatus(await thread(jo, dm.id, foreignRoot.id), 404, 'cross-DM root read');
      expectStatus(await replyRaw(jo, dm.id, foreignRoot.id, 'forged'), 404, 'cross-DM root reply');
      const aReply = (expectStatus(await thread(jo, dm.id, root.id), 200) as DmThread).replies[0]!;
      expectStatus(await replyRaw(jo, dm.id, aReply.id, 'nested'), 404, 'a reply is not a root');
      expectStatus(await thread(jo, dm.id, aReply.id), 404, 'a reply is not a thread');
      expectStatus(await replyRaw(jo, dm.id, randomUUID(), 'ghost'), 404, 'unknown root');
      const count = await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id = $1 AND thread_root_id IS NOT NULL', [dm.id]);
      assert.equal(count.rows[0].n, 1, 'nothing was stored by a refused request');
      // The schema itself refuses a reply to a reply, and a reply into another DM's root.
      await assert.rejects(pool.query(`INSERT INTO dm_messages(id, workspace_id, dm_id, author_id, client_message_id, request_fingerprint, sequence, body, thread_root_id)
        VALUES ($1, $2, $3, $4, $5, 'x', 900, 'x', $6)`, [randomUUID(), ws.id, dm.id, jo.id, randomUUID(), aReply.id]), /another thread/);
      await assert.rejects(pool.query(`INSERT INTO dm_messages(id, workspace_id, dm_id, author_id, client_message_id, request_fingerprint, sequence, body, thread_root_id)
        VALUES ($1, $2, $3, $4, $5, 'x', 901, 'x', $6)`, [randomUUID(), ws.id, dm.id, jo.id, randomUUID(), foreignRoot.id]), /thread_root_fk/);
    });

    test('leaving, removal and the pair-recipient-left rule end access on the next request; events reach current participants only', async () => {
      const [jo, kai, lee] = await trio();
      const group = await openDm(jo, ws.id, [kai, lee], 'Trio');
      const root = await say(jo, group.id, 'Trio root');
      const r1 = await reply(kai, group.id, root.id, 'Kai reply');
      assert.deepEqual(await audience(group.id, 'dm.message_sent.v1'), new Set([`human:${jo.id}`, `human:${kai.id}`, `human:${lee.id}`]));
      const eventData = await pool.query(`SELECT data FROM events WHERE object_id = $1 AND kind = 'dm.message_sent.v1' ORDER BY seq DESC LIMIT 1`, [group.id]);
      assert.deepEqual(eventData.rows[0].data, { messageId: r1.id, rootId: root.id }, 'identifiers only, never content');

      expectStatus(await lee.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 204);
      expectStatus(await thread(lee, group.id, root.id), 404, 'left: read');
      expectStatus(await replyRaw(lee, group.id, root.id, 'back?'), 404, 'left: reply');
      const kept = expectStatus(await thread(jo, group.id, root.id), 200) as DmThread;
      assert.equal(kept.replies.length, 1, 'the remaining people keep the thread');

      // Removal from the workspace ends access the same way.
      await removeMember(ada, ws.id, kai);
      expectStatus(await thread(kai, group.id, root.id), 404, 'removed: read');
      expectStatus(await replyRaw(kai, group.id, root.id, 'hi'), 404, 'removed: reply');
      await addMember(ada, ws.id, kai, 'member');
      expectStatus(await thread(kai, group.id, root.id), 404, 'readded to the workspace is not readded to the DM');

      // A 1:1 whose other person left: reading stays, replying does not, and nothing is stored.
      const pair = await openDm(jo, ws.id, [lee]);
      const pairRoot = await say(lee, pair.id, 'Pair root');
      await reply(jo, pair.id, pairRoot.id, 'Before leaving');
      expectStatus(await lee.browser.request('POST', `/api/v1/dms/${pair.id}/leave`), 204);
      const before = (await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id = $1', [pair.id])).rows[0].n;
      const refused = await replyRaw(jo, pair.id, pairRoot.id, 'Anyone there?');
      expectStatus(refused, 409);
      assert.equal((refused.json as { code: string }).code, 'DM_RECIPIENT_LEFT');
      expectStatus(await thread(jo, pair.id, pairRoot.id), 200, 'the remaining person still reads');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id = $1', [pair.id])).rows[0].n, before);
    });

    test('a participant leaving while a reply is sent either stores it before leaving or refuses it', async () => {
      const [jo, kai, lee] = await trio();
      const group = await openDm(jo, ws.id, [kai, lee], 'Race');
      const root = await say(jo, group.id, 'Race root');
      const [sent, left] = await Promise.all([replyRaw(lee, group.id, root.id, 'Racing'), lee.browser.request('POST', `/api/v1/dms/${group.id}/leave`)]);
      assert.ok(sent.status === 201 || sent.status === 404);
      assert.equal(left.status === 204 || left.status === 404, true);
      const stored = (await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id = $1 AND author_id = $2 AND thread_root_id IS NOT NULL', [group.id, lee.id])).rows[0].n;
      assert.equal(stored, sent.status === 201 ? 1 : 0);
      expectStatus(await thread(lee, group.id, root.id), 404, 'after the race lee is out');
    });
  });

  describe('viewing receipts (#534)', () => {
    test('"Seen by" is the intersection of current participants who observed every message of the run', async () => {
      const [jo, kai, lee] = await trio();
      const dm = await openDm(jo, ws.id, [kai, lee], 'Receipts');
      const m1 = await say(jo, dm.id, 'one');
      const m2 = await say(jo, dm.id, 'two');
      const m3 = await say(jo, dm.id, 'three');
      assert.deepEqual(await seenNames(jo, dm.id, [[m1.id, m2.id, m3.id]]), [[]], 'nobody observed anything yet');

      // Reading only the last message, or a high sequence, proves nothing about the others.
      expectStatus(await observe(lee, dm.id, [m3.id]), 200);
      assert.deepEqual(await seenNames(jo, dm.id, [[m1.id, m2.id, m3.id], [m3.id]]), [[], ['th-lee']]);

      assert.deepEqual((expectStatus(await observe(kai, dm.id, [m1.id, m2.id, m3.id]), 200) as { observed: number }).observed, 3);
      expectStatus(await observe(lee, dm.id, [m1.id]), 200);
      assert.deepEqual(await seenNames(jo, dm.id, [[m1.id, m2.id, m3.id], [m1.id, m2.id], [m1.id]]), [['th-kai'], ['th-kai'], ['th-kai', 'th-lee']]);
      expectStatus(await observe(lee, dm.id, [m2.id]), 200);
      assert.deepEqual(await seenNames(jo, dm.id, [[m1.id, m2.id, m3.id]]), [['th-kai', 'th-lee']]);

      // Idempotent: a retry, a second tab or a concurrent burst writes no second row and announces nothing.
      assert.equal((expectStatus(await observe(kai, dm.id, [m1.id, m2.id]), 200) as { observed: number }).observed, 0);
      const burst = await Promise.all([...Array(5)].map(() => observe(lee, dm.id, [m1.id, m2.id, m3.id])));
      assert.ok(burst.every((r) => r.status === 200));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM dm_message_observations WHERE dm_id = $1', [dm.id])).rows[0].n, 6);
      // Reload: the same canonical state.
      assert.deepEqual(await seenNames(jo, dm.id, [[m1.id, m2.id, m3.id]]), [['th-kai', 'th-lee']]);

      // Own messages are never observed; the author is not named; the events carry no content and only participants.
      assert.equal((expectStatus(await observe(jo, dm.id, [m1.id]), 200) as { observed: number }).observed, 0);
      assert.deepEqual(await audience(dm.id, 'dm.observed.v1'), new Set([`human:${jo.id}`, `human:${kai.id}`, `human:${lee.id}`]));
      const data = await pool.query(`SELECT data FROM events WHERE object_id = $1 AND kind = 'dm.observed.v1'`, [dm.id]);
      assert.ok(data.rows.every((row) => Object.keys(row.data).length === 0));
    });

    test('runs are checked against the stored messages: skipped, foreign, mixed-author and non-own runs are refused', async () => {
      const [jo, kai] = await trio();
      const dm = await openDm(jo, ws.id, [kai]);
      const a1 = await say(jo, dm.id, 'a1');
      const a2 = await say(jo, dm.id, 'a2');
      const b1 = await say(kai, dm.id, 'b1');
      const a3 = await say(jo, dm.id, 'a3');
      const code = (r: { json: unknown }) => (r.json as { code: string }).code;
      assert.equal(code(expectStatus2(await receipts(jo, dm.id, [[a1.id, a3.id]]), 422)), 'RECEIPT_RUN_INVALID', 'a run cannot skip a message');
      assert.equal(code(expectStatus2(await receipts(jo, dm.id, [[a2.id, b1.id]]), 422)), 'RECEIPT_RUN_INVALID', 'two authors are not one run');
      assert.equal(code(expectStatus2(await receipts(kai, dm.id, [[a1.id, a2.id]]), 422)), 'RECEIPT_RUN_INVALID', 'only your own runs show Seen by');
      expectStatus(await receipts(jo, dm.id, [[a1.id, a2.id]]), 200);
      // A thread reply belongs to its own level: it cannot join a run of roots.
      const rep = await reply(jo, dm.id, a1.id, 'in thread');
      assert.equal(code(expectStatus2(await receipts(jo, dm.id, [[a1.id, rep.id]]), 422)), 'RECEIPT_RUN_INVALID');
      expectStatus(await receipts(jo, dm.id, [[rep.id]]), 200);
      // Roots keep their run when a reply by someone else sits between them.
      const b2 = await say(jo, dm.id, 'b2');
      const bReply = await reply(kai, dm.id, b2.id, 'kai thread reply');
      const b3 = await say(jo, dm.id, 'b3');
      expectStatus(await receipts(jo, dm.id, [[b2.id, b3.id]]), 200);
      expectStatus(await observe(kai, dm.id, [b2.id, b3.id, bReply.id]), 200);
      assert.deepEqual(await seenNames(jo, dm.id, [[b2.id, b3.id]]), [['th-kai']]);
      expectStatus(await receipts(jo, dm.id, []), 400);
    });

    test('the viewer is the session: forged viewers, outsiders, foreign DM ids and guessed ids are refused and write nothing', async () => {
      const [jo, kai, lee] = await trio();
      const dm = await openDm(jo, ws.id, [kai]);
      const elsewhere = await openDm(jo, ws.id, [lee]);
      const mine = await say(jo, dm.id, 'mine');
      const foreign = await say(jo, elsewhere.id, 'elsewhere');
      const forged = await kai.browser.request('POST', `/api/v1/dms/${dm.id}/observations`, { body: { messageIds: [mine.id], viewerId: jo.id } });
      // The body's extra field is dropped by the schema: the viewer can only ever be the session's person.
      expectStatus(forged, 200, 'a forged viewerId is ignored');
      const viewers = await pool.query('SELECT viewer_id FROM dm_message_observations WHERE message_id = $1', [mine.id]);
      assert.deepEqual(viewers.rows.map((row) => row.viewer_id), [kai.id], 'the observation belongs to the caller, never to the nominated viewer');
      await pool.query('DELETE FROM dm_message_observations WHERE message_id = $1', [mine.id]);
      const before = (await pool.query('SELECT count(*)::int AS n FROM dm_message_observations')).rows[0].n;
      for (const [who, label] of [[ada, 'owner'], [max, 'admin'], [lee, 'non-participant member'], [gus, 'guest'], [dave, 'other tenant']] as const) {
        expectStatus(await observe(who, dm.id, [mine.id]), 404, `${label} observes`);
        expectStatus(await receipts(who, dm.id, [[mine.id]]), 404, `${label} reads receipts`);
      }
      expectStatus(await observe(kai, dm.id, [foreign.id]), 404, 'another DM’s message');
      expectStatus(await observe(kai, dm.id, [mine.id, randomUUID()]), 404, 'a guessed id refuses the whole request');
      expectStatus(await receipts(jo, dm.id, [[foreign.id]]), 404, 'receipts for another DM’s message');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM dm_message_observations')).rows[0].n, before, 'nothing was written');
    });

    test('former participants never appear, whatever they observed; revocation and observation race safely', async () => {
      const [jo, kai, lee] = await trio();
      const dm = await openDm(jo, ws.id, [kai, lee], 'Revocation');
      const m = await say(jo, dm.id, 'hello');
      expectStatus(await observe(kai, dm.id, [m.id]), 200);
      expectStatus(await observe(lee, dm.id, [m.id]), 200);
      assert.deepEqual(await seenNames(jo, dm.id, [[m.id]]), [['th-kai', 'th-lee']]);
      expectStatus(await lee.browser.request('POST', `/api/v1/dms/${dm.id}/leave`), 204);
      assert.deepEqual(await seenNames(jo, dm.id, [[m.id]]), [['th-kai']], 'a person who left is no longer named');
      expectStatus(await observe(lee, dm.id, [m.id]), 404, 'and cannot observe any more');
      await removeMember(ada, ws.id, kai);
      assert.deepEqual(await seenNames(jo, dm.id, [[m.id]]), [[]], 'a removed member is no longer named');
      await addMember(ada, ws.id, kai, 'member');
      assert.deepEqual(await seenNames(jo, dm.id, [[m.id]]), [[]], 'and is not named again by rejoining the workspace');

      // A concurrent leave and observation: the leaver is never named, whichever commits first.
      const group = await openDm(jo, ws.id, [lee, kai], 'Pair-race');
      const racing = await say(jo, group.id, 'racing');
      const [obs] = await Promise.all([observe(lee, group.id, [racing.id]), lee.browser.request('POST', `/api/v1/dms/${group.id}/leave`)]);
      assert.ok(obs.status === 200 || obs.status === 404);
      assert.deepEqual(await seenNames(jo, group.id, [[racing.id]]), [[]]);
    });
  });

  describe('explicit excerpt to a project task (#537)', () => {
    const tasks = async (actor: Person, projectId: string) => (expectStatus(await actor.browser.request('GET', `/api/v1/projects/${projectId}/work?limit=100`), 200) as Page<WorkItem>).items;
    const preview = (actor: Person, dmId: string, body: Record<string, unknown>) => actor.browser.request('POST', `/api/v1/dms/${dmId}/task-copy/preview`, { body });
    const commit = (actor: Person, dmId: string, body: Record<string, unknown>, key: string = randomUUID()) =>
      actor.browser.request('POST', `/api/v1/dms/${dmId}/task-copies`, { body, headers: { 'idempotency-key': key } });
    const bodyOf = (p: DmTaskCopyPreview, extra: Record<string, unknown> = {}) => ({ messageId: p.messageId, excerpt: p.excerpt, projectId: p.project!.id, token: p.token, clientCommandId: randomUUID(), ...extra });

    test('preview shows the exact excerpt, destination and audience and writes nothing; commit copies only the excerpt, with no source', async () => {
      const [jo, kai, lee] = await trio();
      const lamp = await project(ada, ws.id, 'Lamp', 'workspace');
      const dm = await openDm(jo, ws.id, [kai]);
      const message = await say(kai, dm.id, 'Buy tulips. Water daily. Secret: the budget is 900.');
      const before = await tasks(ada, lamp.id);
      const eventsBefore = (await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n;

      const shown = expectStatus(await preview(jo, dm.id, { messageId: message.id, excerpt: 'Buy tulips.', projectId: lamp.id }), 200) as DmTaskCopyPreview;
      assert.equal(shown.excerpt, 'Buy tulips.');
      assert.equal(shown.project?.name, 'Lamp');
      const names = shown.audience.map((p) => p.name);
      assert.ok(names.includes('th-ada') && names.includes('th-jo') && names.includes('th-kai'), `the project's people are listed: ${names}`);
      assert.ok(shown.projects.some((p) => p.id === lamp.id));
      assert.equal((await tasks(ada, lamp.id)).length, before.length, 'preview writes no task');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n, eventsBefore, 'preview records no event');

      const made = expectStatus(await commit(jo, dm.id, bodyOf(shown)), 201) as DmTaskCopyResult;
      assert.equal(made.task.title, 'Buy tulips.');
      assert.equal(made.task.outcome, 'Buy tulips.');
      assert.equal(made.project.id, lamp.id);
      const text = JSON.stringify(made);
      for (const secret of ['Water daily', 'budget', dm.id, message.id, 'th-kai', kai.id]) assert.ok(!text.includes(secret), `the response never carries ${secret}`);
      // A nonparticipant destination reader sees the excerpt and who copied it, nothing of the DM.
      const seen = (await tasks(ada, lamp.id)).find((t) => t.id === made.task.id)!;
      assert.equal(seen.outcome, 'Buy tulips.');
      assert.equal(seen.createdBy.id, jo.id, 'copied by');
      assert.deepEqual(seen.links, [], 'no live link to the private source');
      const seenText = JSON.stringify(seen);
      for (const secret of ['Water daily', 'budget', dm.id, message.id, 'th-kai', kai.id]) assert.ok(!seenText.includes(secret), `the task as another reader sees it never carries ${secret}`);
      const leaked = await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind NOT LIKE 'dm.%' AND (data::text LIKE $1 OR data::text LIKE $2)`, [`%${message.id}%`, `%${dm.id}%`]);
      assert.equal(leaked.rows[0].n, 0, 'no project event names the private message or DM');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM events WHERE object_id = $1 AND kind LIKE 'dm.%' AND data::text LIKE '%Buy tulips%'`, [dm.id])).rows[0].n, 0);
      // The copy grants the DM's participants nothing and its outsiders nothing.
      expectStatus(await lee.browser.request('GET', `/api/v1/dms/${dm.id}`), 404);
    });

    test('authority: outsiders, nonparticipant managers, other DMs’ messages and read-only destinations are refused', async () => {
      const [jo, kai, lee] = await trio();
      const lamp = await project(ada, ws.id, 'Lamp 2', 'workspace');
      const dm = await openDm(jo, ws.id, [kai]);
      const m = await say(jo, dm.id, 'Make a tulip task');
      const elsewhere = await openDm(jo, ws.id, [lee]);
      const foreign = await say(jo, elsewhere.id, 'Another DM text');
      for (const [who, label] of [[ada, 'owner'], [max, 'admin'], [lee, 'member'], [dave, 'other tenant']] as const) {
        expectStatus(await preview(who, dm.id, { messageId: m.id, projectId: lamp.id }), 404, `${label} previews`);
        expectStatus(await commit(who, dm.id, { messageId: m.id, excerpt: 'Make a tulip task', projectId: lamp.id, token: 'x', clientCommandId: randomUUID() }), 404, `${label} commits`);
      }
      expectStatus(await preview(jo, dm.id, { messageId: foreign.id, projectId: lamp.id }), 404, 'a forged message id from another DM');
      const empty = expectStatus(await preview(jo, dm.id, { messageId: m.id }), 200) as DmTaskCopyPreview;
      assert.ok(empty.project, 'a default project is proposed');
      expectStatus(await preview(jo, dm.id, { messageId: m.id, excerpt: 'something never said', projectId: lamp.id }), 422, 'not in the message');
      // A destination the caller can only read.
      const quiet = await project(ada, ws.id, 'Read only', 'restricted');
      await grant(ada, quiet.id, jo, 'viewer');
      expectStatus(await preview(jo, dm.id, { messageId: m.id, projectId: quiet.id }), 403, 'viewer destination');
      const ok = expectStatus(await preview(jo, dm.id, { messageId: m.id, projectId: lamp.id }), 200) as DmTaskCopyPreview;
      expectStatus(await commit(jo, dm.id, bodyOf(ok, { projectId: quiet.id })), 403, 'commit to a read-only destination');
      assert.equal((await tasks(ada, quiet.id)).length, 0);
      // The token is bound to this exact preview.
      expectStatus(await commit(jo, dm.id, bodyOf(ok, { token: 'forged' })), 409, 'forged token');
    });

    test('a changed audience or text needs a fresh preview; cancel and failures leave nothing; a lost response creates one task', async () => {
      const [jo, kai, lee] = await trio();
      const lamp = await project(ada, ws.id, 'Lamp 3', 'restricted');
      await grant(ada, lamp.id, jo, 'contributor');
      const dm = await openDm(jo, ws.id, [kai]);
      const m = await say(jo, dm.id, 'Stale test');
      const stale = expectStatus(await preview(jo, dm.id, { messageId: m.id, projectId: lamp.id }), 200) as DmTaskCopyPreview;
      await grant(ada, lamp.id, lee, 'contributor');
      const changed = await commit(jo, dm.id, bodyOf(stale));
      expectStatus(changed, 409);
      assert.equal((changed.json as { code: string }).code, 'TASK_COPY_CHANGED');
      const fresh = (changed.json as { preview: DmTaskCopyPreview }).preview;
      assert.ok(fresh.audience.some((p) => p.id === lee.id), 'the fresh preview names the new reader');
      assert.equal((await tasks(ada, lamp.id)).length, 0, 'nothing was created');

      const body = bodyOf(fresh);
      const key = randomUUID();
      const [one, two] = await Promise.all([commit(jo, dm.id, body, key), commit(jo, dm.id, body, key)]);
      assert.ok([one, two].every((r) => r.status === 201), `${one.status} ${two.status}`);
      assert.equal((one.json as DmTaskCopyResult).task.id, (two.json as DmTaskCopyResult).task.id);
      // The same retry identity with another key (a lost response and a new request) still creates one task.
      const third = await commit(jo, dm.id, body);
      assert.equal(third.status, 201);
      assert.equal((third.json as DmTaskCopyResult).task.id, (one.json as DmTaskCopyResult).task.id);
      assert.equal((await tasks(ada, lamp.id)).length, 1);
      // The same command id for different text is a conflict, not a second task.
      const m2 = await say(jo, dm.id, 'Other text entirely');
      const other2 = expectStatus(await preview(jo, dm.id, { messageId: m2.id, projectId: lamp.id }), 200) as DmTaskCopyPreview;
      const conflict = await commit(jo, dm.id, bodyOf(other2, { clientCommandId: body.clientCommandId }));
      assert.equal(conflict.status, 409);
      assert.equal((await tasks(ada, lamp.id)).length, 1);
    });

    test('a reply bubble can be copied too; a 1:1 whose other person left refuses; removal during a copy leaves no task for the removed person', async () => {
      const [jo, kai, lee] = await trio();
      const lamp = await project(ada, ws.id, 'Lamp 4', 'workspace');
      const dm = await openDm(jo, ws.id, [kai]);
      const root = await say(jo, dm.id, 'Root for thread');
      const rep = await reply(kai, dm.id, root.id, 'Reply worth a task');
      const shown = expectStatus(await preview(jo, dm.id, { messageId: rep.id, projectId: lamp.id }), 200) as DmTaskCopyPreview;
      assert.equal(shown.excerpt, 'Reply worth a task');
      expectStatus(await commit(jo, dm.id, bodyOf(shown)), 201);

      const racer = await person('th-racer');
      await addMember(ada, ws.id, racer, 'member');
      const pairRace = await openDm(racer, ws.id, [lee]);
      const msg = await say(lee, pairRace.id, 'Racing copy');
      const racePreview = expectStatus(await preview(racer, pairRace.id, { messageId: msg.id, projectId: lamp.id }), 200) as DmTaskCopyPreview;
      const [copied, removed] = await Promise.all([commit(racer, pairRace.id, bodyOf(racePreview)), ada.browser.request('DELETE', `/api/v1/workspaces/${ws.id}/members/${racer.id}`)]);
      assert.ok(copied.status === 201 || copied.status === 404 || copied.status === 403, `${copied.status} ${copied.text}`);
      assert.equal(removed.status, 204);
      const racerTasks = (await tasks(ada, lamp.id)).filter((t) => t.createdBy.id === racer.id).length;
      assert.equal(racerTasks, copied.status === 201 ? 1 : 0, 'a refused copy leaves no task');

      expectStatus(await kai.browser.request('POST', `/api/v1/dms/${dm.id}/leave`), 204);
      const gone = await preview(jo, dm.id, { messageId: root.id, projectId: lamp.id });
      expectStatus(gone, 409);
      assert.equal((gone.json as { code: string }).code, 'DM_RECIPIENT_LEFT');
    });
  });

  describe('project conversation receipts (#534)', () => {
    const projectPath = (projectId: string) => `/api/v1/projects/${projectId}`;
    const startRoot = async (actor: Person, projectId: string, body: string) =>
      (expectStatus(await actor.browser.request('POST', `${projectPath(projectId)}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201, 'start') as Conversation);
    const replyIn = async (actor: Person, conversationId: string, body: string) =>
      expectStatus(await actor.browser.request('POST', `/api/v1/conversations/${conversationId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201, 'reply') as ConversationMessage;
    const seeP = (actor: Person, projectId: string, ids: string[]) => actor.browser.request('POST', `${projectPath(projectId)}/observations`, { body: { messageIds: ids } });
    const receiptsP = (actor: Person, projectId: string, runs: string[][]) => actor.browser.request('POST', `${projectPath(projectId)}/receipts`, { body: { runs } });
    const namesP = async (actor: Person, projectId: string, runs: string[][]) =>
      (expectStatus(await receiptsP(actor, projectId, runs), 200, 'project receipts') as MessageReceiptsResult).runs.map((run) => run.seenBy.map((p) => p.name).sort());

    test('roots and thread replies: Seen by needs every message of the run, only current readers are named, and access is exact', async () => {
      const [jo, kai, lee] = await trio();
      const outsider = (await trio())[0];
      const lamp = await project(ada, ws.id, 'Receipts project', 'restricted');
      await grant(ada, lamp.id, jo, 'contributor');
      await grant(ada, lamp.id, kai, 'contributor');
      await grant(ada, lamp.id, lee, 'viewer');
      const r1 = await startRoot(jo, lamp.id, 'First root');
      const r2 = await startRoot(jo, lamp.id, 'Second root');
      const m1 = r1.messages[0]!;
      const m2 = r2.messages[0]!;
      assert.deepEqual(await namesP(jo, lamp.id, [[m1.id, m2.id]]), [[]]);
      expectStatus(await seeP(kai, lamp.id, [m2.id]), 200);
      assert.deepEqual(await namesP(jo, lamp.id, [[m1.id, m2.id], [m2.id]]), [[], ['th-kai']], 'one message of a run is not the run');
      expectStatus(await seeP(kai, lamp.id, [m1.id, m2.id]), 200);
      expectStatus(await seeP(lee, lamp.id, [m1.id, m2.id]), 200);
      assert.deepEqual(await namesP(jo, lamp.id, [[m1.id, m2.id]]), [['th-kai', 'th-lee']], 'a read-only reader is a reader');
      assert.equal((expectStatus(await seeP(kai, lamp.id, [m1.id]), 200) as { observed: number }).observed, 0, 'idempotent');

      // Thread replies are their own level, within one conversation.
      const a1 = await replyIn(jo, r1.id, 'reply one');
      const a2 = await replyIn(jo, r1.id, 'reply two');
      expectStatus(await seeP(kai, lamp.id, [a1.id]), 200);
      assert.deepEqual(await namesP(jo, lamp.id, [[a1.id, a2.id], [a1.id]]), [[], ['th-kai']]);
      expectStatus(await seeP(kai, lamp.id, [a2.id]), 200);
      assert.deepEqual(await namesP(jo, lamp.id, [[a1.id, a2.id]]), [['th-kai']]);

      // Runs are checked against the stored messages.
      const code = (r: { json: unknown }) => (r.json as { code: string }).code;
      const k1 = await startRoot(kai, lamp.id, 'Kai root between');
      const r3 = await startRoot(jo, lamp.id, 'Third root');
      assert.equal(code(expectStatus2(await receiptsP(jo, lamp.id, [[m2.id, r3.messages[0]!.id]]), 422)), 'RECEIPT_RUN_INVALID', 'a run cannot skip a root of someone else');
      assert.equal(code(expectStatus2(await receiptsP(jo, lamp.id, [[m1.id, a1.id]]), 422)), 'RECEIPT_RUN_INVALID', 'a root and a reply are different places');
      assert.equal(code(expectStatus2(await receiptsP(kai, lamp.id, [[m1.id, m2.id]]), 422)), 'RECEIPT_RUN_INVALID', 'only your own runs');
      expectStatus(await receiptsP(kai, lamp.id, [[k1.messages[0]!.id]]), 200);

      // The viewer is the session; guessed, foreign and outsider requests are refused and write nothing.
      const before = (await pool.query('SELECT count(*)::int AS n FROM project_message_observations')).rows[0].n;
      expectStatus(await outsiderObserve(outsider), 404);
      expectStatus(await seeP(outsider, lamp.id, [m1.id]), 404, 'a member without a grant');
      expectStatus(await receiptsP(outsider, lamp.id, [[m1.id]]), 404);
      expectStatus(await seeP(dave, lamp.id, [m1.id]), 404, 'another tenant');
      expectStatus(await seeP(kai, lamp.id, [m1.id, randomUUID()]), 404, 'a guessed id');
      const other = await project(ada, ws.id, 'Another project', 'workspace');
      const foreign = (await startRoot(ada, other.id, 'Elsewhere')).messages[0]!;
      expectStatus(await seeP(kai, lamp.id, [foreign.id]), 404, 'a message of another project');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_message_observations')).rows[0].n, before);

      // Revoked readers are never named, whatever they saw; they cannot observe any more.
      await grant(ada, lamp.id, kai, 'denied');
      assert.deepEqual(await namesP(jo, lamp.id, [[m1.id, m2.id], [a1.id, a2.id]]), [['th-lee'], []]);
      expectStatus(await seeP(kai, lamp.id, [m1.id]), 404, 'revoked: observe');
      async function outsiderObserve(who: Person) { return who.browser.request('POST', `${projectPath(lamp.id)}/observations`, { body: { messageIds: [m1.id], viewerId: jo.id } }); }
    });
  });
});

function expectStatus2<T extends { status: number; text: string }>(response: T, status: number): T {
  assert.equal(response.status, status, response.text);
  return response;
}

