import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assistantJobHistoryPath, assistantJobNotePath, assistantJobPath, assistantJobPreviewPath, assistantJobRestorePath, assistantJobRunNowPath, assistantJobsPath,
  PERSONAL_RUN_CONSENT_VERSION, type AssistantJob, type Conversation, type Project, type Workspace,
} from '@flux/contracts';
import type { PgBoss } from 'pg-boss';
import { assistantTick, createPersonalRunProcessor, PERSONAL_RUN_JOB, type PersonalComputeResult, type Principal } from '@flux/core';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { assistantUnitOfWork, startBackgroundOf } from '../../apps/worker/src/assistant/index.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';

// F-027 A8 (#408): "On a schedule" (AST-7). The real API for the owner's routes, the real worker tick against the same database
// with a CONTROLLED clock (the tick takes `now`), a second tick instance standing for a second worker, and a FAKE provider.
// Every schedule here first fires in the future of the real clock, so the Compose worker's own per-minute tick never meets one.
// No model, vendor account or key is used.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const DAY = 86_400_000;
const MINUTE = 60_000;

/** pg-boss as the worker sees it: dispatch jobs are recorded (a test processes them), pushes are counted. */
const sent: { name: string; data: Record<string, unknown> }[] = [];
const boss = { send: async (name: string, data?: object | null) => { sent.push({ name, data: (data ?? {}) as Record<string, unknown> }); return randomUUID(); } } as unknown as Pick<PgBoss, 'send'>;
const dispatched = () => sent.filter((job) => job.name === PERSONAL_RUN_JOB).map((job) => job.data.runId as string);

const composition = { connections, providerEnabled: true, toolTurns: 1 };
const startBackground = startBackgroundOf(composition, db, boss);
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20 });
const tick = (now: Date) => assistantTick({ uow: assistantUnitOfWork(db, boss), startBackground }, now);

/** 09:00 UTC tomorrow (UTC midnight after today + 9h): well ahead of the real clock, so only the test's own tick fires it. */
function tomorrowAt(hours: number, minutes = 0, days = 1) {
  const base = new Date(Date.now() + days * DAY);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hours, minutes));
}
const answer = (text: string): ((request: unknown) => Promise<PersonalComputeResult>) => async () =>
  ({ kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 }, text });

interface Row { id: string; status: string; kind: string; silent: boolean; prompt: string; conversation_id: string }
const runsOf = async (jobId: string) => (await pool.query(`SELECT r.id, r.status, r.kind, r.silent, r.prompt, r.conversation_id FROM personal_runs r
  JOIN assistant_job_runs j ON j.run_id = r.id WHERE j.job_id = $1 ORDER BY r.created_at`, [jobId])).rows as Row[];
const firings = async (jobId: string) => (await pool.query(`SELECT state, result_line, fired_by, needs_you, run_id FROM assistant_job_runs WHERE job_id = $1 ORDER BY fired_at, started_at`, [jobId])).rows as
  { state: string; result_line: string; fired_by: string; needs_you: boolean; run_id: string | null }[];
const jobRow = async (jobId: string) => (await pool.query(`SELECT * FROM assistant_jobs WHERE id = $1`, [jobId])).rows[0] as Record<string, unknown>;

describe('"On a schedule": the owner\'s schedules and the per-minute tick (F-027 A8, #408)', () => {
  let owner: Person; let peer: Person; let viewer: Person; let guest: Person; let ws: Workspace; let place: Project; let thread: Conversation; let agentId: string;
  const path = (someone: Person, workspaceId = ws.id) => assistantJobsPath(workspaceId, someone.id);
  const list = async () => (expectStatus(await owner.browser.request('GET', path(owner)), 200) as { items: AssistantJob[] }).items;
  const create = async (body: Record<string, unknown> = {}, who = owner) => {
    const response = await who.browser.request('POST', path(who), { body: { projectId: place.id, text: 'List what we finished this week', schedule: { kind: 'weekly', at: '16:00', weekday: 5 }, timeZone: 'UTC', ...body } });
    return response;
  };
  /**
   * Creates a schedule through the API. The API's own clock is the real one, so a daily schedule's first time is moved to the
   * controlled day (tomorrow at its hour): far ahead of the real clock, where only the test's own tick ever meets it.
   */
  const created = async (body: Record<string, unknown> = {}) => {
    const job = expectStatus(await create(body), 201) as unknown as AssistantJob;
    const schedule = (body.schedule ?? job.schedule) as { kind: string; at?: string };
    if (schedule.kind === 'daily') {
      await pool.query(`UPDATE assistant_jobs SET next_run_at = $2 WHERE id = $1`, [job.id, tomorrowAt(Number(schedule.at!.slice(0, 2)))]);
    }
    return job;
  };
  /** The fire time of a daily schedule at `hours` tomorrow, in UTC. */
  const daily = (hours = 9) => ({ kind: 'daily', at: `${String(hours).padStart(2, '0')}:00` });
  const processAll = async () => { for (const id of dispatched().splice(0)) await processor.process(id); };

  before(async () => {
    owner = await person('sj-ada'); peer = await person('sj-jonas'); viewer = await person('sj-vic'); guest = await person('sj-gus');
    ws = await createWorkspace(owner, 'Schedules');
    for (const [who, role] of [[peer, 'member'], [viewer, 'member'], [guest, 'guest']] as const) await addMember(owner, ws.id, who, role);
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    await grant(owner, place.id, peer, 'contributor');
    await grant(owner, place.id, viewer, 'viewer');
    await grant(owner, place.id, guest, 'viewer');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId, perRunCents: 50, dailyCapCents: 1_000 });
  });
  after(async () => { await pool.query(`DELETE FROM assistant_jobs WHERE owner_user_id = $1`, [owner.id]); });
  beforeEach(async () => {
    compute.dispatched = []; compute.respond = answer('Done: nothing to change');
    sent.length = 0;
    await pool.query(`DELETE FROM assistant_jobs WHERE owner_user_id = $1`, [owner.id]);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    // Each test starts a fresh day of caps.
    await pool.query(`UPDATE personal_runs SET created_at = created_at - interval '2 days' WHERE owner_user_id = $1`, [owner.id]);
  });

  test('AST-7.1: a weekly review on Monday is enabled in two calls and says "Every Monday at 9:00 · Next: Mon 9:00" in the owner\'s zone', async () => {
    const job = await created({ title: 'Weekly review', text: 'Review what moved this week', schedule: { kind: 'weekly', at: '09:00', weekday: 1 }, timeZone: 'Europe/Warsaw' });
    assert.deepEqual([job.title, job.words, job.enabled, job.prepared, job.projectName], ['Weekly review', 'Every Monday at 9:00', true, false, 'Lamp sensor']);
    assert.equal(job.next.length, 3);
    assert.ok(job.next.every((item) => /^Mon( \d+ \w+)? 9:00$/.test(item.label)), JSON.stringify(job.next));
    assert.match(job.next[0]!.label, /^Mon( \d+ \w+)? 9:00$/);
    assert.ok(new Date(job.next[0]!.at).getTime() > Date.now());
    const [stored] = await list();
    assert.equal(stored!.id, job.id);
    const row = await jobRow(job.id);
    assert.deepEqual([row.enabled, row.owner_user_id, row.time_zone], [true, owner.id, 'Europe/Warsaw']);
    assert.equal(new Date(row.next_run_at as string).getTime(), new Date(job.next[0]!.at).getTime());
    // A name from the first words when none is given.
    assert.equal((await created({ text: 'List what we finished this week' })).title, 'List what we finished this week');
  });

  test('AST-7.9: a schedule whose text holds a key or a token is refused at save, so no secret is stored', async () => {
    for (const secret of ['Use sk-ant-api03-abcdefghijklmnop to read it', 'Send eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc to them', 'access_token: abcdef123456']) {
      const response = await create({ text: secret });
      assert.deepEqual([response.status, (response.json as { code: string }).code], [400, 'ASSISTANT_JOB_SECRET'], secret);
      assert.match((response.json as { error?: string; message?: string }).error ?? (response.json as { message?: string }).message ?? '', /key or a token/);
    }
    const title = await create({ title: 'sk-ant-api03-abcdefghijklmnop' });
    assert.equal(title.status, 400);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM assistant_jobs WHERE owner_user_id = $1`, [owner.id])).rows[0].n), 0);
  });

  test('AST-7.10: more than once an hour is refused with "At most once an hour"; a valid cron shows its words and next three times', async () => {
    const refused = await owner.browser.request('POST', assistantJobPreviewPath(ws.id, owner.id), { body: { schedule: { kind: 'cron', cron: '*/15 * * * *' }, timeZone: 'UTC' } });
    assert.deepEqual([refused.status, (refused.json as { code: string }).code], [400, 'ASSISTANT_JOB_TOO_OFTEN']);
    assert.equal((refused.json as { error?: string }).error ?? (refused.json as { message?: string }).message, 'At most once an hour');
    assert.equal((await create({ schedule: { kind: 'cron', cron: '0,30 9 * * *' } })).status, 400);
    const preview = expectStatus(await owner.browser.request('POST', assistantJobPreviewPath(ws.id, owner.id),
      { body: { schedule: { kind: 'cron', cron: '0 9 * * 2-4' }, timeZone: 'Europe/Warsaw' } }), 200) as { words: string; next: { label: string }[] };
    assert.equal(preview.words, 'At 9:00 on Tuesday, Wednesday and Thursday');
    assert.equal(preview.next.length, 3);
    assert.ok(preview.next.every((item) => / 9:00$/.test(item.label)));
    const job = await created({ schedule: { kind: 'cron', cron: '0 9 * * 1-5' } });
    assert.equal(job.words, 'Weekdays at 9:00');
    assert.equal(job.schedule.kind, 'cron');
  });

  test('nobody else sees or runs a schedule: another member, a viewer, a guest and a stranger all get the 404 of one that does not exist', async () => {
    const job = await created();
    const before = (await runsOf(job.id)).length;
    for (const someone of [peer, viewer, guest]) {
      // Their own list is their own; the owner's path is not theirs.
      const ownerPath = await someone.browser.request('GET', path(owner));
      assert.equal(ownerPath.status, 404, `${someone.email} lists Ada's schedules`);
      const forged = await someone.browser.request('POST', path(owner), { body: { projectId: place.id, text: 'x', schedule: { kind: 'daily', at: '09:00' }, timeZone: 'UTC' } });
      assert.equal(forged.status, 404, `${someone.email} creates one for Ada`);
      // Even under their own path, Ada's schedule id is nothing.
      const own = path(someone);
      assert.deepEqual((expectStatus(await someone.browser.request('GET', own), 200) as { items: unknown[] }).items, []);
      for (const [method, target, body] of [
        ['PATCH', assistantJobPath(ws.id, someone.id, job.id), { expectedVersion: job.version, enabled: false }],
        ['DELETE', assistantJobPath(ws.id, someone.id, job.id), undefined],
        ['POST', assistantJobRunNowPath(ws.id, someone.id, job.id), undefined],
        ['POST', assistantJobRestorePath(ws.id, someone.id, job.id), undefined],
        ['GET', assistantJobHistoryPath(ws.id, someone.id, job.id), undefined],
        ['PATCH', assistantJobPath(ws.id, owner.id, job.id), { expectedVersion: job.version, enabled: false }],
        ['POST', assistantJobRunNowPath(ws.id, owner.id, job.id), undefined],
        ['GET', assistantJobHistoryPath(ws.id, owner.id, job.id), undefined],
      ] as const) {
        const response = await someone.browser.request(method, target, body === undefined ? {} : { body });
        assert.equal(response.status, 404, `${someone.email} ${method} ${target}: ${response.text}`);
      }
      assert.equal((await someone.browser.request('GET', assistantJobNotePath(ws.id, owner.id))).status, 404);
    }
    const anonymous = await fetch(new URL(path(owner), process.env.FLUX_API_URL ?? 'http://api:8080'));
    assert.equal(anonymous.status, 401);
    assert.equal((await runsOf(job.id)).length, before, 'nobody else started a run');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id = ANY($1)`, [[peer.id, viewer.id, guest.id]])).rows[0].n), 0);
    const untouched = (await list())[0]!;
    assert.deepEqual([untouched.enabled, untouched.version], [true, job.version]);
    // Someone without an assistant cannot make a schedule of their own either.
    const own = await create({}, peer);
    assert.deepEqual([own.status, (own.json as { code: string }).code], [409, 'ASSISTANT_NOT_ENABLED']);
  });

  test('AST-7.2: with the clock past the time exactly one run starts, even when two workers tick at once; the row then says "Last: Done"', async () => {
    const job = await created({ title: 'Daily check', text: 'Look at the sensor tasks', schedule: daily(9) });
    const fire = tomorrowAt(9);
    assert.equal(new Date((await jobRow(job.id)).next_run_at as string).getTime(), fire.getTime());
    // Before the time: nothing.
    const early = await tick(new Date(fire.getTime() - MINUTE));
    assert.equal(early.fired, 0);
    assert.equal((await runsOf(job.id)).length, 0);
    // Two workers tick at the same controlled moment.
    const at = new Date(fire.getTime() + 30_000);
    const results = await Promise.all([tick(at), tick(at), tick(at)]);
    assert.equal(results.reduce((total, item) => total + item.fired, 0), 1, 'exactly one tick fired it');
    const started = await runsOf(job.id);
    assert.equal(started.length, 1, 'one run, not three');
    assert.deepEqual([started[0]!.kind, started[0]!.silent, started[0]!.prompt], ['scheduled', true, 'Look at the sensor tasks']);
    assert.equal(started[0]!.conversation_id, thread.id, 'a silent run is anchored in a conversation of its project and never shown there');
    assert.equal(dispatched().length, 1);
    assert.equal((await firings(job.id)).length, 1);
    // The same moment again starts nothing; the next time is tomorrow's.
    assert.equal((await tick(at)).fired, 0);
    assert.equal(new Date((await jobRow(job.id)).next_run_at as string).getTime(), fire.getTime() + DAY);
    // The worker processes the run (fake provider); the next tick closes the firing.
    compute.respond = answer('Done: nothing to change');
    await processAll();
    assert.equal(compute.dispatched.length, 1);
    await tick(new Date(fire.getTime() + 2 * MINUTE));
    const [history] = await firings(job.id);
    assert.deepEqual([history!.state, history!.result_line], ['done', 'Done: nothing to change']);
    const [row] = await list();
    assert.deepEqual([row!.last?.state, row!.last?.line, row!.running], ['done', 'Done: nothing to change', false]);
    // Its answer is not in the conversation: a silent run is kept in Recent for its owner.
    const answers = expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers`), 200) as { items: { runId: string }[] };
    assert.equal(answers.items.some((item) => item.runId === started[0]!.id), false);
  });

  test('AST-7.3: with the worker stopped from 8:55 to 9:20 no run happens for 9:00, the history says so, and the next run is the next one due', async () => {
    const job = await created({ schedule: daily(9) });
    const fire = tomorrowAt(9);
    const late = new Date(fire.getTime() + 20 * MINUTE);
    assert.equal((await tick(late)).fired, 1);
    assert.equal((await runsOf(job.id)).length, 0, 'no backlog is run');
    assert.deepEqual((await firings(job.id)).map((item) => [item.state, item.result_line]), [['skipped', 'Skipped: Flux was off at 9:00']]);
    assert.equal(new Date((await jobRow(job.id)).next_run_at as string).getTime(), fire.getTime() + DAY, 'the next one due, not the missed one again');
    assert.equal((await tick(late)).fired, 0);
    // A worker back at 9:05 still starts it: ten minutes of grace.
    const other = await created({ schedule: daily(9), text: 'Second schedule' });
    assert.equal((await tick(new Date(fire.getTime() + 5 * MINUTE))).fired, 1);
    assert.equal((await runsOf(other.id)).length, 1);
    // Several missed days leave one line, not a pile.
    const weekly = await created({ schedule: daily(9), text: 'Third schedule' });
    await pool.query(`UPDATE assistant_jobs SET next_run_at = $2 WHERE id = $1`, [weekly.id, new Date(fire.getTime() - 3 * DAY)]);
    await tick(fire);
    assert.equal((await firings(weekly.id)).length, 1);
    assert.equal(new Date((await jobRow(weekly.id)).next_run_at as string).getTime() > fire.getTime(), true);
  });

  /** A job's firing on `day` (days ahead of today) at 09:00 UTC: tick, process what was started, tick again to close it. */
  async function cycle(day: number, respond?: typeof compute.respond) {
    if (respond) compute.respond = respond;
    const fire = tomorrowAt(9, 0, day);
    await tick(new Date(fire.getTime() + 30_000));
    await processAll();
    await tick(new Date(fire.getTime() + 2 * MINUTE));
  }
  const failing = async (): Promise<PersonalComputeResult> => ({ kind: 'failed', reason: 'provider_error', billed: 'none' });
  const pausedItems = async () => (await pool.query(`SELECT title, in_inbox FROM notifications WHERE user_id = $1 AND title LIKE 'Paused %'`, [owner.id])).rows as { title: string; in_inbox: boolean }[];

  test('AST-7.4: three failing runs in a row pause the schedule and create exactly one Inbox item; a success in between starts the count again', async () => {
    const job = await created({ title: 'Weekly review', schedule: daily(9) });
    await cycle(1, failing); await cycle(2, failing);
    assert.deepEqual((await firings(job.id)).map((item) => item.state), ['failed', 'failed']);
    assert.equal((await jobRow(job.id)).enabled, true, 'two failures do not pause it');
    await cycle(3, answer('Done: nothing to change'));
    assert.equal((await jobRow(job.id)).failure_streak, 0, 'a success starts the count again');
    await cycle(4, failing); await cycle(5, failing); await cycle(6, failing);
    const row = await jobRow(job.id);
    assert.deepEqual([row.enabled, row.paused_reason, row.next_run_at, row.failure_streak], [false, 'failures', null, 3]);
    const items = await pausedItems();
    assert.equal(items.length, 1, 'exactly one Inbox item');
    assert.deepEqual([items[0]!.title, items[0]!.in_inbox], ['Paused Weekly review: it failed three times in a row', true]);
    const [view] = await list();
    assert.deepEqual([view!.enabled, view!.pausedReason, view!.next], [false, 'failures', []]);
    // Nothing runs while it is paused, and turning it on again starts a fresh count.
    assert.equal((await tick(tomorrowAt(9, 0, 7))).fired, 0);
    const again = expectStatus(await owner.browser.request('PATCH', assistantJobPath(ws.id, owner.id, job.id), { body: { expectedVersion: view!.version, enabled: true } }), 200) as unknown as AssistantJob;
    assert.deepEqual([again.enabled, again.pausedReason], [true, null]);
    assert.equal((await jobRow(job.id)).failure_streak, 0);
    assert.equal((await pausedItems()).length, 1, 'no second item');
  });

  test('a plan limit skips that time and a sign-out fails the run; the words are plain', async () => {
    const { resultOf } = await import('@flux/core');
    const run = (changes: Record<string, unknown>) => ({ status: 'unavailable', answerBody: null, dispatchedAt: null, planLimitResetsAt: null, endReason: null, provider: 'anthropic', engine: 'runtime',
      stoppedAtStage: null, ...changes }) as never;
    const at = new Date('2026-10-17T10:00:00Z');
    assert.deepEqual(resultOf(run({ endReason: 'plan_limit', planLimitResetsAt: new Date('2026-10-17T14:00:00Z') }), { applied: 0, waiting: 0 }, 'UTC', at), { state: 'skipped', line: 'Skipped: plan limit until 14:00' });
    assert.deepEqual(resultOf(run({ endReason: 'plan_limit' }), { applied: 0, waiting: 0 }, 'UTC', at), { state: 'skipped', line: 'Skipped: plan limit' });
    assert.deepEqual(resultOf(run({ endReason: 'sign_in_again' }), { applied: 0, waiting: 0 }, 'UTC', at), { state: 'failed', line: 'Sign in to Claude again' });
    assert.deepEqual(resultOf(run({ endReason: 'sign_in_again', provider: 'openai' }), { applied: 0, waiting: 0 }, 'UTC', at), { state: 'failed', line: 'Sign in to ChatGPT again' });
    assert.deepEqual(resultOf(run({ status: 'completed', answerBody: 'Done: nothing to change' }), { applied: 0, waiting: 0 }, 'UTC', at), { state: 'done', line: 'Done: nothing to change' });
    assert.deepEqual(resultOf(run({ status: 'completed', answerBody: 'x' }), { applied: 3, waiting: 2 }, 'UTC', at), { state: 'done', line: 'Done: 3 changes, 2 need you' });
    assert.deepEqual(resultOf(run({ status: 'completed', answerBody: 'x' }), { applied: 0, waiting: 2 }, 'UTC', at), { state: 'done', line: 'Done, 2 things need you' });
    assert.deepEqual(resultOf(run({ status: 'stopped' }), { applied: 0, waiting: 0 }, 'UTC', at), { state: 'skipped', line: 'Stopped' });
  });

  test('Run now, pause, edit and delete with Undo: the owner\'s own controls; one run at a time', async () => {
    const { assistantJobUseCases } = await import('../../apps/server/src/assistant/jobs.js');
    const jobs = assistantJobUseCases(db, boss, { queue: queue.factory, connections, providerEnabled: true, toolTurns: 1 });
    const job = await created({ title: 'Tidy', text: 'Tidy the sensor tasks', schedule: daily(9) });
    const started = await jobs.runNow(human(owner), ws.id, owner.id, job.id);
    assert.deepEqual([started.run.firedBy, started.run.state, started.job.running], ['now', 'running', true]);
    assert.equal((await runsOf(job.id)).length, 1);
    await assert.rejects(jobs.runNow(human(owner), ws.id, owner.id, job.id), { code: 'ASSISTANT_JOB_RUNNING' }, 'one run at a time per schedule');
    assert.equal((await runsOf(job.id)).length, 1);
    // The owner's request waits for nothing: the run is queued, the worker processes it, the owner's list closes it.
    for (const id of queue.runIds.splice(0)) await processor.process(id);
    const [shown] = await jobs.list(human(owner), ws.id, owner.id);
    assert.deepEqual([shown!.running, shown!.last?.state, shown!.last?.line], [false, 'done', 'Done: nothing to change']);
    assert.equal(new Date((await jobRow(job.id)).next_run_at as string).getTime(), tomorrowAt(9).getTime(), 'Run now does not move the schedule');
    // History: the last runs, newest first.
    const history = (expectStatus(await owner.browser.request('GET', assistantJobHistoryPath(ws.id, owner.id, job.id)), 200) as { items: { firedBy: string; line: string }[] }).items;
    assert.deepEqual(history.map((item) => [item.firedBy, item.line]), [['now', 'Done: nothing to change']]);

    // Pause and turn on: the next time disappears and comes back.
    const patch = async (body: Record<string, unknown>, version: number) => expectStatus(await owner.browser.request('PATCH', assistantJobPath(ws.id, owner.id, job.id), { body: { expectedVersion: version, ...body } }), 200) as unknown as AssistantJob;
    const paused = await patch({ enabled: false }, shown!.version);
    assert.deepEqual([paused.enabled, paused.next, (await jobRow(job.id)).next_run_at], [false, [], null]);
    assert.equal((await tick(tomorrowAt(9, 1))).fired, 0, 'a paused schedule never catches up');
    const edited = await patch({ enabled: true, text: 'Tidy the sensor tasks and the Wiki', schedule: { kind: 'weekdays', at: '08:30' }, timeZone: 'Europe/Warsaw' }, paused.version);
    assert.deepEqual([edited.words, edited.text, edited.enabled, edited.timeZone], ['Weekdays at 8:30', 'Tidy the sensor tasks and the Wiki', true, 'Europe/Warsaw']);
    assert.equal(edited.title, 'Tidy', 'the name stays when only the sentence changes');
    const stale = await owner.browser.request('PATCH', assistantJobPath(ws.id, owner.id, job.id), { body: { expectedVersion: paused.version, enabled: false } });
    assert.deepEqual([stale.status, (stale.json as { code: string }).code], [409, 'VERSION_CONFLICT']);
    assert.equal((await patch({ text: 'x'.repeat(3) }, edited.version)).text, 'xxx');

    // Delete with Undo.
    const removed = expectStatus(await owner.browser.request('DELETE', assistantJobPath(ws.id, owner.id, job.id)), 200) as unknown as AssistantJob;
    assert.equal(removed.id, job.id);
    assert.equal((await list()).length, 0);
    await pool.query(`UPDATE assistant_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [job.id]);
    assert.equal((await tick(new Date(Date.now() + 3600_000))).fired, 0, 'a deleted schedule does not run');
    const restored = expectStatus(await owner.browser.request('POST', assistantJobRestorePath(ws.id, owner.id, job.id)), 200) as unknown as AssistantJob;
    assert.deepEqual([restored.enabled, (await list()).length], [true, 1]);
    // After a day the delete cannot be undone; the tick lets the schedule and its history go.
    expectStatus(await owner.browser.request('DELETE', assistantJobPath(ws.id, owner.id, job.id)), 200);
    await pool.query(`UPDATE assistant_jobs SET deleted_at = now() - interval '25 hours' WHERE id = $1`, [job.id]);
    assert.equal((await owner.browser.request('POST', assistantJobRestorePath(ws.id, owner.id, job.id))).status, 404);
    await tick(tomorrowAt(9, 1, 3));
    assert.equal((await pool.query(`SELECT 1 FROM assistant_jobs WHERE id = $1`, [job.id])).rowCount, 0);
    assert.equal((await pool.query(`SELECT 1 FROM assistant_job_runs WHERE job_id = $1`, [job.id])).rowCount, 0);
  });

  test('the history keeps the last 20 firings', async () => {
    const job = await created({ schedule: daily(9) });
    for (let index = 0; index < 23; index++) await pool.query(`INSERT INTO assistant_job_runs (id, job_id, owner_user_id, fired_at, fired_by, state, result_line, finished_at)
      VALUES ($1, $2, $3, $4, 'schedule', 'skipped', 'Skipped: Flux was off at 9:00', now())`, [randomUUID(), job.id, owner.id, new Date(Date.UTC(2026, 0, 1 + index, 9))]);
    await pool.query(`UPDATE assistant_jobs SET next_run_at = $2 WHERE id = $1`, [job.id, tomorrowAt(9)]);
    await tick(new Date(tomorrowAt(9).getTime() + 30_000));
    await processAll();
    await tick(new Date(tomorrowAt(9).getTime() + 2 * MINUTE));
    const rows = (expectStatus(await owner.browser.request('GET', assistantJobHistoryPath(ws.id, owner.id, job.id)), 200) as { items: unknown[] }).items;
    assert.equal(rows.length, 20);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM assistant_job_runs WHERE job_id = $1`, [job.id])).rows[0].n), 20);
  });

  test('caps: twelve runs a day for one schedule, and the assistant\'s own background limit across schedules; a skipped time says "Skipped: daily limit"', async () => {
    const job = await created({ schedule: daily(9) });
    for (let index = 0; index < 12; index++) await pool.query(`INSERT INTO assistant_job_runs (id, job_id, owner_user_id, fired_at, fired_by, state, result_line, finished_at)
      VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval, 'now', 'done', 'Done', now())`, [randomUUID(), job.id, owner.id, String(index + 1)]);
    await tick(new Date(tomorrowAt(9).getTime() + 30_000));
    assert.equal((await runsOf(job.id)).length, 0);
    assert.equal((await firings(job.id)).at(-1)!.result_line, 'Skipped: daily limit');

    // Across schedules: a limit of 1 background run a day lets the first through.
    const current = expectStatus(await owner.browser.request('GET', `/api/v1/workspaces/${ws.id}/assistants/${owner.id}/settings`), 200) as { version: number };
    expectStatus(await owner.browser.request('PATCH', `/api/v1/workspaces/${ws.id}/assistants/${owner.id}/settings`, { body: { backgroundRunsPerDay: 1 }, headers: { 'if-match': `"${current.version}"` } }), 200);
    try {
      const first = await created({ title: 'First', schedule: daily(10) });
      const second = await created({ title: 'Second', schedule: daily(10) });
      await tick(new Date(tomorrowAt(10).getTime() + 30_000));
      const lines = [first, second].map(async (item) => (await firings(item.id)).at(-1)!.result_line);
      const [one, two] = await Promise.all(lines);
      assert.deepEqual([one, two].sort(), ['', 'Skipped: daily limit']);
    } finally {
      const latest = expectStatus(await owner.browser.request('GET', `/api/v1/workspaces/${ws.id}/assistants/${owner.id}/settings`), 200) as { version: number };
      expectStatus(await owner.browser.request('PATCH', `/api/v1/workspaces/${ws.id}/assistants/${owner.id}/settings`, { body: { backgroundRunsPerDay: 24 }, headers: { 'if-match': `"${latest.version}"` } }), 200);
    }
  });

  test('the lane: a background run waits behind the owner\'s own request, never in front of it, and is skipped when it could not start within ten minutes', async () => {
    const { personalRunRows } = await import('@flux/db');
    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    const job = await created({ schedule: daily(9) });
    // The owner's request is working.
    const mine = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Tidy the project' });
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [mine.run.id]);
    const fire = tomorrowAt(9);
    await tick(new Date(fire.getTime() + 30_000));
    const [background] = await runsOf(job.id);
    assert.equal(background!.status, 'queued', 'it waits for the lane');
    // A second request of the owner is not refused because a background run waits, and it starts before the background run.
    const next = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'And the Wiki' });
    assert.equal(next.run.status, 'queued');
    await pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), committed_at = now(), answer_body = 'ok', cost_state = 'released' WHERE id = $1`, [mine.run.id]);
    const startable = await db.transaction((tx) => personalRunRows(tx).startableQueued(20));
    assert.ok(startable.includes(next.run.id), 'the owner\'s request starts first');
    assert.equal(startable.includes(background!.id), false);
    // Ten minutes pass without the lane: skipped, never run late.
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released' WHERE id = $1`, [next.run.id]);
    await tick(new Date(fire.getTime() + 11 * MINUTE));
    assert.equal((await pool.query(`SELECT status FROM personal_runs WHERE id = $1`, [background!.id])).rows[0].status, 'stopped');
    assert.equal((await firings(job.id)).at(-1)!.result_line, 'Skipped: your assistant was busy at 9:00');
  });

  test('AST-9.1: a seeded DM, a private sketch and another project\'s canary never reach the provider of a scheduled run', async () => {
    const DM = `dm-canary-${randomUUID().slice(0, 8)}`; const PRIVATE = `private-canary-${randomUUID().slice(0, 8)}`; const OTHER = `other-canary-${randomUUID().slice(0, 8)}`;
    const elsewhere = await createProject(owner, ws.id, 'Elsewhere', 'workspace');
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${elsewhere.id}/work`, { body: { title: OTHER } }), 201);
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${elsewhere.id}/conversations`, { body: { body: OTHER, clientMessageId: randomUUID() } }), 201);
    const map = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: PRIVATE, scope: 'private' } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', `/api/v1/sketches/${map.id}/thoughts`, { body: { text: PRIVATE, x: 0, y: 0 } }), 201);
    const opened = await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [peer.id] } });
    expectStatus(await owner.browser.request('POST', `/api/v1/dms/${(opened.json as { id: string }).id}/messages`, { body: { body: DM, clientMessageId: randomUUID() } }), 201);
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Calibrate the probes' } }), 201);
    await created({ schedule: daily(9) });
    await cycle(1);
    assert.equal(compute.dispatched.length, 1);
    const seen = JSON.stringify(compute.dispatched[0]);
    for (const canary of [DM, PRIVATE, OTHER]) assert.equal(seen.includes(canary), false, canary);
    assert.ok(seen.includes('Calibrate the probes'), 'the project\'s own open work is its context');
    assert.equal(seen.includes('Camera fails below 5 lux'), false, 'a silent run does not read its anchor conversation');
  });

  test('AST-7.5: only the owner\'s own request can prepare a schedule, and it stays off; a background run\'s block does nothing; no tool exists for it', async () => {
    const { AGENT_MCP_ENTRIES } = await import('@flux/contracts');
    assert.deepEqual(AGENT_MCP_ENTRIES.filter((entry) => /schedule|reaction|switch|cron/i.test(`${entry.id} ${entry.name}`)), []);
    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    const block = '<schedule>{"title":"Blocked tasks","text":"Tell me what is blocked here","when":{"kind":"weekdays","at":"09:00"}}</schedule>';
    compute.respond = answer(`I will tell you each weekday morning.\n${block}`);
    const ask = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Every weekday at 9 tell me what is blocked here' });
    await processor.process(ask.run.id);
    const prepared = (await list()).filter((item) => item.prepared);
    assert.equal(prepared.length, 1);
    assert.deepEqual([prepared[0]!.title, prepared[0]!.words, prepared[0]!.enabled, prepared[0]!.preparedRunId, prepared[0]!.next], ['Blocked tasks', 'Weekdays at 9:00', false, ask.run.id, []]);
    assert.equal((await pool.query(`SELECT answer_body FROM personal_runs WHERE id = $1`, [ask.run.id])).rows[0].answer_body, 'I will tell you each weekday morning.');
    assert.equal((await tick(tomorrowAt(9, 1))).fired, 0, 'it never runs until the owner turns it on');
    // Another person asking their own assistant, or a background run emitting the block, prepares nothing.
    const job = await created({ schedule: daily(9), text: 'Look around' });
    compute.respond = answer(`Done.\n${block}`);
    await cycle(1);
    assert.equal((await list()).filter((item) => item.prepared).length, 1, 'a scheduled run prepared nothing');
    assert.equal((await pool.query(`SELECT answer_body FROM personal_runs WHERE id = (SELECT run_id FROM assistant_job_runs WHERE job_id = $1 LIMIT 1)`, [job.id])).rows[0].answer_body, 'Done.');
    // A garbage block or a bad time is dropped or explained, never turned on.
    compute.respond = answer('Ok.\n<schedule>{"text":"x","when":{"kind":"cron","cron":"* * * * *"}}</schedule>');
    const bad = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Every minute' });
    await processor.process(bad.run.id);
    assert.match((await pool.query(`SELECT answer_body FROM personal_runs WHERE id = $1`, [bad.run.id])).rows[0].answer_body as string, /couldn't prepare that schedule: At most once an hour/);
    assert.equal((await list()).filter((item) => item.prepared).length, 1);
    // The owner's tap turns it on; nothing else can.
    const [ready] = prepared;
    const on = expectStatus(await owner.browser.request('PATCH', assistantJobPath(ws.id, owner.id, ready!.id), { body: { expectedVersion: ready!.version, enabled: true } }), 200) as unknown as AssistantJob;
    assert.deepEqual([on.enabled, on.prepared, on.next.length], [true, false, 3]);
    // A bearer of any other kind (a run token, an MCP token) does not reach the routes.
    const response = await fetch(new URL(path(owner), process.env.FLUX_API_URL ?? 'http://api:8080'), { headers: { authorization: 'Bearer not-a-session' } });
    assert.equal(response.status, 401);
  });

  test('AST-7.11: a schedule that posts in a conversation shows its answer there, never "Done: nothing to change", and says whose schedule it is', async () => {
    const answers = async () => (expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers`), 200) as { items: { runId: string; body: string; request: { kind: string }; schedule?: { title: string } | null }[] }).items;
    const job = await created({ title: 'Hourly tidy', text: 'Tidy the sensor tasks', schedule: daily(9), postToConversation: true, conversationId: thread.id });
    assert.equal(job.conversationId, thread.id);
    await cycle(1, answer('Renamed the probe task.'));
    const [first] = await runsOf(job.id);
    assert.equal(first!.silent, false);
    assert.equal(first!.conversation_id, thread.id, 'a posting schedule runs in its conversation');
    let shown = await answers();
    assert.deepEqual(shown.filter((item) => item.runId === first!.id).map((item) => [item.body, item.request.kind, item.schedule?.title]), [['Renamed the probe task.', 'scheduled', 'Hourly tidy']]);
    // The next time has nothing to change: it is never posted, whether or not the tick has closed it yet.
    await cycle(2, answer('Done: nothing to change'));
    const second = (await runsOf(job.id))[1]!;
    shown = await answers();
    assert.equal(shown.some((item) => item.runId === second.id), false, 'nothing to change is not posted');
    assert.equal((await firings(job.id)).at(-1)!.result_line, 'Done: nothing to change');
    assert.equal(shown.some((item) => item.runId === first!.id), true, 'what was worth saying stays');
    // A conversation of another project cannot be chosen.
    const elsewhere = await createProject(owner, ws.id, 'Elsewhere posting', 'workspace');
    const otherThread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${elsewhere.id}/conversations`, { body: { body: 'Hello', clientMessageId: randomUUID() } }), 201) as Conversation;
    const refused = await create({ postToConversation: true, conversationId: otherThread.id });
    assert.equal(refused.status, 404);
  });

  test('Do it at 14:00: a one-off schedule of the same request posts in its conversation once and then turns itself off', async () => {
    const at = new Date(Date.now() + 2 * DAY);
    const job = await created({ title: 'Probe notes', text: 'Summarize the probe notes', schedule: { kind: 'once', at: at.toISOString() }, postToConversation: true, conversationId: thread.id });
    assert.deepEqual([job.words.startsWith('Once, '), job.enabled, job.next.length], [true, true, 1]);
    assert.equal(new Date((await jobRow(job.id)).next_run_at as string).getTime(), at.getTime());
    compute.respond = answer('The probe notes say the sensor is a PIR.');
    assert.equal((await tick(new Date(at.getTime() + 30_000))).fired, 1);
    await processAll();
    await tick(new Date(at.getTime() + 2 * MINUTE));
    const row = await jobRow(job.id);
    assert.deepEqual([row.enabled, row.next_run_at], [false, null], 'it does not run again');
    assert.equal((await tick(new Date(at.getTime() + DAY))).fired, 0);
    const answers = (expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers`), 200) as { items: { body: string }[] }).items;
    assert.ok(answers.some((item) => item.body === 'The probe notes say the sensor is a PIR.'));
    // The past cannot be scheduled.
    const past = await create({ schedule: { kind: 'once', at: new Date(Date.now() - 60_000).toISOString() } });
    assert.deepEqual([past.status, (past.json as { code: string }).code], [400, 'ASSISTANT_JOB_PAST']);
  });
});
