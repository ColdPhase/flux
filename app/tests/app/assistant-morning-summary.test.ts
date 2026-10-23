import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  ASSISTANT_MORNING_SUMMARY_PATH, NOTIFICATION_PREFERENCES_PATH, PERSONAL_RUN_CONSENT_VERSION, type AssistantMorningSummary, type NotificationPreferences,
  type Project, type Workspace,
} from '@flux/contracts';
import type { PgBoss } from 'pg-boss';
import { createPersonalRunProcessor, PERSONAL_RUN_JOB, PUSH_SEND_JOB, sendMorningSummaries, type PersonalComputeResult, type Principal } from '@flux/core';
import { notificationRows } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { assistantSummaryStart, settleSummaries } from '../../apps/worker/src/assistant/index.js';
import { summaryUnitOfWork } from '../../apps/worker/src/jobs/morning-summary.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { subscribe } from './support/push.js';

// F-027 A8 (#408): the morning summary written by the assistant (AST-7 "The morning summary", AST-7.6). #350's own tick claims
// the day; with "Let your assistant write your morning summary" on it starts one silent run instead of the plain text, and the
// next minute's tick closes it: the line goes under the Home greeting, the one push carries it, the Inbox gets nothing. A run
// that fails sends the plain summary instead. The clock is the `now` of the tick; the provider is a FAKE one.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const DAY = 86_400_000;
const sent: { name: string; data: Record<string, unknown> }[] = [];
const boss = { send: async (name: string, data?: object | null) => { sent.push({ name, data: (data ?? {}) as Record<string, unknown> }); return randomUUID(); } } as unknown as Pick<PgBoss, 'send'>;
const composition = { connections, providerEnabled: true, toolTurns: 1 };
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20 });
const uow = () => summaryUnitOfWork(db, boss, assistantSummaryStart(db, boss, composition));
/** The tick's result with `writing` always present. */
const send = async (now: Date) => ({ writing: 0, ...(await sendMorningSummaries(uow(), now)) });
const pushes = () => sent.filter((job) => job.name === PUSH_SEND_JOB).length;
const processAll = async () => { for (const job of sent.filter((item) => item.name === PERSONAL_RUN_JOB).splice(0)) await processor.process(job.data.runId as string); sent.splice(0, sent.length, ...sent.filter((item) => item.name !== PERSONAL_RUN_JOB)); };
const answer = (text: string) => async (): Promise<PersonalComputeResult> => ({ kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 }, text });
/** 09:05 UTC, `days` from today: ahead of the real clock, so the Compose worker's own #350 tick never claims it. */
function morning(days: number) {
  const base = new Date(Date.now() + days * DAY);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 9, 5));
}
const summaries = async () => (await pool.query(`SELECT day::text AS day, state, line FROM assistant_morning_summaries WHERE owner_user_id = $1 ORDER BY day`, [owner().id])).rows as { day: string; state: string; line: string | null }[];
const kept = async () => (await pool.query(`SELECT title, body, in_inbox, delivery_kind FROM notifications WHERE user_id = $1 AND delivery_kind = 'morning_summary' ORDER BY created_at`, [owner().id])).rows as
  { title: string; body: string; in_inbox: boolean; delivery_kind: string }[];
let me: Person;
const owner = () => me;

describe('the morning summary written by the assistant (F-027 A8, #408, AST-7.6)', () => {
  let peer: Person; let ws: Workspace; let place: Project; let agentId: string; let hidden: Project;
  const runsOf = async () => (await pool.query(`SELECT id, kind, silent, status, prompt FROM personal_runs WHERE owner_user_id = $1 AND kind = 'morning_summary' ORDER BY created_at`, [me.id])).rows as
    { id: string; kind: string; silent: boolean; status: string; prompt: string }[];
  const setByAssistant = async (on: boolean) => expectStatus(await me.browser.request('PUT', ASSISTANT_MORNING_SUMMARY_PATH, { body: { on, timeZone: 'UTC' } }), 200) as unknown;

  before(async () => {
    me = await person('ms-ada'); peer = await person('ms-jonas');
    ws = await createWorkspace(me, 'Mornings');
    await addMember(me, ws.id, peer, 'member');
    place = await createProject(me, ws.id, 'Lamp sensor', 'workspace');
    hidden = await createProject(peer, (expectStatus(await peer.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Jonas lab' } }), 201) as { id: string }).id, 'Secret rig', 'restricted');
    agentId = (expectStatus(await me.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await me.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, { body: { body: 'Camera fails below 5 lux', clientMessageId: randomUUID() } }), 201);
    const connectionId = randomUUID();
    connections.connect(me.id, connectionId);
    await personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true }).enable(human(me), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId, perRunCents: 50, dailyCapCents: 1_000 });
    await subscribe(me.browser);
    // What waits in the inbox: two things Ada can read, and one about a project she cannot.
    const source = { workspaceId: ws.id, type: 'project' as const, id: place.id };
    await notificationRows(db).insert({ id: randomUUID(), userId: me.id, source, title: 'Jonas asked you to review #8', body: '', url: null, aiOrigin: false });
    await notificationRows(db).insert({ id: randomUUID(), userId: me.id, source, title: 'Probe drawing arrived', body: '', url: null, aiOrigin: false });
    await notificationRows(db).insert({ id: randomUUID(), userId: me.id, source: { workspaceId: hidden.workspaceId, type: 'project', id: hidden.id }, title: 'SECRET-TITLE', body: '', url: null, aiOrigin: false });
  });
  beforeEach(async () => {
    compute.dispatched = []; compute.respond = answer('Good morning, Ada. Jonas is waiting on you for #8.');
    sent.length = 0;
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [me.id]);
    await pool.query(`UPDATE personal_runs SET created_at = created_at - interval '2 days' WHERE owner_user_id = $1`, [me.id]);
  });

  test('the Notifications row and the assistant\'s own flow: it turns the summary on, only the assistant\'s flow can turn it on, and turning the summary off turns it off', async () => {
    const refused = await me.browser.request('PATCH', NOTIFICATION_PREFERENCES_PATH, { body: { morningSummary: { byAssistant: true } } });
    assert.deepEqual([refused.status, (refused.json as { code: string }).code], [400, 'INVALID_MORNING_SUMMARY']);
    assert.deepEqual(await setByAssistant(true), { byAssistant: true });
    const prefs = expectStatus(await me.browser.request('GET', NOTIFICATION_PREFERENCES_PATH), 200) as unknown as NotificationPreferences;
    assert.deepEqual([prefs.morningSummary.enabled, prefs.morningSummary.byAssistant, prefs.morningSummary.at], [true, true, '09:00']);
    const home = expectStatus(await me.browser.request('GET', ASSISTANT_MORNING_SUMMARY_PATH), 200) as unknown as AssistantMorningSummary;
    assert.deepEqual(home, { byAssistant: true, line: null, day: null });
    expectStatus(await me.browser.request('PATCH', NOTIFICATION_PREFERENCES_PATH, { body: { morningSummary: { enabled: false } } }), 200);
    assert.equal(((expectStatus(await me.browser.request('GET', NOTIFICATION_PREFERENCES_PATH), 200) as unknown as NotificationPreferences)).morningSummary.byAssistant, false, 'no summary, nothing written by the assistant');
    await setByAssistant(true);
    expectStatus(await me.browser.request('PATCH', NOTIFICATION_PREFERENCES_PATH, { body: { morningSummary: { byAssistant: false } } }), 200);
    assert.equal(((expectStatus(await me.browser.request('GET', NOTIFICATION_PREFERENCES_PATH), 200) as unknown as NotificationPreferences)).morningSummary.enabled, true, 'the plain summary goes on');
    await setByAssistant(true);
    // Never today for the Compose worker: only the controlled days below are claimed.
    await pool.query(`UPDATE notification_preferences SET summary_last_on = current_date WHERE user_id = $1`, [me.id]);
  });

  test('AST-7.6: at the Notifications time exactly one run happens (even with two workers), Home gets its line, the Inbox gets nothing and exactly one push is sent', async () => {
    const day = morning(1);
    assert.deepEqual(await send(new Date(day.getTime() - 20 * 60_000)), { sent: 0, empty: 0, writing: 0 }, 'before the time nothing happens');
    const both = await Promise.all([send(day), send(day)]);
    assert.equal(both.reduce((total, item) => total + item.writing, 0), 1, 'one worker claimed the day');
    const [run] = await runsOf();
    assert.equal((await runsOf()).length, 1, 'one run');
    assert.deepEqual([run!.silent, run!.status], [true, 'queued']);
    assert.match(run!.prompt, /Greeting to start with: Good morning, ms-ada\./);
    assert.match(run!.prompt, /Jonas asked you to review #8/);
    assert.equal(run!.prompt.includes('SECRET-TITLE'), false, 'only what the person can read is given to the run');
    assert.equal(pushes(), 0, 'no push until the line exists');
    assert.equal((await kept()).length, 0);
    assert.deepEqual((await summaries()).map((item) => item.state), ['writing']);

    await processAll();
    assert.equal(compute.dispatched.length, 1);
    assert.equal(compute.dispatched[0]!.tools, undefined, 'a summary has no tools: it changes nothing');
    assert.equal(JSON.stringify(compute.dispatched[0]).includes('SECRET-TITLE'), false);
    const inboxBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND in_inbox`, [me.id])).rows[0].n);
    const settled = await settleSummaries(db, boss, new Date(day.getTime() + 60_000));
    assert.deepEqual(settled, { written: 1, plain: 0 });
    assert.equal(pushes(), 1, 'exactly one push');
    const [note] = await kept();
    assert.deepEqual([note!.title, note!.body, note!.in_inbox], ['Good morning, Ada. Jonas is waiting on you for #8.', 'Your morning summary from Flux', false]);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND in_inbox`, [me.id])).rows[0].n), inboxBefore, 'never an Inbox item');
    assert.deepEqual((await summaries()).map((item) => [item.state, item.line]), [['written', 'Good morning, Ada. Jonas is waiting on you for #8.']]);
    // A second settle, or another worker, sends nothing more.
    assert.deepEqual(await settleSummaries(db, boss, new Date(day.getTime() + 120_000)), { written: 0, plain: 0 });
    assert.equal(pushes(), 1);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM assistant_morning_summaries WHERE owner_user_id = $1`, [me.id])).rows[0].n), 1);

    // Home shows today's line under the greeting, only to its owner, only for today.
    const ownDay = (await pool.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`)).rows[0].day as string;
    await pool.query(`INSERT INTO assistant_morning_summaries (owner_user_id, day, state, line, settled_at) VALUES ($1, $2::date, 'written', 'Good morning, Ada. 2 things wait.', now())`, [me.id, ownDay]);
    const homeLine = expectStatus(await me.browser.request('GET', ASSISTANT_MORNING_SUMMARY_PATH), 200) as unknown as AssistantMorningSummary;
    assert.deepEqual([homeLine.byAssistant, homeLine.line, homeLine.day], [true, 'Good morning, Ada. 2 things wait.', ownDay]);
    const others = expectStatus(await peer.browser.request('GET', ASSISTANT_MORNING_SUMMARY_PATH), 200) as unknown as AssistantMorningSummary;
    assert.deepEqual([others.byAssistant, others.line], [false, null]);
    await pool.query(`DELETE FROM assistant_morning_summaries WHERE owner_user_id = $1 AND day = $2::date`, [me.id, ownDay]);
  });

  test('AST-7.6: with the run failing, the plain #350 summary is sent instead, and still only one push', async () => {
    const day = morning(2);
    compute.respond = async () => ({ kind: 'failed', reason: 'provider_error', billed: 'none' });
    assert.equal((await send(day)).writing, 1);
    await processAll();
    assert.deepEqual(await settleSummaries(db, boss, new Date(day.getTime() + 60_000)), { written: 0, plain: 1 });
    assert.equal(pushes(), 1);
    const note = (await kept()).at(-1)!;
    assert.deepEqual([note.title, note.in_inbox], ['2 things wait in your inbox', false]);
    assert.equal((await summaries()).at(-1)!.state, 'plain');
    assert.deepEqual(await settleSummaries(db, boss, new Date(day.getTime() + 120_000)), { written: 0, plain: 0 });
  });

  test('a run that never started within ten minutes is stopped and the plain summary goes out; a paused assistant sends the plain summary at once', async () => {
    const day = morning(3);
    assert.equal((await send(day)).writing, 1);
    sent.length = 0;
    assert.deepEqual(await settleSummaries(db, boss, new Date()), { written: 0, plain: 0 }, 'still waiting for the lane');
    // Past the wait (the row's own clock is the database's, so age it).
    await pool.query(`UPDATE assistant_morning_summaries SET created_at = now() - interval '11 minutes' WHERE owner_user_id = $1 AND state = 'writing'`, [me.id]);
    assert.deepEqual(await settleSummaries(db, boss, new Date(Date.now() + 12 * 60_000)), { written: 0, plain: 1 });
    assert.equal((await runsOf()).at(-1)!.status, 'stopped');
    assert.equal(pushes(), 1);

    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    const before = (await runsOf()).length;
    await runs.pause(human(me));
    try {
      sent.length = 0;
      assert.deepEqual(await send(morning(4)), { sent: 1, empty: 0, writing: 0 });
      assert.equal(pushes(), 1);
      assert.equal((await runsOf()).length, before, 'no run was started for a paused assistant');
    } finally {
      await runs.resume(human(me));
    }
  });
});
