import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  ASSISTANT_RUN_EFFECT_TOOLS, ASSISTANT_RUNS_PATH, agentChatMessagesPath, agentChatReadPath, assistantRunRetryPath, type AgentChatMessage, assistantJobHistoryPath, assistantJobNotePath, assistantJobPath, assistantJobRestorePath, assistantJobRunNowPath, assistantJobsPath,
  type AssistantJob, type Conversation, type Project, type Workspace,
} from '@flux/contracts';
import type { PgBoss } from 'pg-boss';
import { assistantTick, createPersonalRunProcessor, nothingToReport, PERSONAL_RUN_JOB, resultOf, settleOne, type BackgroundStart, type PersonalComputeResult, type Principal } from '@flux/core';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { assistantUnitOfWork, startBackgroundOf } from '../../apps/worker/src/assistant/index.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { waitFor } from './support/wait.js';

// An agent's schedules (F-036 AG-9, #858): the owner's sentence, told to one of their agents in its private chat, run by that agent at a time in
// the owner's zone, with its results in that chat. The real API for the owner's routes, the real worker tick against the same database with a
// CONTROLLED clock (the tick takes `now`), a second tick instance standing for a second worker, and a FAKE provider. Every schedule here first
// fires in the future of the real clock, so the Compose worker's own per-minute tick never meets one. No model, vendor account or key is used.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const DAY = 86_400_000;
const MINUTE = 60_000;

/** pg-boss as the worker sees it: dispatch jobs are recorded (a test processes them). */
const sent: { name: string; data: Record<string, unknown> }[] = [];
const boss = { send: async (name: string, data?: object | null) => { sent.push({ name, data: (data ?? {}) as Record<string, unknown> }); return randomUUID(); } } as unknown as Pick<PgBoss, 'send'>;
const dispatched = () => sent.filter((job) => job.name === PERSONAL_RUN_JOB).map((job) => job.data.runId as string);

const composition = { connections, providerEnabled: true };
const startBackground = startBackgroundOf(composition, db, boss);
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20 });
const tick = (now: Date) => assistantTick({ uow: assistantUnitOfWork(db, boss), startBackground }, now);

/** 09:00 UTC `days` from today: well ahead of the real clock, so only the test's own tick fires it. */
function tomorrowAt(hours: number, minutes = 0, days = 1) {
  const base = new Date(Date.now() + days * DAY);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hours, minutes));
}
const answer = (text: string): ((request: unknown) => Promise<PersonalComputeResult>) => async () =>
  ({ kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 }, text });
const failing = async (): Promise<PersonalComputeResult> => ({ kind: 'failed', reason: 'provider_error', billed: 'none' });

interface Row { id: string; status: string; kind: string; prompt: string; project_id: string | null; conversation_id: string | null; dm_id: string | null; agent_id: string }
const runsOf = async (jobId: string) => (await pool.query(`SELECT r.id, r.status, r.kind, r.prompt, r.project_id, r.conversation_id, r.dm_id, r.agent_id FROM personal_runs r
  JOIN assistant_job_runs j ON j.run_id = r.id WHERE j.job_id = $1 ORDER BY r.created_at`, [jobId])).rows as Row[];
const firings = async (jobId: string) => (await pool.query(`SELECT state, result_line, fired_by, run_id FROM assistant_job_runs WHERE job_id = $1 ORDER BY fired_at, started_at`, [jobId])).rows as
  { state: string; result_line: string; fired_by: string; run_id: string | null }[];
const jobRow = async (jobId: string) => (await pool.query(`SELECT * FROM assistant_jobs WHERE id = $1`, [jobId])).rows[0] as Record<string, unknown>;
const chatLines = async (agentId: string) => (await pool.query(`SELECT body, key, run_id, schedule FROM agent_chat_messages WHERE agent_id = $1 ORDER BY created_at, id`, [agentId])).rows as
  { body: string; key: string; run_id: string | null; schedule: { title: string; words: string; failed: boolean } | null }[];

describe('an agent\'s schedules and the per-minute tick (F-036 AG-9, #858)', () => {
  let owner: Person; let peer: Person; let guest: Person; let ws: Workspace; let place: Project; let thread: Conversation; let agentId: string; let peerAgentId: string;
  const path = (agent = agentId) => assistantJobsPath(agent);
  const list = async () => (expectStatus(await owner.browser.request('GET', path()), 200) as { items: AssistantJob[] }).items;
  const create = async (body: Record<string, unknown> = {}, who = owner, agent = agentId) =>
    who.browser.request('POST', path(agent), { body: { text: 'List what we finished this week', schedule: { kind: 'weekly', at: '16:00', weekday: 5 }, timeZone: 'UTC', ...body } });
  /** Creates a schedule through the API; a daily one's first time is moved to the controlled day, far ahead of the real clock. */
  const created = async (body: Record<string, unknown> = {}) => {
    const job = expectStatus(await create(body), 201) as unknown as AssistantJob;
    const schedule = (body.schedule ?? job.schedule) as { kind: string; at?: string };
    if (schedule.kind === 'daily') await pool.query(`UPDATE assistant_jobs SET next_run_at = $2 WHERE id = $1`, [job.id, tomorrowAt(Number(schedule.at!.slice(0, 2)))]);
    return job;
  };
  const daily = (hours = 9) => ({ kind: 'daily', at: `${String(hours).padStart(2, '0')}:00` });
  const processAll = async () => { for (const id of dispatched().splice(0)) await processor.process(id); };
  /** A job's firing on `day` (days ahead of today) at 09:00 UTC: tick, process what was started, tick again to close it. */
  async function cycle(day: number, respond?: typeof compute.respond) {
    if (respond) compute.respond = respond;
    const fire = tomorrowAt(9, 0, day);
    await tick(new Date(fire.getTime() + 30_000));
    await processAll();
    await tick(new Date(fire.getTime() + 2 * MINUTE));
  }

  before(async () => {
    owner = await person('sj-ada'); peer = await person('sj-jonas'); guest = await person('sj-gus');
    ws = await createWorkspace(owner, 'Schedules');
    for (const [who, role] of [[peer, 'member'], [guest, 'guest']] as const) await addMember(owner, ws.id, who, role);
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    await grant(owner, place.id, peer, 'contributor');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    peerAgentId = (expectStatus(await peer.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Jonas assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    for (const [who, agent] of [[owner, agentId], [peer, peerAgentId]] as const) {
      const connectionId = randomUUID();
      connections.connect(who.id, connectionId);
      await runs.enable(human(who), { agentId: agent, connection: connectionId, model: 'claude-sonnet-5' });
    }
  });
  after(async () => { await pool.query(`DELETE FROM assistant_jobs WHERE owner_user_id = ANY($1)`, [[owner.id, peer.id]]); });
  beforeEach(async () => {
    compute.dispatched = []; compute.respond = answer('Nothing to report');
    sent.length = 0;
    await pool.query(`DELETE FROM assistant_jobs WHERE owner_user_id = ANY($1)`, [[owner.id, peer.id]]);
    await pool.query(`DELETE FROM agent_chat_messages WHERE agent_id = $1`, [agentId]);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    await pool.query(`UPDATE personal_runs SET created_at = created_at - interval '2 days' WHERE owner_user_id = $1`, [owner.id]);
  });

  test('AST-7.1: a weekly review on Monday says "Every Monday at 9:00" with its next times in the owner\'s zone; it belongs to the agent and to no space', async () => {
    const job = await created({ title: 'Weekly review', text: 'Review what moved this week', schedule: { kind: 'weekly', at: '09:00', weekday: 1 }, timeZone: 'Europe/Warsaw' });
    assert.deepEqual([job.title, job.words, job.enabled, job.prepared, job.agentId], ['Weekly review', 'Every Monday at 9:00', true, false, agentId]);
    assert.ok(!('projectId' in job) && !('pausedReason' in job), 'no space, no pause');
    assert.equal(job.next.length, 3);
    assert.ok(job.next.every((item) => /^Mon( \d+ \w+)? 9:00$/.test(item.label)), JSON.stringify(job.next));
    const row = await jobRow(job.id);
    assert.deepEqual([row.enabled, row.owner_user_id, row.agent_id, row.time_zone], [true, owner.id, agentId, 'Europe/Warsaw']);
    assert.equal(new Date(row.next_run_at as string).getTime(), new Date(job.next[0]!.at).getTime());
    assert.equal((await created({ text: 'List what we finished this week' })).title, 'List what we finished this week', 'named from the first words when no name is given');
  });

  test('AST-7.9: a schedule whose text holds a key or a token is refused at save, so no secret is stored', async () => {
    for (const secret of ['Use sk-ant-api03-abcdefghijklmnop to read it', 'Send eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc to them', 'access_token: abcdef123456']) {
      const response = await create({ text: secret });
      assert.deepEqual([response.status, (response.json as { code: string }).code], [400, 'ASSISTANT_JOB_SECRET'], secret);
    }
    assert.equal((await create({ title: 'sk-ant-api03-abcdefghijklmnop' })).status, 400);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM assistant_jobs WHERE owner_user_id = $1`, [owner.id])).rows[0].n), 0);
  });

  test('nobody else sees or runs a schedule: another member, a guest and a stranger get the 404 of one that does not exist; nor can anyone make one for another\'s agent', async () => {
    const job = await created();
    const before = (await runsOf(job.id)).length;
    for (const someone of [peer, guest]) {
      for (const [method, target, body] of [
        ['GET', path(), undefined], ['POST', path(), { text: 'x', schedule: { kind: 'daily', at: '09:00' }, timeZone: 'UTC' }],
        ['PATCH', assistantJobPath(agentId, job.id), { expectedVersion: job.version, enabled: false }], ['DELETE', assistantJobPath(agentId, job.id), undefined],
        ['POST', assistantJobRunNowPath(agentId, job.id), undefined], ['POST', assistantJobRestorePath(agentId, job.id), undefined],
        ['GET', assistantJobHistoryPath(agentId, job.id), undefined], ['GET', assistantJobNotePath(agentId), undefined],
      ] as const) {
        const response = await someone.browser.request(method, target, body === undefined ? {} : { body });
        assert.equal(response.status, 404, `${someone.email} ${method} ${target}: ${response.text}`);
      }
    }
    // Under the peer's own agent the owner's schedule id is nothing either.
    for (const [method, target] of [['PATCH', assistantJobPath(peerAgentId, job.id)], ['POST', assistantJobRunNowPath(peerAgentId, job.id)], ['GET', assistantJobHistoryPath(peerAgentId, job.id)]] as const)
      assert.equal((await peer.browser.request(method, target, method === 'PATCH' ? { body: { expectedVersion: job.version, enabled: false } } : {})).status, 404, `${method} ${target}`);
    assert.equal((await owner.browser.request('POST', path(peerAgentId), { body: { text: 'x', schedule: { kind: 'daily', at: '09:00' }, timeZone: 'UTC' } })).status, 404, 'a schedule for another person\'s agent');
    const anonymous = await fetch(new URL(path(), process.env.FLUX_API_URL ?? 'http://api:8080'));
    assert.equal(anonymous.status, 401);
    assert.equal((await runsOf(job.id)).length, before, 'nobody else started a run');
    assert.deepEqual([(await list())[0]!.enabled, (await list())[0]!.version], [true, job.version]);
  });

  test('AST-7.2: with the clock past the time exactly one run starts, even when two workers tick at once; it runs in the agent\'s chat and its result is a line there, nowhere else', async () => {
    const job = await created({ title: 'Daily check', text: 'Look at the sensor tasks', schedule: daily(9) });
    const fire = tomorrowAt(9);
    assert.equal((await tick(new Date(fire.getTime() - MINUTE))).fired, 0);
    const at = new Date(fire.getTime() + 30_000);
    const results = await Promise.all([tick(at), tick(at), tick(at)]);
    assert.equal(results.reduce((total, item) => total + item.fired, 0), 1, 'exactly one tick fired it');
    const [started, ...more] = await runsOf(job.id);
    assert.equal(more.length, 0, 'one run, not three');
    assert.deepEqual([started!.kind, started!.prompt, started!.project_id, started!.conversation_id, started!.dm_id, started!.agent_id],
      ['scheduled', 'Look at the sensor tasks', null, null, null, agentId], 'a run of the agent\'s chat: no space, no conversation');
    assert.equal((await tick(at)).fired, 0);
    assert.equal(new Date((await jobRow(job.id)).next_run_at as string).getTime(), fire.getTime() + DAY);
    compute.respond = answer('Fact: two sensor tasks are due on Friday.');
    await processAll();
    assert.match(compute.dispatched[0]!.system, /Your owner scheduled this task for you/, 'told it is a scheduled task');
    assert.ok(ASSISTANT_RUN_EFFECT_TOOLS.every((tool) => !(compute.dispatched[0]!.tools ?? []).some((item) => item.name === tool)), 'it reads and changes nothing');
    await tick(new Date(fire.getTime() + 2 * MINUTE));
    const [history] = await firings(job.id);
    assert.deepEqual([history!.state, history!.result_line], ['done', 'Done: Fact: two sensor tasks are due on Friday.']);
    const [row] = await list();
    assert.deepEqual([row!.last?.state, row!.running], ['done', false]);
    // The result is a line in the agent's chat, said once; nothing was posted in any conversation.
    assert.deepEqual(await chatLines(agentId), [{ body: 'Fact: two sensor tasks are due on Friday.', key: `job:${(await pool.query('SELECT id FROM assistant_job_runs WHERE job_id = $1', [job.id])).rows[0].id}`,
      run_id: started!.id, schedule: { title: 'Daily check', words: 'Every day at 9:00', failed: false } }]);
    // The chat lists what its owner said and the answers to it: a schedule's run is none of that, its result is the line above (once, not twice).
    const chatRuns = expectStatus(await owner.browser.request('GET', `${ASSISTANT_RUNS_PATH}?chatAgentId=${agentId}`), 200) as { items: { id: string }[] };
    assert.equal(chatRuns.items.some((item) => item.id === started!.id), false, 'the scheduled run is not a turn of the chat');
    const said = expectStatus(await owner.browser.request('GET', agentChatMessagesPath(agentId)), 200) as { items: AgentChatMessage[] };
    assert.deepEqual(said.items.map((item) => [item.body, item.runId, item.schedule?.title]), [['Fact: two sensor tasks are due on Friday.', started!.id, 'Daily check']]);
    await tick(new Date(fire.getTime() + 3 * MINUTE));
    assert.equal((await chatLines(agentId)).length, 1);
    const answers = expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${thread.id}/assistant-answers`), 200) as { items: { runId: string }[] };
    assert.equal(answers.items.some((item) => item.runId === started!.id), false);
    // Nothing posts a schedule's result into a conversation (#1104): its answer is its owner's alone, and no event tells a space about it.
    const ran = expectStatus(await owner.browser.request('GET', `/api/v1/assistant-runs/${started!.id}`), 200) as { answer: { audience: { kind: string } } | null };
    assert.equal(ran.answer?.audience.kind, 'owner', 'a schedule\'s answer is private, like a chat\'s');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM events WHERE data->>'runId' = $1 AND kind LIKE 'project.assistant%'`, [started!.id])).rows[0].n), 0, 'and the space hears nothing of it');
    // "Nothing to report" says nothing in the chat; the history says it.
    const quiet = await created({ title: 'Quiet', schedule: daily(10) });
    await cycle(1, answer('Nothing to report'));
    await tick(new Date(tomorrowAt(10).getTime() + 30_000));
    await processAll();
    await tick(new Date(tomorrowAt(10).getTime() + 2 * MINUTE));
    assert.deepEqual((await firings(quiet.id)).map((item) => [item.state, item.result_line]), [['done', 'Done: nothing to report']]);
    assert.equal((await chatLines(agentId)).some((line) => line.schedule?.title === 'Quiet'), false);
  });

  test('AST-7.3: with the worker stopped from 8:55 to 9:20 no run happens for 9:00, the history says so, and the next run is the next one due', async () => {
    const job = await created({ schedule: daily(9) });
    const fire = tomorrowAt(9);
    const late = new Date(fire.getTime() + 20 * MINUTE);
    assert.equal((await tick(late)).fired, 1);
    assert.equal((await runsOf(job.id)).length, 0, 'no backlog is run');
    assert.deepEqual((await firings(job.id)).map((item) => [item.state, item.result_line]), [['skipped', 'Skipped: Flux was off at 9:00']]);
    assert.equal(new Date((await jobRow(job.id)).next_run_at as string).getTime(), fire.getTime() + DAY, 'the next one due, not the missed one again');
    const other = await created({ schedule: daily(9), text: 'Second schedule' });
    assert.equal((await tick(new Date(fire.getTime() + 5 * MINUTE))).fired, 1);
    assert.equal((await runsOf(other.id)).length, 1, 'a worker back at 9:05 still starts it: ten minutes of grace');
  });

  test('C-14: failures never pause a schedule: each failed run says so in the chat, the schedule stays on and the next time happens as scheduled; no Inbox item', async () => {
    const job = await created({ title: 'Weekly review', schedule: daily(9) });
    for (const day of [1, 2, 3, 4]) await cycle(day, failing);
    assert.deepEqual((await firings(job.id)).map((item) => item.state), ['failed', 'failed', 'failed', 'failed']);
    const row = await jobRow(job.id);
    assert.equal(row.enabled, true, 'four failures in a row do not pause it');
    assert.equal(new Date(row.next_run_at as string).getTime() > tomorrowAt(9, 0, 4).getTime(), true, 'the next time is set');
    const [view] = await list();
    assert.deepEqual([view!.enabled, view!.next.length], [true, 3]);
    const lines = await chatLines(agentId);
    assert.equal(lines.length, 4, 'a failed run is told in the conversation each time');
    assert.ok(lines.every((line) => line.schedule?.title === 'Weekly review' && line.schedule.failed && line.body.length > 0), JSON.stringify(lines));
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE 'Paused %'`, [owner.id])).rows[0].n), 0);
    await cycle(5, answer('Fact: all fine.'));
    assert.equal((await firings(job.id)).at(-1)!.state, 'done');
  });

  test('a plan limit skips that time and a sign-out fails the run; the words are plain', () => {
    const run = (changes: Record<string, unknown>) => ({ status: 'unavailable', answerBody: null, dispatchedAt: null, planLimitResetsAt: null, endReason: null, provider: 'anthropic', engine: 'runtime',
      stoppedAtStage: null, ...changes }) as never;
    const at = new Date('2026-10-17T10:00:00Z');
    assert.deepEqual(resultOf(run({ endReason: 'plan_limit', planLimitResetsAt: new Date('2026-10-17T14:00:00Z') }), 'UTC', at), { state: 'skipped', line: 'Skipped: Claude limit reached until 14:00' });
    assert.deepEqual(resultOf(run({ endReason: 'plan_limit' }), 'UTC', at), { state: 'skipped', line: 'Skipped: Claude limit reached' });
    assert.deepEqual(resultOf(run({ endReason: 'sign_in_again' }), 'UTC', at), { state: 'failed', line: 'Sign in to Claude again' });
    assert.deepEqual(resultOf(run({ endReason: 'sign_in_again', provider: 'openai' }), 'UTC', at), { state: 'failed', line: 'Sign in to ChatGPT again' });
    assert.deepEqual(resultOf(run({ status: 'completed', answerBody: 'Nothing to report' }), 'UTC', at), { state: 'done', line: 'Done: nothing to report' });
    assert.deepEqual(resultOf(run({ status: 'completed', answerBody: 'Three tasks are due.\nTwo are mine.' }), 'UTC', at), { state: 'done', line: 'Done: Three tasks are due.' });
    assert.deepEqual(resultOf(run({ status: 'stopped' }), 'UTC', at), { state: 'skipped', line: 'Stopped' });
  });

  test('Run now, pause, edit and delete with Undo: the owner\'s own controls; one run at a time', async () => {
    const { assistantJobUseCases } = await import('../../apps/server/src/assistant/jobs.js');
    const jobs = assistantJobUseCases(db, boss, { queue: queue.factory, connections, providerEnabled: true });
    const job = await created({ title: 'Tidy', text: 'Tell me what is open', schedule: daily(9) });
    const started = await jobs.runNow(human(owner), agentId, job.id);
    assert.deepEqual([started.run.firedBy, started.run.state, started.job.running], ['now', 'running', true]);
    await assert.rejects(jobs.runNow(human(owner), agentId, job.id), { code: 'ASSISTANT_JOB_RUNNING' }, 'one run at a time per schedule');
    assert.equal((await runsOf(job.id)).length, 1);
    compute.respond = answer('Fact: three tasks are open.');
    for (const id of queue.runIds.splice(0)) await processor.process(id);
    const [shown] = await jobs.list(human(owner), agentId);
    assert.deepEqual([shown!.running, shown!.last?.state], [false, 'done']);
    assert.equal((await chatLines(agentId)).length, 1, 'Run now reports in the chat like the schedule does');
    assert.equal(new Date((await jobRow(job.id)).next_run_at as string).getTime(), tomorrowAt(9).getTime(), 'Run now does not move the schedule');
    const history = (expectStatus(await owner.browser.request('GET', assistantJobHistoryPath(agentId, job.id)), 200) as { items: { firedBy: string; line: string }[] }).items;
    assert.deepEqual(history.map((item) => item.firedBy), ['now']);

    const patch = async (body: Record<string, unknown>, version: number) => expectStatus(await owner.browser.request('PATCH', assistantJobPath(agentId, job.id), { body: { expectedVersion: version, ...body } }), 200) as unknown as AssistantJob;
    const paused = await patch({ enabled: false }, shown!.version);
    assert.deepEqual([paused.enabled, paused.next, (await jobRow(job.id)).next_run_at], [false, [], null]);
    assert.equal((await tick(tomorrowAt(9, 1))).fired, 0, 'a paused schedule never catches up');
    const edited = await patch({ enabled: true, text: 'Tell me what is open and what is done', schedule: { kind: 'weekdays', at: '08:30' }, timeZone: 'Europe/Warsaw' }, paused.version);
    assert.deepEqual([edited.words, edited.enabled, edited.timeZone, edited.title], ['Weekdays at 8:30', true, 'Europe/Warsaw', 'Tidy']);
    const stale = await owner.browser.request('PATCH', assistantJobPath(agentId, job.id), { body: { expectedVersion: paused.version, enabled: false } });
    assert.deepEqual([stale.status, (stale.json as { code: string }).code], [409, 'VERSION_CONFLICT']);

    const removed = expectStatus(await owner.browser.request('DELETE', assistantJobPath(agentId, job.id)), 200) as unknown as AssistantJob;
    assert.equal(removed.id, job.id);
    assert.equal((await list()).length, 0);
    await pool.query(`UPDATE assistant_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [job.id]);
    assert.equal((await tick(new Date(Date.now() + 3600_000))).fired, 0, 'a deleted schedule does not run');
    const restored = expectStatus(await owner.browser.request('POST', assistantJobRestorePath(agentId, job.id)), 200) as unknown as AssistantJob;
    assert.deepEqual([restored.enabled, (await list()).length], [true, 1]);
    expectStatus(await owner.browser.request('DELETE', assistantJobPath(agentId, job.id)), 200);
    await pool.query(`UPDATE assistant_jobs SET deleted_at = now() - interval '25 hours' WHERE id = $1`, [job.id]);
    assert.equal((await owner.browser.request('POST', assistantJobRestorePath(agentId, job.id))).status, 404);
    await tick(tomorrowAt(9, 1, 3));
    assert.equal((await pool.query(`SELECT 1 FROM assistant_jobs WHERE id = $1`, [job.id])).rowCount, 0, 'after a day the delete is final and the history goes');
  });

  test('the history keeps the last 20 firings; and Flux sets no runs a day (#843)', async () => {
    const job = await created({ schedule: daily(9) });
    for (let index = 0; index < 23; index++) await pool.query(`INSERT INTO assistant_job_runs (id, job_id, owner_user_id, fired_at, fired_by, state, result_line, finished_at)
      VALUES ($1, $2, $3, $4, 'schedule', 'skipped', 'Skipped: Flux was off at 9:00', now())`, [randomUUID(), job.id, owner.id, new Date(Date.UTC(2026, 0, 1 + index, 9))]);
    for (let index = 0; index < 30; index++) await pool.query(`INSERT INTO assistant_job_runs (id, job_id, owner_user_id, fired_at, fired_by, state, result_line, finished_at)
      VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval, 'now', 'done', 'Done', now())`, [randomUUID(), job.id, owner.id, String(index + 1)]);
    await cycle(1, answer('Nothing to report'));
    assert.equal((await runsOf(job.id)).length, 1, 'it fired: fifty earlier runs are no limit');
    const rows = (expectStatus(await owner.browser.request('GET', assistantJobHistoryPath(agentId, job.id)), 200) as { items: unknown[] }).items;
    assert.equal(rows.length, 20);
  });

  test('AST-9.1: a scheduled run reads through the tools its owner\'s agent has in its chat; another agent\'s schedule and chat are none of its business', async () => {
    const mine = await created({ title: 'Mine', schedule: daily(9) });
    const theirs = expectStatus(await create({ title: 'Theirs', schedule: daily(9) }, peer, peerAgentId), 201) as unknown as AssistantJob;
    await pool.query(`UPDATE assistant_jobs SET next_run_at = $2 WHERE id = $1`, [theirs.id, tomorrowAt(9)]);
    await tick(new Date(tomorrowAt(9).getTime() + 30_000));
    const [own] = await runsOf(mine.id); const [other] = await runsOf(theirs.id);
    assert.deepEqual([own!.agent_id, other!.agent_id], [agentId, peerAgentId], 'each schedule runs as its own agent');
    compute.respond = answer('Fact: ok.');
    await processAll();
    await tick(new Date(tomorrowAt(9).getTime() + 2 * MINUTE));
    assert.equal((await chatLines(agentId)).length, 1);
    assert.equal((await chatLines(peerAgentId)).length, 1);
    assert.equal((await chatLines(peerAgentId))[0]!.schedule?.title, 'Theirs');
    await pool.query(`DELETE FROM agent_chat_messages WHERE agent_id = $1`, [peerAgentId]);
  });

  test('AG-9 "Set up by asking": what the owner says to the agent in its chat prepares a schedule that stays off; `/ai` in a space and a scheduled run prepare none', async () => {
    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    const block = '<schedule>{"title": "Weekday summary", "text": "Summarise what changed in Lamp sensor", "when": {"kind": "weekdays", "at": "09:00"}}</schedule>';
    compute.respond = answer(`I prepared a weekday summary at 9. ${block}`);
    const said = await runs.invoke(human(owner), { kind: 'chat', agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Every weekday at 9, summarise what changed in Lamp sensor' });
    assert.equal(await processor.process(said.run.id), 'completed');
    assert.match(compute.dispatched.at(-1)!.system, /<schedule>/, 'the chat\'s brief tells how to prepare one');
    const [prepared] = await list();
    assert.deepEqual([prepared!.title, prepared!.words, prepared!.enabled, prepared!.prepared, prepared!.preparedRunId], ['Weekday summary', 'Weekdays at 9:00', false, true, said.run.id]);
    assert.equal(prepared!.next.length, 0, 'off until the owner turns it on');
    const answered = (await pool.query('SELECT answer_body FROM personal_runs WHERE id = $1', [said.run.id])).rows[0].answer_body as string;
    assert.equal(answered.includes('<schedule>'), false, 'the block is taken out of the words');
    assert.match(answered, /I prepared a weekday summary at 9/);
    // The owner's own tap turns it on; nobody else can.
    const on = expectStatus(await owner.browser.request('PATCH', assistantJobPath(agentId, prepared!.id), { body: { expectedVersion: prepared!.version, enabled: true } }), 200) as unknown as AssistantJob;
    assert.deepEqual([on.enabled, on.prepared, on.next.length], [true, false, 3]);

    // `/ai` in a space's conversation drops the block and prepares nothing; so does a run of a schedule.
    const before = (await list()).length;
    compute.respond = answer(`Done. ${block}`);
    const inSpace = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Every weekday at 9, summarise this' });
    assert.equal(await processor.process(inSpace.run.id), 'completed');
    assert.doesNotMatch(compute.dispatched.at(-1)!.system, /<schedule>/, 'a space\'s brief does not offer it');
    const job = await created({ title: 'Loop', schedule: daily(9) });
    await cycle(1, answer(`Fact: x. ${block}`));
    assert.equal((await list()).length, before + 1, 'only the schedule made through the API was added');
    assert.equal((await runsOf(job.id)).length, 1);
  });
  /** The chat's own run of the owner's sentence: the model answers with `answerText`; the run is processed; the schedule it prepared is returned. */
  async function prepareBy(prompt: string, answerText: string) {
    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    compute.respond = answer(answerText);
    const said = await runs.invoke(human(owner), { kind: 'chat', agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt });
    assert.equal(await processor.process(said.run.id), 'completed');
    const prepared = (await list()).find((item) => item.preparedRunId === said.run.id)!;
    assert.ok(prepared, 'the sentence prepared a schedule');
    return prepared;
  }
  const turnOn = async (job: AssistantJob) => {
    const on = expectStatus(await owner.browser.request('PATCH', assistantJobPath(agentId, job.id), { body: { expectedVersion: job.version, enabled: true } }), 200) as unknown as AssistantJob;
    await pool.query(`UPDATE assistant_jobs SET next_run_at = $2 WHERE id = $1`, [job.id, tomorrowAt(9)]);
    return on;
  };
  const fireOnce = async (job: AssistantJob) => {
    await tick(new Date(tomorrowAt(9).getTime() + 30_000));
    const [run] = await runsOf(job.id);
    return run!.id;
  };
  const block = (text: string) => `Prepared. <schedule>${JSON.stringify({ title: 'Task summary', text, when: { kind: 'weekdays', at: '09:00' } })}</schedule>`;

  test('deleting an agent deletes its schedules: nothing fires for it and no history piles up', async () => {
    const second = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Gone soon', owner: 'self' } }), 201) as { id: string }).id;
    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    await runs.enable(human(owner), { agentId: second, connection: connectionId, model: 'claude-sonnet-5' });
    const mine = await created({ title: 'Stays', schedule: daily(9) });
    const made: AssistantJob[] = [];
    for (const title of ['One', 'Two']) {
      const job = expectStatus(await create({ title, schedule: daily(9) }, owner, second), 201) as unknown as AssistantJob;
      await pool.query(`UPDATE assistant_jobs SET next_run_at = $2 WHERE id = $1`, [job.id, tomorrowAt(9)]);
      made.push(job);
    }
    expectStatus(await owner.browser.request('DELETE', `/api/v1/my-agents/${second}`), 204);
    const left = (await pool.query(`SELECT count(*)::int AS n FROM assistant_jobs WHERE agent_id = $1`, [second])).rows[0].n as number;
    assert.equal(left, 0, 'its schedules went with it');
    assert.equal((await tick(new Date(tomorrowAt(9).getTime() + 30_000))).fired, 1, 'only the schedule of the agent that is still there fired');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM assistant_job_runs WHERE job_id = ANY($1)`, [made.map((job) => job.id)])).rows[0].n, 0, 'no history for a deleted agent');
    assert.equal((await runsOf(mine.id)).length, 1);
    assert.equal((await list()).length, 1, 'the other agent keeps its own');
  });

  test('C-53: a firing that cannot start says so in the agent\'s chat, once while it stays the same, and keeps the history short', async () => {
    const job = await created({ title: 'Morning summary', schedule: daily(9) });
    const refuse = (line: string, outcome: 'failed' | 'skipped' = 'failed') => async (): Promise<BackgroundStart> => ({ started: false, outcome, line });
    const tickWith = (day: number, start: () => Promise<BackgroundStart>) => assistantTick({ uow: assistantUnitOfWork(db, boss), startBackground: start }, new Date(tomorrowAt(9, 0, day).getTime() + 30_000));
    // The chat was read up to now, so what is unread afterwards is this line alone (earlier tests left answers in it).
    expectStatus(await owner.browser.request('POST', agentChatReadPath(agentId)), 204);
    await tickWith(1, refuse('Sign in to Claude again'));
    const [first] = await chatLines(agentId);
    assert.deepEqual([first!.body, first!.run_id, first!.schedule], ['Sign in to Claude again', null, { title: 'Morning summary', words: 'Every day at 9:00', failed: true }]);
    assert.match(first!.key, /^job:/);
    const said = expectStatus(await owner.browser.request('GET', agentChatMessagesPath(agentId)), 200) as { items: AgentChatMessage[] };
    assert.deepEqual(said.items.map((item) => [item.body, item.runId, item.schedule?.failed]), [['Sign in to Claude again', null, true]]);
    const unread = (expectStatus(await owner.browser.request('GET', '/api/v1/agent-chats'), 200) as { items: { agentId: string; unread: number }[] }).items.find((item) => item.agentId === agentId);
    assert.equal(unread?.unread, 1, 'the sidebar dot has it');
    // The same failure on the next days says nothing new; a different one is told; the schedule stays on throughout.
    await tickWith(2, refuse('Sign in to Claude again'));
    assert.equal((await chatLines(agentId)).length, 1);
    await tickWith(3, refuse('Skipped: not enough left of your API key\'s daily budget', 'skipped'));
    assert.deepEqual((await chatLines(agentId)).map((line) => [line.body, line.schedule?.failed]), [['Sign in to Claude again', true], ['Skipped: not enough left of your API key\'s daily budget', true]]);
    assert.equal((await jobRow(job.id)).enabled, true);
    // Every firing is in the history, which never holds more than the last twenty.
    for (let day = 4; day <= 26; day++) await tickWith(day, refuse('Sign in to Claude again'));
    assert.equal((await firings(job.id)).length, 20);
  });

  test('a scheduled run cannot be retried; Run now is the way to run it again', async () => {
    const prepared = await prepareBy('Every weekday at 9, summarise my tasks', block('Summarise my tasks'));
    await turnOn(prepared);
    assert.ok(await fireOnce(prepared));
    compute.respond = failing;
    await processAll();
    const [fired] = await runsOf(prepared.id);
    assert.equal((await pool.query(`SELECT status FROM personal_runs WHERE id = $1`, [fired!.id])).rows[0].status, 'provider_failed', 'a failed scheduled run, the case a retry is offered for');
    const before = Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id = $1`, [owner.id])).rows[0].n);
    const refused = await owner.browser.request('POST', assistantRunRetryPath(fired!.id), { body: { clientRunId: randomUUID() } });
    assert.deepEqual([refused.status, (refused.json as { code: string }).code], [409, 'ASSISTANT_RUN_NOT_RETRYABLE']);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id = $1`, [owner.id])).rows[0].n), before, 'no run was made');
  });

  test('deleting an agent and a firing of its schedule in the same moment take the schedule row before the owner\'s lock, as a firing does: no deadlock', async () => {
    const second = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Racing', owner: 'self' } }), 201) as { id: string }).id;
    const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    await runs.enable(human(owner), { agentId: second, connection: connectionId, model: 'claude-sonnet-5' });
    const job = expectStatus(await create({ title: 'Racing', schedule: daily(9) }, owner, second), 201) as unknown as AssistantJob;
    const waiting = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)).rows[0].n);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A firing holds its schedule row ...
      await client.query(`SELECT id FROM assistant_jobs WHERE id = $1 FOR UPDATE`, [job.id]);
      const baseline = await waiting();
      const deleting = owner.browser.request('DELETE', `/api/v1/my-agents/${second}`);
      await waitFor(async () => (await waiting()) > baseline, 'the deletion waiting for the schedule row');
      // ... and then takes the owner's lock (`fireJob`). The deletion has not taken that lock yet, so this does not wait for it and nothing deadlocks.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['assistant-owner:' + owner.id]);
      await client.query('COMMIT');
      expectStatus(await deleting, 204);
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM assistant_jobs WHERE agent_id = $1`, [second])).rows[0].n), 0);
  });

  test('settling a firing takes the schedule row before the firing\'s own row, the order of agent deletion: it holds no firing while it waits for the schedule', async () => {
    const job = await created({ title: 'Settling', schedule: daily(9) });
    const firingId = randomUUID();
    await pool.query(`INSERT INTO assistant_job_runs (id, job_id, owner_user_id, fired_at, fired_by, state, result_line) VALUES ($1, $2, $3, now(), 'now', 'running', '')`, [firingId, job.id, owner.id]);
    const waiting = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)).rows[0].n);
    const client = await pool.connect();
    const other = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM assistant_jobs WHERE id = $1 FOR UPDATE`, [job.id]);
      const baseline = await waiting();
      const settling = assistantUnitOfWork(db, boss).run((ports) => settleOne(ports, firingId, new Date()));
      await waitFor(async () => (await waiting()) > baseline, 'the settling waiting for the schedule row');
      // It waits for the schedule row and holds nothing of the firing: another transaction can take the firing at once. With the firing first
      // (the old order) this would fail with "could not obtain lock", and a deletion of the agent in between would deadlock with it.
      await other.query('BEGIN');
      await other.query(`SELECT id FROM assistant_job_runs WHERE id = $1 FOR UPDATE NOWAIT`, [firingId]);
      await other.query('COMMIT');
      await client.query('COMMIT');
      assert.equal(await settling, true);
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); await other.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); other.release(); }
    assert.deepEqual((await firings(job.id)).map((item) => item.state), ['failed'], 'a firing with no run ends as failed');
  });

  test('a long answer of non-word characters does not stall "nothing to report" (a polynomial regular expression)', () => {
    const started = Date.now();
    for (const text of ['done' + ' '.repeat(64_000) + 'x', '!'.repeat(64_000) + 'x', 'done.' + '\n'.repeat(64_000) + 'nothing to reportx']) assert.equal(nothingToReport(text), false);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
    for (const text of ['Nothing to report', 'Done. Nothing to report.', '  done -  nothing new ', '(No answer text.)', '']) assert.equal(nothingToReport(text), true, text);
  });
});
