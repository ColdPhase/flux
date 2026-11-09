import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { AGENT_CHATS_PATH, AGENT_CONNECTIONS_PATH, ASSISTANT_MODEL_PATH, ASSISTANT_RUNS_PATH, MY_AGENTS_PATH, PERSONAL_ASSISTANT_PATH, agentAssistantRunsPath, agentChatMessagesPath,
  agentConnectionPath, assistantJobHistoryPath, assistantJobPath, assistantJobRestorePath, assistantJobRunNowPath, assistantJobsPath, assistantRunChangesActionPath,
  assistantRunChangesPath, assistantRunDismissPath, conversationAssistantChangesPath, dmAssistantRunsPath, IDEMPOTENCY_KEY_HEADER, INBOX_PATH, assistantRunPath, assistantRunRetryPath, assistantRunShowPath, assistantRunStopPath, backgroundComputeConnectionPath,
  backgroundComputeConnectionsPath, conversationAssistantRunsPath, myAgentPath, type AgentConnection, type AssistantJob, type AssistantModelChoice, type AssistantRun,
  type AssistantChange, type BackgroundComputeConnection, type Conversation, type Dm, type MyAgent, type PersonalAssistantStatus } from '@flux/contracts';
import type { PgBoss } from 'pg-boss';
import { assistantJobRows } from '@flux/db';
import { assistantTick, type TickDeps } from '@flux/core';
import { assistantUnitOfWork } from '../../apps/worker/src/assistant/index.js';
import { db, pool } from './support/db.js';
import { expectStatus, grant, person, project as createProject, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';

// A member made a guest keeps their agents, API keys and client connections, hidden and refused everywhere while they are a guest of the
// company, and has them back, the same ones, as a member again (#1035, C-50, AG-2). The company's role decides; a role elsewhere changes nothing.
// Schedules and old `/ai` runs follow the same rule (#1059): none is listed, read, changed, run or shown to everyone, no plan sign-in or model is
// shown, and a schedule neither fires nor writes a "Skipped" row; as a member again they are all back.
// The keys part runs on any stack. The agents part needs AI switched on for the server (the check stack with FLUX_TEST_PERSONAL_RUNS=anthropic-mock and
// FLUX_TEST_ANTHROPIC_URL=http://providermock:8095) because saving the first key makes the person's Assistant there; it is skipped otherwise.

const live = process.env.FLUX_TEST_PERSONAL_RUNS === 'anthropic-mock';
const keyBody = (tag: string) => ({ name: `Key ${tag}`, provider: 'anthropic', model: 'claude-sonnet-5', timeZone: 'Europe/Warsaw', dailyBudgetCents: 50,
  apiKey: `sk-ant-api03-keeps-ai-key-keeps-ai-key-keeps-ai-key-${tag}` });

describe('a member made a guest keeps their AI, hidden and refused, and has it back as a member (#1035)', () => {
  let boss: Person; let keeper: Person; let company: string;
  const becomes = async (role: 'guest' | 'member') => expectStatus(await boss.browser.request('PATCH', `/api/v1/workspaces/${company}/members/${keeper.id}`, { body: { role } }), 200);
  const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_user_id = $1 AND revoked_at IS NULL`, [keeper.id])).rows[0].n);
  const keys = async () => expectStatus(await keeper.browser.request('GET', backgroundComputeConnectionsPath), 200) as BackgroundComputeConnection[];

  before(async () => {
    [boss, keeper] = await Promise.all(['gka-boss', 'gka-keeper'].map(person));
    company = (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows[0]!.id;
    for (const [someone, role] of [[boss, 'owner'], [keeper, 'member']] as const)
      await pool.query('INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, $3, $2)', [company, someone.id, role]);
  });

  test('the API key is hidden and refused for a guest, stays saved, and is back for a member', async () => {
    const saved = expectStatus(await keeper.browser.request('POST', backgroundComputeConnectionsPath, { body: keyBody('KP01') }), 201) as BackgroundComputeConnection;
    assert.deepEqual((await keys()).map((item) => item.id), [saved.id]);

    await becomes('guest');

    assert.deepEqual(await keys(), [], 'no key is listed');
    assert.equal((await keeper.browser.request('PATCH', backgroundComputeConnectionPath(saved.id), { body: { name: 'Renamed by a guest' } })).status, 404, 'renaming is refused');
    assert.equal((await keeper.browser.request('DELETE', backgroundComputeConnectionPath(saved.id))).status, 404, 'so is removing');
    assert.equal(await count('background_compute_connections'), 1, 'it is kept, sealed and unrevoked');

    await becomes('member');

    assert.deepEqual((await keys()).map((item) => [item.id, item.name]), [[saved.id, 'Key KP01']], 'the same key is back');
    assert.equal((await keeper.browser.request('PATCH', backgroundComputeConnectionPath(saved.id), { body: { name: 'Back as a member' } })).status, 200);
  });

  test('the agent, its client connection, its chat and its status are hidden and refused for a guest, change nothing, and come back for a member', { skip: !live && 'needs FLUX_TEST_PERSONAL_RUNS=anthropic-mock' }, async () => {
    // The key above made Assistant (the first connection); it has its connection.
    const agents = async () => (expectStatus(await keeper.browser.request('GET', MY_AGENTS_PATH), 200) as { items: MyAgent[] }).items;
    const [assistant] = await agents();
    assert.equal(assistant?.name, 'Assistant');
    const connections = async () => expectStatus(await keeper.browser.request('GET', AGENT_CONNECTIONS_PATH), 200) as AgentConnection[];
    const [connection] = await connections();
    assert.ok(connection, 'Assistant has a connection');
    const status = async () => expectStatus(await keeper.browser.request('GET', PERSONAL_ASSISTANT_PATH), 200) as PersonalAssistantStatus;
    assert.equal((await status()).state, 'ready');
    const before = [await count('agents'), await count('agent_connections')];
    assert.deepEqual(before, [1, 1]);

    await becomes('guest');

    assert.deepEqual(await agents(), [], 'the agent list is empty');
    assert.equal((await keeper.browser.request('GET', myAgentPath(assistant!.id))).status, 404, 'its page is not found');
    assert.equal((await keeper.browser.request('PATCH', myAgentPath(assistant!.id), { body: { name: 'Renamed by a guest' } })).status, 404, 'renaming is refused');
    assert.equal((await keeper.browser.request('DELETE', myAgentPath(assistant!.id))).status, 404, 'so is deleting');
    assert.equal((await keeper.browser.request('GET', `${myAgentPath(assistant!.id)}/memory`)).status, 404, 'and its memory');
    const asleep = await status();
    assert.equal(asleep.state, 'not_enabled', 'the assistant is not set up');
    assert.equal(asleep.enablement, null);
    assert.deepEqual(await connections(), [], 'no client connection is listed');
    assert.equal((await keeper.browser.request('PATCH', agentConnectionPath(connection.id), { body: { mayDo: 'act' } })).status, 404);
    assert.equal((await keeper.browser.request('DELETE', agentConnectionPath(connection.id))).status, 404);
    assert.deepEqual(expectStatus(await keeper.browser.request('GET', AGENT_CHATS_PATH), 200), { items: [] }, 'no agent conversation in Messages');
    assert.equal((expectStatus(await keeper.browser.request('GET', ASSISTANT_RUNS_PATH), 200) as { total: number }).total, 0, 'and no run is listed');
    assert.equal((await keeper.browser.request('GET', agentChatMessagesPath(assistant!.id))).status, 404);
    const run = await keeper.browser.request('POST', agentAssistantRunsPath(assistant!.id), { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'Hello' } });
    assert.ok(run.status >= 400 && run.status < 500, `a chat with it is refused: ${run.status}`);
    assert.deepEqual([await count('agents'), await count('agent_connections')], before, 'nothing was removed');

    await becomes('member');

    assert.deepEqual((await agents()).map((agent) => [agent.id, agent.name]), [[assistant!.id, 'Assistant']], 'the same agent is back');
    assert.equal((await status()).state, 'ready');
    assert.deepEqual((await connections()).map((item) => item.id), [connection.id], 'and its connection');
    assert.equal((await keeper.browser.request('PATCH', myAgentPath(assistant!.id), { body: { name: 'Back as a member' } })).status, 200);
  });
  const DAY = 86_400_000;
  /** 09:00 UTC tomorrow: ahead of the real clock, so only this test's own tick (it takes `now`) ever meets a schedule set to it. */
  const tomorrowAt9 = () => { const base = new Date(Date.now() + DAY); return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 9)); };
  const jobs = async (job?: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM assistant_jobs WHERE owner_user_id = $1 ${job ? 'AND id = $2 AND deleted_at IS NULL' : ''}`,
    job ? [keeper.id, job] : [keeper.id])).rows[0].n);

  test('schedules, an old /ai run with its changes, and the model list are hidden and refused for a guest, change nothing, and come back for a member (#1059)', { skip: !live && 'needs FLUX_TEST_PERSONAL_RUNS=anthropic-mock' }, async () => {
    const space = await createProject(boss, company, 'Guest keeps schedules', 'restricted');
    await grant(boss, space.id, keeper, 'contributor');
    const thread = expectStatus(await keeper.browser.request('POST', `/api/v1/projects/${space.id}/conversations`,
      { body: { body: 'What is the probe about?', clientMessageId: randomUUID() } }), 201) as Conversation;
    const schedules = assistantJobsPath(company, keeper.id);
    const job = expectStatus(await keeper.browser.request('POST', schedules, { body: { projectId: space.id, title: 'Secret weekly prompt', text: 'Summarise the week',
      schedule: { kind: 'weekly', at: '09:00', weekday: 1 }, timeZone: 'UTC', enabled: false } }), 201) as AssistantJob;
    const asked = expectStatus(await keeper.browser.request('POST', conversationAssistantRunsPath(thread.id),
      { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'What is the probe about?' } }), 202) as AssistantRun;
    const run = await waitFor(async () => {
      const current = expectStatus(await keeper.browser.request('GET', assistantRunPath(asked.id)), 200) as AssistantRun;
      return ['queued', 'reading', 'dispatching'].includes(current.status) ? null : current;
    }, 'the private answer');
    const listed = async () => (expectStatus(await keeper.browser.request('GET', schedules), 200) as { items: AssistantJob[] }).items;
    const models = async () => expectStatus(await keeper.browser.request('GET', ASSISTANT_MODEL_PATH), 200) as AssistantModelChoice;
    assert.deepEqual((await listed()).map((item) => item.id), [job.id]);
    assert.equal((await models()).groups.length, 1, 'the key is a model to choose from');
    const aRow = async () => (await pool.query('SELECT shown_at, dismissed_at, status FROM personal_runs WHERE id = $1', [run.id])).rows[0] as { shown_at: Date | null; dismissed_at: Date | null; status: string };
    const before = await aRow();

    await becomes('guest');

    assert.deepEqual(await listed(), [], 'no schedule is listed');
    const refuse = async (method: string, path: string, body?: unknown) => {
      const response = await keeper.browser.request(method, path, body === undefined ? {} : { body });
      assert.equal(response.status, 404, `${method} ${path}: ${response.text}`);
    };
    await refuse('GET', assistantJobHistoryPath(company, keeper.id, job.id));
    await refuse('PATCH', assistantJobPath(company, keeper.id, job.id), { expectedVersion: job.version, title: 'Renamed by a guest' });
    await refuse('DELETE', assistantJobPath(company, keeper.id, job.id));
    await refuse('POST', assistantJobRestorePath(company, keeper.id, job.id));
    await refuse('POST', assistantJobRunNowPath(company, keeper.id, job.id));
    assert.equal(await jobs(job.id), 1, 'the schedule is kept, not deleted');
    await refuse('GET', assistantRunPath(run.id));
    await refuse('GET', assistantRunChangesPath(run.id));
    for (const action of ['apply', 'skip', 'undo'] as const) await refuse('POST', assistantRunChangesActionPath(run.id, action));
    await refuse('POST', assistantRunStopPath(run.id));
    await refuse('POST', assistantRunDismissPath(run.id));
    await refuse('POST', assistantRunShowPath(run.id));
    await refuse('POST', assistantRunRetryPath(run.id), { clientRunId: randomUUID() });
    assert.deepEqual(await aRow(), before, 'the old run is as it was: not shown, not dismissed, not stopped');
    assert.equal((expectStatus(await keeper.browser.request('GET', ASSISTANT_RUNS_PATH), 200) as { total: number }).total, 0, 'and no run is listed');
    const asleep = await models();
    assert.deepEqual([asleep.groups, asleep.default, asleep.current, asleep.saved], [[], null, null, false], 'no model to choose from');
    const setup = ((expectStatus(await keeper.browser.request('GET', PERSONAL_ASSISTANT_PATH), 200) as PersonalAssistantStatus)).setup;
    assert.deepEqual([setup.connection, setup.runtime.state], ['none', 'off'], 'and the status shows no key and no plan sign-in');

    await becomes('member');

    assert.deepEqual((await listed()).map((item) => [item.id, item.title]), [[job.id, 'Secret weekly prompt']], 'the same schedule is back');
    expectStatus(await keeper.browser.request('GET', assistantJobHistoryPath(company, keeper.id, job.id)), 200);
    assert.equal((expectStatus(await keeper.browser.request('GET', assistantRunPath(run.id)), 200) as AssistantRun).prompt, 'What is the probe about?', 'and the same run');
    expectStatus(await keeper.browser.request('GET', assistantRunChangesPath(run.id)), 200);
    assert.equal((await models()).groups.length, 1, 'and the model list');
    // A change is accepted again: delete, then bring it back with Undo.
    expectStatus(await keeper.browser.request('DELETE', assistantJobPath(company, keeper.id, job.id)), 200);
    expectStatus(await keeper.browser.request('POST', assistantJobRestorePath(company, keeper.id, job.id)), 200);
    assert.notEqual((await keeper.browser.request('POST', assistantRunShowPath(run.id))).status, 404, 'Show everyone finds the run again (an answer to show or not)');
    await pool.query('DELETE FROM assistant_jobs WHERE owner_user_id = $1', [keeper.id]);
  });

  test('a guest\'s schedule does not fire and writes no history, and fires at its next time once they are a member again (#1059)', { skip: !live && 'needs FLUX_TEST_PERSONAL_RUNS=anthropic-mock' }, async () => {
    await becomes('member');
    const space = await createProject(boss, company, 'Guest schedule does not fire', 'restricted');
    await grant(boss, space.id, keeper, 'contributor');
    expectStatus(await keeper.browser.request('POST', `/api/v1/projects/${space.id}/conversations`, { body: { body: 'Where to post?', clientMessageId: randomUUID() } }), 201);
    const job = expectStatus(await keeper.browser.request('POST', assistantJobsPath(company, keeper.id), { body: { projectId: space.id, title: 'Daily check', text: 'Look at the week',
      schedule: { kind: 'daily', at: '09:00' }, timeZone: 'UTC' } }), 201) as AssistantJob;
    assert.equal(job.enabled, true);
    const fire = tomorrowAt9();
    const dueAt = async (at: Date) => pool.query('UPDATE assistant_jobs SET next_run_at = $2, last_run_at = NULL WHERE id = $1', [job.id, at]);
    const row = async () => (await pool.query('SELECT enabled, next_run_at, last_run_at FROM assistant_jobs WHERE id = $1', [job.id])).rows[0] as { enabled: boolean; next_run_at: Date | null; last_run_at: Date | null };
    const history = async () => (await pool.query('SELECT state, result_line FROM assistant_job_runs WHERE job_id = $1 ORDER BY fired_at', [job.id])).rows as { state: string; result_line: string }[];
    const pgBoss = { send: async () => randomUUID() } as unknown as Pick<PgBoss, 'send'>;
    const started: string[] = [];
    const startBackground: TickDeps['startBackground'] = async (_ports, spec) => { started.push(spec.prompt); return { started: false, outcome: 'skipped', line: 'Skipped: a test double' }; };
    const tick = (at: Date) => assistantTick({ uow: assistantUnitOfWork(db, pgBoss), startBackground }, at);

    await dueAt(fire);
    await becomes('guest');
    await tick(new Date(fire.getTime() + 60_000));
    await tick(new Date(fire.getTime() + DAY + 60_000));
    assert.deepEqual(started, [], 'nothing was started for a guest');
    assert.deepEqual(await history(), [], 'and no "Skipped" row was written');
    const waiting = await row();
    assert.deepEqual([waiting.enabled, waiting.last_run_at], [true, null], 'the schedule is kept as it was, with no last run');
    assert.equal(new Date(waiting.next_run_at!).getTime(), fire.getTime() + 2 * DAY, 'and moved on to its next time after now');

    await becomes('member');
    await dueAt(fire);
    await tick(new Date(fire.getTime() + 60_000));
    assert.deepEqual(started, ['Look at the week'], 'as a member it fires again');
    assert.deepEqual(await history(), [{ state: 'skipped', result_line: 'Skipped: a test double' }]);
    await pool.query('DELETE FROM assistant_jobs WHERE owner_user_id = $1', [keeper.id]);
  });
  const finished = (runId: string) => waitFor(async () => {
    const current = expectStatus(await keeper.browser.request('GET', assistantRunPath(runId)), 200) as AssistantRun;
    return ['queued', 'reading', 'dispatching'].includes(current.status) ? null : current;
  }, 'the private answer');

  test('an old /ai request is not replayed to a guest in a space, a direct message or with an Idempotency-Key, and the conversation\'s change list gives them only what was done (#1090)', { skip: !live && 'needs FLUX_TEST_PERSONAL_RUNS=anthropic-mock' }, async () => {
    await becomes('member');
    const space = await createProject(boss, company, 'Guest replays nothing', 'restricted');
    await grant(boss, space.id, keeper, 'contributor');
    const thread = expectStatus(await keeper.browser.request('POST', `/api/v1/projects/${space.id}/conversations`,
      { body: { body: 'What is the replay probe about?', clientMessageId: randomUUID() } }), 201) as Conversation;
    const dm = expectStatus(await keeper.browser.request('POST', `/api/v1/workspaces/${company}/dms`, { body: { participantIds: [boss.id] } }), 201) as Dm;
    const ask = (path: string, body: unknown, headers?: Record<string, string>) => keeper.browser.request('POST', path, { body, ...(headers ? { headers } : {}) });
    const body = (tag: string) => ({ clientRunId: randomUUID(), kind: 'ask', prompt: `Private prompt of the replay probe ${tag}` });
    const spacePath = conversationAssistantRunsPath(thread.id); const dmPath = dmAssistantRunsPath(dm.id);
    const inSpace = body('space'); const inDm = body('dm'); const keyed = body('key'); const key = randomUUID();
    const spaceRun = expectStatus(await ask(spacePath, inSpace), 202) as AssistantRun;
    const dmRun = expectStatus(await ask(dmPath, inDm), 202) as AssistantRun;
    const keyedRun = expectStatus(await ask(spacePath, keyed, { [IDEMPOTENCY_KEY_HEADER]: key }), 202) as AssistantRun;
    for (const started of [spaceRun, dmRun, keyedRun]) await finished(started.id);

    // Four changes of the space run, as its assistant left them: the owner's own refusal, skip and waiting change, and one that was done.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      for (const [state, title, extra] of [['refused', 'Secret task refused', { refusal: 'Private refusal of the probe' }], ['skipped', 'Secret task skipped', {}],
        ['waiting', 'Secret task waiting', { wait: 'ask' }], ['applied', 'Public task applied', { authority: 'owner_request' }]] as const) {
        const id = randomUUID();
        await client.query(`INSERT INTO assistant_changes (id, workspace_id, project_id, run_id, conversation_id, owner_user_id, agent_id, client_command_id, fingerprint, tool, operation,
          object_type, object_title, state, wait_reason, authority, refusal, prepared_command, receipt) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'flux_update_task', 'work.update', 'work', $10, $11, $12, $13, $14, $15, $16)`,
        [id, company, space.id, spaceRun.id, thread.id, keeper.id, spaceRun.agentId, randomUUID(), createHash('sha256').update(id).digest('hex'), title, state,
          (extra as { wait?: string }).wait ?? null, (extra as { authority?: string }).authority ?? null, (extra as { refusal?: string }).refusal ?? null,
          state === 'waiting' ? JSON.stringify({ tool: 'flux_update_task', args: {} }) : null, state === 'applied' ? '{}' : null]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const changes = async () => ((expectStatus(await keeper.browser.request('GET', conversationAssistantChangesPath(thread.id)), 200) as { items: AssistantChange[] }).items).map((item) => item.state).sort();
    assert.deepEqual(await changes(), ['applied', 'refused', 'skipped', 'waiting'], 'the owner reads all four');
    const replayed = async (path: string, request: { clientRunId: string }, headers?: Record<string, string>) => ask(path, request, headers);
    assert.equal((await replayed(spacePath, inSpace)).status, 200, 'a member\'s replay returns the run');

    await becomes('guest');

    for (const [path, request, headers] of [[spacePath, inSpace, undefined], [dmPath, inDm, undefined]] as const) {
      const response = await replayed(path, request, headers);
      assert.equal(response.status, 409, `${path}: ${response.text}`);
      assert.equal((response.json as { code?: string }).code, 'PERSONAL_RUN_NOT_ENABLED', path);
      assert.equal(response.text.includes('Private prompt'), false, 'and nothing of the old run comes back');
    }
    const stored = await replayed(spacePath, keyed, { [IDEMPOTENCY_KEY_HEADER]: key });
    assert.equal(stored.status, 403, stored.text);
    assert.equal((stored.json as { code?: string }).code, 'GUEST_NO_AI');
    assert.equal(stored.text.includes('Private prompt'), false, 'a stored response is not replayed either');
    assert.deepEqual(await changes(), ['applied'], 'the change list gives a guest only what was done');

    await becomes('member');

    const back = await replayed(spacePath, inSpace);
    assert.deepEqual([back.status, (back.json as AssistantRun).id], [200, spaceRun.id], 'as a member the same request returns the same run');
    assert.equal((await replayed(spacePath, keyed, { [IDEMPOTENCY_KEY_HEADER]: key })).status, 202, 'and the stored response is replayed');
    assert.deepEqual(await changes(), ['applied', 'refused', 'skipped', 'waiting'], 'and the change list is whole again');
    await pool.query('DELETE FROM assistant_changes WHERE run_id = $1', [spaceRun.id]);
  });

  test('a paused schedule\'s Inbox item is hidden from a guest and is back for a member (#1090)', async () => {
    await becomes('member');
    const space = await createProject(boss, company, 'Guest inbox', 'restricted');
    await grant(boss, space.id, keeper, 'contributor');
    // The notice exactly as the tick writes it when a schedule fails three times.
    const title = `Paused Weekly review ${randomUUID()}: it failed three times in a row`;
    await assistantJobRows(db).notify(keeper.id, space.id, title, 'Your assistant paused this schedule. Turn it on again when it is fixed.', '/settings/assistant');
    const inbox = async () => ((expectStatus(await keeper.browser.request('GET', INBOX_PATH), 200) as { items: { title: string }[] }).items).map((item) => item.title);
    assert.ok((await inbox()).includes(title), 'a member reads it');
    await becomes('guest');
    assert.equal((await inbox()).includes(title), false, 'a guest does not');
    await becomes('member');
    assert.ok((await inbox()).includes(title), 'and it is back, the same one');
    await pool.query('DELETE FROM notifications WHERE user_id = $1 AND title = $2', [keeper.id, title]);
  });
});
