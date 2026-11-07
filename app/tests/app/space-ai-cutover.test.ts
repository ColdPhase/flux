import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assistantJobsPath, projectAiPolicyPath, projectPath, type AssistantJob, type Project, type SetSpaceAiResult } from '@flux/contracts';
import type { PgBoss } from 'pg-boss';
import { assistantTick, sweepSpaceAi } from '@flux/core';
import { accessPorts } from '@flux/db';
import { assistantUnitOfWork, startBackgroundOf } from '../../apps/worker/src/assistant/index.js';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { assistantScene, human, lockWaiters, type AssistantScene } from './support/assistant-scene.js';
import { db, pool } from './support/db.js';
import { publicOrigin } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken } from './support/mcp.js';
import { addMember, expectStatus, grant, person, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';
import { ensureSpaceAiAllowed, setSpaceAi, spaceAiRow } from './support/space-ai.js';

// AG-10 (F-029, #614; per space under F-037): the switch, the flip and the sweep. A space admin and the company's owners and admins
// turn AI off or on, under Idempotency-Key; the flip is ordered against every check on two real database connections (a check in
// progress makes the flip wait, a check after the flip sees it, a person's own write never fails, a held membership row makes the
// flip wait); a provider request in flight is aborted within the watcher's bound and its late answer is not posted; the sweep
// touches only work admitted before its flip, so turning AI on before it runs never replays anything; and a second API process
// (this test process) sees the change made through the first, with no cache.

const code = (json: unknown) => (json as { code?: string } | null)?.code;
/** The tool list really came back (a refusal is also HTTP 200, as a JSON-RPC error). */
const lists = (response: { message: Record<string, unknown> | null }) => (((response.message?.result as { tools?: unknown[] } | undefined)?.tools) ?? []).length > 0;
const errorCode = (message: Record<string, unknown> | null) => ((message?.error as { data?: { code?: string } } | undefined)?.data?.code);

describe('space AI switch: flip and cutover', () => {
  let scene: AssistantScene; let member: Person; let accessToken: string; let connectionId: string;
  const put = (who: Person, state: 'allowed' | 'blocked', headers: Record<string, string> = {}) =>
    who.browser.request('PUT', projectAiPolicyPath(scene.place.id), { body: { state }, headers });
  /** A request bound to the scene's space, which a space whose AI is off refuses before any tool, resource or prompt. */
  const bound = () => ({ query: `flux_connection=${connectionId}&flux_project=${scene.place.id}` });
  /** Starts `request`, waits until it is really queued behind a lock this test holds, runs `then` in the holder and commits it. */
  async function behind<T>(hold: (query: (text: string, values?: unknown[]) => Promise<unknown>) => Promise<unknown>, request: () => Promise<T>,
    then: (query: (text: string, values?: unknown[]) => Promise<unknown>) => Promise<unknown> = async () => undefined): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const query = (text: string, values?: unknown[]) => client.query(text, values);
      await hold(query);
      const baseline = await lockWaiters();
      const pending = request();
      await waitFor(async () => (await lockWaiters()) > baseline, 'the request waiting behind the held lock');
      await then(query);
      await client.query('COMMIT');
      return await pending;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  before(async () => {
    scene = await assistantScene('ai-cutover');
    member = await person('ai-cutover-member');
    await addMember(scene.lead, scene.ws.id, member, 'member');
    // The company admin is also one of the space's members, so a demotion leaves them an ordinary member of it, with a way in.
    await grant(scene.lead, scene.place.id, scene.admin, 'contributor');
    await grant(scene.lead, scene.place.id, member, 'contributor');
    const connection = expect(await scene.owner.browser.request('POST', '/api/v1/agent-connections',
      { body: { agentId: scene.agentId, selectedProjectIds: [scene.place.id], scopes: ['flux.context.read'] } }), 201);
    const clientId = `flux-test-${randomUUID()}`;
    const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
      response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
    connectionId = String(connection.id);
    accessToken = (await oauthToken(scene.owner.browser, String(connection.id), clientId, redirectUri,
      await beginOauth(scene.owner.browser, clientId, redirectUri, { scope: 'flux.context.read offline_access' }))).access_token;
  });
  beforeEach(async () => { await ensureSpaceAiAllowed(scene.place.id); await scene.reset(); });
  after(async () => { await ensureSpaceAiAllowed(scene.place.id); });

  test('a space admin and company owners and admins turn AI off and on; members, guests and outsiders cannot; a replay re-checks authority', async () => {
    const start = await spaceAiRow(scene.place.id);
    assert.equal(code((await put(member, 'blocked')).json), 'SPACE_AI_ADMIN_REQUIRED');
    assert.equal((await put(member, 'blocked')).status, 403);
    assert.equal(code((await put(scene.guest, 'blocked')).json), 'SPACE_AI_ADMIN_REQUIRED');
    assert.equal((await put(scene.stranger, 'blocked')).status, 404, 'an outsider learns nothing');
    assert.deepEqual(await spaceAiRow(scene.place.id), start, 'nothing changed');

    const off = await put(scene.owner, 'blocked');
    const body = expectStatus(off, 200) as SetSpaceAiResult;
    assert.deepEqual([body.ai, body.changed], ['blocked', true]);
    assert.ok(body.stopped && typeof body.stopped.runs === 'number', 'the sweep ran and says what it stopped');
    assert.equal((await spaceAiRow(scene.place.id))!.epoch, start!.epoch + 1);
    assert.equal((await pool.query('SELECT changed_by FROM project_ai_policies WHERE project_id = $1', [scene.place.id])).rows[0].changed_by, scene.owner.id);
    const job = (await pool.query(`SELECT data FROM pgboss.job WHERE name = 'space-ai.sweep.v1' AND data->>'projectId' = $1 ORDER BY created_on DESC LIMIT 1`,
      [scene.place.id])).rows[0]?.data;
    assert.deepEqual(job, { projectId: scene.place.id, epoch: start!.epoch + 1 }, 'the sweep job committed with the flip');
    const again = expectStatus(await put(scene.admin, 'blocked'), 200) as SetSpaceAiResult;
    assert.deepEqual([again.changed, (await spaceAiRow(scene.place.id))!.epoch], [false, start!.epoch + 1], 'the same state is a no-op');
    // The change is recorded for the space's people, never for an agent.
    const audience = (await pool.query(`SELECT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id
      WHERE e.kind = 'project.ai_policy_changed.v1' AND e.object_id = $1`, [scene.place.id])).rows.map((row) => row.recipient as string);
    assert.ok(audience.includes(`human:${scene.peer.id}`) && !audience.some((key) => key.startsWith('agent:')));
    assert.equal((expectStatus(await scene.peer.browser.request('GET', projectPath(scene.place.id)), 200) as Project).ai, 'blocked', 'a reload sees it');

    // A company admin turns it back on with an Idempotency-Key, is demoted, and the replay of that key is refused.
    const key = randomUUID();
    const on = expectStatus(await put(scene.admin, 'allowed', { 'idempotency-key': key }), 200) as SetSpaceAiResult;
    assert.deepEqual([on.ai, on.changed, on.stopped], ['allowed', true, null]);
    expectStatus(await scene.lead.browser.request('PATCH', `/api/v1/workspaces/${scene.ws.id}/members/${scene.admin.id}`, { body: { role: 'member' } }), 200);
    try {
      // The demoted admin is an ordinary member of the space: they can open it and may not change it.
      const replay = await put(scene.admin, 'allowed', { 'idempotency-key': key });
      assert.equal(replay.status, 403, 'a demoted admin cannot replay the change');
      assert.equal(replay.headers.get('idempotent-replayed'), null);
      assert.equal(code((await put(scene.admin, 'blocked')).json), 'SPACE_AI_ADMIN_REQUIRED', 'nor turn it off again');
    } finally {
      expectStatus(await scene.lead.browser.request('PATCH', `/api/v1/workspaces/${scene.ws.id}/members/${scene.admin.id}`, { body: { role: 'admin' } }), 200);
    }
  });

  test('two connections: a check in progress makes the flip wait; a check after the flip sees it', async () => {
    assert.ok(lists(await mcp(accessToken, 1, 'tools/list', {}, bound())), 'control');
    // A check holds the policy row FOR SHARE (as a commit transaction does): the flip waits until it commits.
    const flipped = await behind((query) => query('SELECT 1 FROM project_ai_policies WHERE project_id = $1 FOR SHARE', [scene.place.id]),
      async () => put(scene.owner, 'blocked'));
    assert.equal(flipped.status, 200);
    await setSpaceAi(scene.place.id, 'allowed');
    // A flip in progress holds the row FOR UPDATE: a request bound to the space that starts then waits, and sees AI off when the flip commits.
    const listed = await behind(
      (query) => query(`UPDATE project_ai_policies SET state = 'blocked', epoch = epoch + 1 WHERE project_id = $1`, [scene.place.id]),
      () => mcp(accessToken, 2, 'tools/list', {}, bound()));
    assert.deepEqual([listed.status, errorCode(listed.message)], [200, 'SPACE_AI_OFF']);
  });

  test('a person\'s own write during the flip commits and captures no AI work; a held membership row makes the flip wait and see the demotion', async () => {
    await pool.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'blocked', 'tell', true)`,
      [randomUUID(), scene.ws.id, scene.place.id, scene.owner.id]);
    const task = await scene.task(scene.owner, 'Wire the lamp');
    await pool.query('UPDATE project_work_items SET owner_user_id = $2 WHERE id = $1', [task.id, scene.owner.id]);
    const captured = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM assistant_reaction_events WHERE object_id = $1`, [task.id])).rows[0].n);
    const before = await captured();
    const written = await behind(
      (query) => query(`UPDATE project_ai_policies SET state = 'blocked', epoch = epoch + 1 WHERE project_id = $1`, [scene.place.id]),
      () => scene.owner.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { status: 'blocked', blocker: 'No power' }, headers: { 'if-match': `"${task.version}"` } }));
    assert.equal(written.status, 200, `the person's write commits: ${written.text}`);
    assert.equal(await captured(), before, 'and no reaction was captured');
    await setSpaceAi(scene.place.id, 'allowed');

    // The admin's membership is locked by a role change in progress: the flip waits, then sees the demotion and refuses.
    const refused = await behind((query) => query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE', [scene.ws.id, scene.admin.id]),
      async () => put(scene.admin, 'blocked'),
      (query) => query(`UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2`, [scene.ws.id, scene.admin.id]));
    try {
      assert.deepEqual([refused.status, code(refused.json)], [403, 'SPACE_AI_ADMIN_REQUIRED']);
      assert.equal((await spaceAiRow(scene.place.id))!.state, 'allowed');
    } finally { await pool.query(`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`, [scene.ws.id, scene.admin.id]); }
  });

  test('a provider request in flight is aborted within the bound, and its late answer is not posted', async () => {
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => { release = resolve; });
    let abortedAt = 0;
    scene.compute.respond = async (request, signal) => {
      signal.addEventListener('abort', () => { abortedAt = Date.now(); }, { once: true });
      await late;
      return { kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: Math.ceil(request.input.length / 4), outputTokens: 40 }, text: 'A late answer [S1]' };
    };
    try {
      const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look around' });
      const dispatched = scene.compute.dispatched.length;
      const processing = scene.processor.process(started.run.id);
      await waitFor(async () => scene.compute.dispatched.length > dispatched, 'the provider request in flight');
      const turnedOff = expectStatus(await put(scene.owner, 'blocked'), 200) as SetSpaceAiResult;
      const flippedAt = Date.now();
      assert.ok(turnedOff.stopped!.runs >= 1, 'the sweep asked the run to stop');
      await waitFor(async () => abortedAt > 0, 'the provider request aborted', 2_000);
      assert.ok(abortedAt - flippedAt < 1_000, `aborted ${abortedAt - flippedAt} ms after the turn-off answered (bound: stopPollMs plus one poll)`);
      release();
      await processing;
      const row = (await pool.query('SELECT status, end_reason, answer_body, committed_at FROM personal_runs WHERE id = $1', [started.run.id])).rows[0];
      assert.deepEqual(row, { status: 'stopped', end_reason: 'ai_off', answer_body: null, committed_at: null }, 'the late answer is not posted');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind = 'project.assistant_answer_committed.v1' AND data->>'runId' = $1`,
        [started.run.id])).rows[0].n, 0);
      assert.equal(scene.compute.dispatched.length, dispatched + 1, 'no provider request was decided after the turn-off');
    } finally { release(); scene.compute.respond = (await import('./support/personal-runs.js')).echo; }
  });

  test('turned on again before the sweep runs: old work never runs, new work is untouched, the sweep is idempotent', async () => {
    const old = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Old' });
    const blockedEpoch = await setSpaceAi(scene.place.id, 'blocked'); // a flip whose sweep has not run yet
    await setSpaceAi(scene.place.id, 'allowed');
    const fresh = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'New' });
    const swept = await sweepSpaceAi({ projectId: scene.place.id, epoch: blockedEpoch }, db, accessPorts);
    assert.ok(swept.runs >= 1);
    const status = async (id: string) => (await pool.query('SELECT status, end_reason FROM personal_runs WHERE id = $1', [id])).rows[0];
    assert.deepEqual(await status(old.run.id), { status: 'stopped', end_reason: 'ai_off' }, 'the late sweep ends what was admitted before the flip');
    assert.deepEqual(await status(fresh.run.id), { status: 'queued', end_reason: null }, 'and never touches work admitted after AI was turned on again');
    assert.deepEqual(Object.values(await sweepSpaceAi({ projectId: scene.place.id, epoch: blockedEpoch }, db, accessPorts)), [0, 0, 0, 0, 0, 0, []], 'a second sweep changes nothing');
    const dispatched = scene.compute.dispatched.length;
    await scene.processor.process(fresh.run.id);
    assert.ok(scene.compute.dispatched.length > dispatched, 'control: the new run reaches the provider');
  });

  test('turning AI on again resumes standing configuration and replays nothing that was stopped', async () => {
    const queued = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Before' });
    expectStatus(await put(scene.owner, 'blocked'), 200);
    expectStatus(await put(scene.owner, 'allowed'), 200);
    const dispatched = scene.compute.dispatched.length;
    await scene.processor.process(queued.run.id);
    assert.equal((await pool.query('SELECT end_reason FROM personal_runs WHERE id = $1', [queued.run.id])).rows[0].end_reason, 'ai_off');
    assert.equal(scene.compute.dispatched.length, dispatched, 'the stopped run does not run');
    assert.ok(lists(await mcp(accessToken, 3, 'tools/list', {}, bound())), 'the connection works again');
  });

  test('the flip locks the policy row: two concurrent changes to the same state, one flips and the other finds it flipped', async () => {
    const at = await spaceAiRow(scene.place.id);
    const client = await pool.connect();
    let results: Awaited<ReturnType<typeof put>>[] = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM project_ai_policies WHERE project_id = $1 FOR SHARE', [scene.place.id]);
      const baseline = await lockWaiters();
      const both = Promise.all([put(scene.owner, 'blocked'), put(scene.admin, 'blocked')]);
      await waitFor(async () => (await lockWaiters()) >= baseline + 2, 'both changes waiting on the policy row');
      await client.query('COMMIT');
      results = await both;
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    assert.deepEqual(results.map((response) => response.status), [200, 200], results.map((response) => response.text).join(' | '));
    assert.deepEqual(results.map((response) => (response.json as { changed: boolean }).changed).sort(), [false, true], 'exactly one flip');
    assert.equal((await spaceAiRow(scene.place.id))!.epoch, at!.epoch + 1);
  });

  test('a schedule time missed while AI is off never fires; the next time after re-enable does', async () => {
    const sent: { name: string; data: Record<string, unknown> }[] = [];
    const boss = { send: async (name: string, data?: object | null) => { sent.push({ name, data: (data ?? {}) as Record<string, unknown> }); return randomUUID(); } } as unknown as Pick<PgBoss, 'send'>;
    const tick = (now: Date) => assistantTick({ uow: assistantUnitOfWork(db, boss), startBackground: startBackgroundOf({ connections: scene.connections, providerEnabled: true }, db, boss) }, now);
    const day = 86_400_000;
    const base = new Date(Date.now() + 3 * day);
    const at = (days: number, minutes = 0) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days, 9, minutes));
    const job = expectStatus(await scene.owner.browser.request('POST', assistantJobsPath(scene.ws.id, scene.owner.id),
      { body: { projectId: scene.place.id, text: 'List what moved', schedule: { kind: 'daily', at: '09:00' }, timeZone: 'UTC' } }), 201) as AssistantJob;
    await pool.query('UPDATE assistant_jobs SET next_run_at = $2 WHERE id = $1', [job.id, at(0)]); // far ahead of the real clock
    const firings = async () => Number((await pool.query('SELECT count(*)::int AS n FROM assistant_job_runs WHERE job_id = $1', [job.id])).rows[0].n);
    const next = async () => new Date((await pool.query('SELECT next_run_at FROM assistant_jobs WHERE id = $1', [job.id])).rows[0].next_run_at as string).getTime();
    try {
      expectStatus(await put(scene.owner, 'blocked'), 200);
      await tick(at(0, 1));
      assert.deepEqual([await firings(), sent.length], [0, 0], 'nothing fires while AI is off, and no history row is written');
      assert.equal(await next(), at(1).getTime(), 'the schedule moved on to its next time');
      expectStatus(await put(scene.owner, 'allowed'), 200);
      await tick(at(0, 5));
      assert.equal(await firings(), 0, 'the missed time does not fire after AI is on again');
      await tick(at(1, 1));
      assert.equal(await firings(), 1, 'control: the next time fires');
    } finally { await pool.query('DELETE FROM assistant_jobs WHERE id = $1', [job.id]); }
  });

  test('a second API process (this test process) sees a change made through the first at once', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `ai-cutover-${'x'.repeat(40)}`,
      FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080' };
    const second = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'));
    try {
      await second.listen({ host: '127.0.0.1', port: 0 });
      const base = `http://127.0.0.1:${(second.server.address() as AddressInfo).port}`;
      assert.ok(lists(await mcp(accessToken, 4, 'tools/list', {}, { base, ...bound() })), 'control: the second process serves the connection');
      expectStatus(await put(scene.owner, 'blocked'), 200); // through the first API process (the api container)
      const refused = await mcp(accessToken, 5, 'tools/list', {}, { base, ...bound() });
      assert.deepEqual([refused.status, errorCode(refused.message)], [200, 'SPACE_AI_OFF'], 'no cache in the second process');
      expectStatus(await put(scene.owner, 'allowed'), 200);
      assert.ok(lists(await mcp(accessToken, 6, 'tools/list', {}, { base, ...bound() })));
    } finally { await second.close(); }
  });
});
