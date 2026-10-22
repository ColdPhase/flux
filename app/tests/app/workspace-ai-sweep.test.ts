import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AI_WORK_QUEUES, workspaceAiPolicyPath, type Conversation, type Material, type WorkResult } from '@flux/contracts';
import { sweepWorkspaceAi, type ComparisonProvider } from '@flux/core';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { proactiveReservation } from '../../apps/worker/src/proactive-comparison/reservation-adapter.js';
import { assistantScene, human, lockWaiters, type AssistantScene } from './support/assistant-scene.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { db, pool } from './support/db.js';
import { publicOrigin } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';
import { ensureWorkspaceAiAllowed, setWorkspaceAi, workspaceAiRow } from './support/workspace-ai.js';

// F-029 workspace AI lock, S2 review fixes (#614): the sweep with a real row in every state of every table it touches; the
// lock order with the REAL role change and removal against the REAL flip, in both orders; the backstop per table; no events
// of the blocked period reach agents; flip against a run commit, a comparison publish and a reaction capture in both
// orders; a comparison's late answer; and the delivery fence's refusal of a chunk held by the test gate.

const code = (json: unknown) => (json as { code?: string } | null)?.code;
const errorCode = (message: Record<string, unknown> | null) => ((message?.error as { data?: { code?: string } } | undefined)?.data?.code);
const lists = (response: { message: Record<string, unknown> | null }) => (((response.message?.result as { tools?: unknown[] } | undefined)?.tools) ?? []).length > 0;
const epochOf = async (workspaceId: string) => (await workspaceAiRow(workspaceId))!.epoch;

/** Runs `request` while `holder` keeps a lock, waits until the request queues behind it, then lets the holder finish. */
async function behind<T>(hold: (query: (text: string, values?: unknown[]) => Promise<unknown>) => Promise<unknown>, request: () => Promise<T>, extraWaiters = 1): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await hold((text, values) => client.query(text, values));
    const baseline = await lockWaiters();
    const pending = request();
    await waitFor(async () => (await lockWaiters()) >= baseline + extraWaiters, 'the request waiting behind the held lock');
    await client.query('COMMIT');
    return await pending;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

describe('workspace AI lock: sweep, lock order and remaining AC-3 rows', () => {
  let scene: AssistantScene;
  const put = async (who: Person, state: 'allowed' | 'blocked') => who.browser.request('PUT', workspaceAiPolicyPath(scene.ws.id),
    { body: { state }, headers: { 'if-match': `"${(await workspaceAiRow(scene.ws.id))!.version}"` } });

  before(async () => { scene = await assistantScene('ai-sweep'); });
  beforeEach(async () => { await ensureWorkspaceAiAllowed(scene.ws.id); await scene.reset(); });
  after(async () => { await ensureWorkspaceAiAllowed(scene.ws.id); });

  test('the sweep ends a real row in every state of every table it touches, and leaves rows of a newer epoch alone', async () => {
    const { ws, place, thread, owner, agentId } = scene;
    const connectionId = await scene.assistantConnectionId();
    const work = await scene.task(owner, 'Swept work');
    const template = await scene.runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Template' });
    const ids = { queued: randomUUID(), reading: randomUUID(), dispatching: randomUUID(), fresh: randomUUID(),
      rq: randomUUID(), rd: randomUUID(), rc: randomUUID(), up: randomUUID(), uc: randomUUID(), ua: randomUUID(), session: randomUUID(), rule: randomUUID(), eq: randomUUID(), ep: randomUUID() };
    const old = await epochOf(ws.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Test fixture only: foreign keys and the backstop are not what this exercises; every row is stamped with the current epoch.
      await client.query('SET LOCAL session_replication_role = replica');
      const run = (id: string, status: string, extra = '') => client.query(`INSERT INTO personal_runs (id, workspace_id, project_id, conversation_id, owner_user_id, agent_id,
        client_run_id, request_fingerprint, kind, prompt, status, cost_state, reserved_micros, provider, model, engine, ai_epoch, dispatched_at, run_token_jti, run_token_expires_at)
        SELECT $1, workspace_id, project_id, conversation_id, $5, agent_id, gen_random_uuid(), request_fingerprint, kind, prompt, $2, 'reserved', reserved_micros,
          provider, model, engine, $3, ${status === 'dispatching' ? 'now()' : 'NULL'}, ${extra ? `'${randomUUID()}'` : 'NULL'}, ${extra ? "now() + interval '5 minutes'" : 'NULL'}
        FROM personal_runs WHERE id = $4`, [id, status, old, template.run.id, status === 'dispatching' ? scene.peer.id : owner.id]); // one working run per owner
      await run(ids.queued, 'queued'); await run(ids.reading, 'reading', 'token'); await run(ids.dispatching, 'dispatching', 'token');
      const request = (id: string, state: string, extra: string) => client.query(`INSERT INTO cowork_requests (id, lineage_id, workspace_id, project_id, work_id, unit_id,
        sender_connection_id, recipient_connection_id, sender_owner_id, recipient_owner_id, intent_key, fingerprint, kind, target, source_refs, criteria_refs,
        depth, review_round, priority, peer_unblocking, expires_at, state, ai_epoch${extra ? ', reason, next_boundary, claimed_generation' : ''})
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $8, $12, $9, 'help', '{"type":"work"}', '[{"type":"work"}]', '[{"type":"work"}]', 0, 0, 1, false,
          now() + interval '1 hour', $10, $11${extra})`,
      [id, randomUUID(), ws.id, place.id, work.id, ids.up, connectionId, owner.id, createHash('sha256').update(id).digest('hex'), state, old, `intent-${id}`]);
      await request(ids.rq, 'queued', ''); await request(ids.rd, 'deferred', ", 'busy', 'after_step', NULL"); await request(ids.rc, 'claimed', ', NULL, NULL, 1');
      const unit = (id: string, state: string) => client.query(`INSERT INTO cowork_units (id, workspace_id, project_id, work_id, lineage_work_id, run_id, unit_key, role,
        assignment_connection_id, state, generation, lease_id, lease_session_id, lease_expires_at, ai_epoch)
        VALUES ($1, $2, $3, $4, $4, $5, $13, 'execute', $6, $7, $8, $9, $10, $11, $12)`, [id, ws.id, place.id, work.id, randomUUID(), connectionId, state,
        state === 'claimed' ? 1 : 0, state === 'claimed' ? randomUUID() : null, state === 'claimed' ? 'session' : null, state === 'claimed' ? new Date(Date.now() + 60_000) : null, old, `unit-${id}`]);
      await unit(ids.up, 'pending'); await unit(ids.uc, 'claimed'); await unit(ids.ua, 'paused');
      await client.query(`INSERT INTO agent_runtime_sessions (id, binding_id, binding_generation, client_session_id, workspace_id, connection_id, owner_user_id, agent_id,
        scopes, expires_at, ai_epoch) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, ARRAY['flux.context.read'], now() + interval '1 hour', $8)`,
      [ids.session, randomUUID(), randomUUID(), ws.id, connectionId, owner.id, agentId, old]);
      await client.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'blocked', 'tell', true)`,
        [ids.rule, ws.id, place.id, owner.id]);
      for (const [id, state] of [[ids.eq, 'queued'], [ids.ep, 'proof']] as const) await client.query(`INSERT INTO assistant_reaction_events (id, reaction_id, owner_user_id,
        object_id, source_id, action, event, reaction_version, state, ai_epoch) VALUES ($1, $2, $3, $4, $5, 'tell', 'blocked', 1, $6, $7)`,
      [id, ids.rule, owner.id, randomUUID(), randomUUID(), state, old]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [template.run.id]);

    const epoch = await setWorkspaceAi(ws.id, 'blocked');
    await setWorkspaceAi(ws.id, 'allowed');
    const fresh = await scene.runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'After re-enable' });
    const swept = await sweepWorkspaceAi({ workspaceId: ws.id, epoch }, db);
    assert.deepEqual(swept, { runs: 3, tokens: 2, comparisons: 0, reactions: 2, requests: 3, units: 3, sessions: 1, failed: [] });
    const one = async (sql: string, id: string) => (await pool.query(sql, [id])).rows[0];
    assert.deepEqual(await one('SELECT status, end_reason, stopped_at_stage FROM personal_runs WHERE id = $1', ids.queued), { status: 'stopped', end_reason: 'ai_off', stopped_at_stage: 'before_read' });
    for (const id of [ids.reading, ids.dispatching]) {
      const row = await one('SELECT stop_requested_at, run_token_closed_at FROM personal_runs WHERE id = $1', id);
      assert.ok(row.stop_requested_at && row.run_token_closed_at, 'in flight: asked to stop, its token closed');
    }
    for (const id of [ids.rq, ids.rd, ids.rc]) assert.deepEqual(await one('SELECT state, reason FROM cowork_requests WHERE id = $1', id), { state: 'cancelled', reason: 'ai_off' });
    for (const [id, generation] of [[ids.up, 1], [ids.uc, 2], [ids.ua, 1]] as const)
      assert.deepEqual(await one('SELECT state, generation, lease_id FROM cowork_units WHERE id = $1', id), { state: 'stopped', generation, lease_id: null });
    assert.ok((await one('SELECT revoked_at FROM agent_runtime_sessions WHERE id = $1', ids.session)).revoked_at);
    for (const id of [ids.eq, ids.ep]) assert.deepEqual(await one('SELECT state, line FROM assistant_reaction_events WHERE id = $1', id), { state: 'skipped', line: 'Skipped: AI was turned off' });
    assert.equal((await one('SELECT status FROM personal_runs WHERE id = $1', fresh.run.id)).status, 'queued', 'work admitted after re-enable is untouched');
    assert.deepEqual(await sweepWorkspaceAi({ workspaceId: ws.id, epoch }, db), { runs: 0, tokens: 0, comparisons: 0, reactions: 0, requests: 0, units: 0, sessions: 0, failed: [] });
  });

  test('a real role change and removal of the flipping admin against the real flip, in both orders: 200 and 403, never a deadlock', async () => {
    const { owner, admin, ws } = scene;
    const restore = () => pool.query(`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`, [ws.id, admin.id]);
    // The role change first: it is parked after it took the admin's membership row, before its event audience reads the agents.
    let role!: Promise<{ status: number; text: string }>;
    const flip = await behind((query) => query('LOCK TABLE agents IN ACCESS EXCLUSIVE MODE'), async () => {
      role = owner.browser.request('PATCH', `/api/v1/workspaces/${ws.id}/members/${admin.id}`, { body: { role: 'member' } });
      await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%agents%'`)).rows[0].n > 0, 'role change parked');
      return put(admin, 'blocked');
    }, 2);
    const changed = await role;
    assert.equal(changed.status, 200, `the role change commits: ${changed.text}`);
    assert.deepEqual([flip.status, code(flip.json)], [403, 'WORKSPACE_AI_ADMIN_REQUIRED'], `the flip sees the demotion: ${flip.text}`);
    await restore();
    // The flip first: parked at its own event audience while it holds the policy row; the role change waits and then commits.
    let flipped!: Promise<{ status: number; text: string }>;
    const changedAfter = await behind((query) => query('LOCK TABLE agents IN ACCESS EXCLUSIVE MODE'), async () => {
      flipped = put(admin, 'blocked');
      await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%agents%'`)).rows[0].n > 0, 'flip parked');
      return owner.browser.request('PATCH', `/api/v1/workspaces/${ws.id}/members/${admin.id}`, { body: { role: 'member' } });
    }, 2);
    assert.equal((await flipped).status, 200, 'the flip commits first');
    assert.equal(changedAfter.status, 200, `then the role change: ${changedAfter.text}`);
    await restore();
    await setWorkspaceAi(ws.id, 'allowed');
    // A removal of the flipping admin while the flip waits: the removal commits, the flip is refused (the admin is gone).
    const spare = await person('ai-sweep-spare');
    await addMember(owner, ws.id, spare, 'admin');
    let removed!: Promise<{ status: number; text: string }>;
    const refused = await behind((query) => query('LOCK TABLE agents IN ACCESS EXCLUSIVE MODE'), async () => {
      removed = owner.browser.request('DELETE', `/api/v1/workspaces/${ws.id}/members/${spare.id}`);
      await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%agents%'`)).rows[0].n > 0, 'removal parked');
      return put(spare, 'blocked');
    }, 2);
    assert.equal((await removed).status, 204);
    assert.notEqual(refused.status, 500, `no deadlock: ${refused.text}`);
    assert.equal((await workspaceAiRow(ws.id))!.state, 'allowed');
  });

  test('the backstop refuses a stale or missing epoch on every AI work table; the current epoch passes it', async () => {
    const { ws, place, owner } = scene;
    const rule = randomUUID();
    await pool.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'mentioned', 'tell', false)`,
      [rule, ws.id, place.id, owner.id]);
    const current = await epochOf(ws.id);
    const attempt = async (table: string, epoch: number | null) => {
      const reference = table === 'proactive_comparison_outbox' ? `project_id` : table === 'assistant_reaction_events' ? 'reaction_id' : 'workspace_id';
      const value = table === 'proactive_comparison_outbox' ? place.id : table === 'assistant_reaction_events' ? rule : ws.id;
      try { await pool.query(`INSERT INTO ${table} (${reference}, ai_epoch) VALUES ($1, $2)`, [value, epoch]); return 'inserted'; }
      catch (error) { return (error as Error).message; }
    };
    for (const table of AI_WORK_QUEUES.tables) {
      assert.match(await attempt(table, current - 1), /AI is turned off in this workspace/, `${table}: a stale epoch`);
      assert.match(await attempt(table, null), /AI is turned off in this workspace/, `${table}: a missing epoch`);
      assert.doesNotMatch(await attempt(table, current), /AI is turned off/, `${table}: control, the current epoch passes the backstop (the row then fails its own constraints)`);
    }
  });

  test('no event recorded while AI is off ever reaches an agent, even after AI is on again', async () => {
    const { owner, ws, place } = scene;
    const agentRows = async (seq: number) => Number((await pool.query(`SELECT count(*)::int AS n FROM event_audience a JOIN events e ON e.id = a.event_id
      WHERE e.workspace_id = $1 AND e.seq > $2 AND a.recipient LIKE 'agent:%'`, [ws.id, seq])).rows[0].n);
    const head = async () => Number((await pool.query('SELECT coalesce(max(seq), 0) AS seq FROM events')).rows[0].seq);
    expectStatus(await put(owner, 'blocked'), 200);
    const start = await head();
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Written while AI is off' } }), 201);
    const blockedEnd = await head();
    assert.equal(await agentRows(start), 0, 'no agent audience row for the blocked period');
    expectStatus(await put(owner, 'allowed'), 200);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM event_audience a JOIN events e ON e.id = a.event_id
      WHERE e.workspace_id = $1 AND e.seq > $2 AND e.seq <= $3 AND a.recipient LIKE 'agent:%'`, [ws.id, start, blockedEnd])).rows[0].n), 0, 'and none appears after re-enable');
    const after = await head();
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Written after re-enable' } }), 201);
    assert.ok(await agentRows(after) > 0, 'control: an event after re-enable reaches the agent');
  });

  test('flip against a run commit, both orders: a flip before the commit posts nothing, a commit before the flip stays posted', async () => {
    const answers = async (runId: string) => (await pool.query('SELECT status, end_reason, answer_body FROM personal_runs WHERE id = $1', [runId])).rows[0];
    // The flip lands between the provider's answer and the commit.
    const first = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Flip before commit' });
    const { personalRunWorkerUnitOfWork } = await import('../../apps/worker/src/personal-runs/adapters.js');
    const { createPersonalRunProcessor } = await import('@flux/core');
    const between = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections: scene.connections, compute: scene.compute, stopPollMs: 20,
      hooks: { afterDispatch: async () => { expectStatus(await put(scene.owner, 'blocked'), 200); } } });
    await between.process(first.run.id);
    const refused = await answers(first.run.id);
    assert.deepEqual([refused.status, refused.end_reason, refused.answer_body], ['stopped', 'ai_off', null], 'the late answer is not posted');
    expectStatus(await put(scene.owner, 'allowed'), 200);
    // The commit first, then the flip: the answer was posted before AI was turned off and stays as history.
    const second = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Commit before flip' });
    await scene.processor.process(second.run.id);
    expectStatus(await put(scene.owner, 'blocked'), 200);
    const kept = await answers(second.run.id);
    assert.match(kept.status, /completed|truncated/);
    assert.ok(kept.answer_body, 'the earlier answer stays');
  });

  test('flip against a reaction capture, both orders: captured before the flip is skipped, a write after the flip captures nothing', async () => {
    const { owner, ws, place } = scene;
    await pool.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'blocked', 'tell', true)`,
      [randomUUID(), ws.id, place.id, owner.id]);
    const blockTask = async (title: string) => {
      const task = await scene.task(owner, title);
      await pool.query('UPDATE project_work_items SET owner_user_id = $2 WHERE id = $1', [task.id, owner.id]);
      expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { status: 'blocked', blocker: 'No power' }, headers: { 'if-match': `"${task.version}"` } }), 200);
      return task.id;
    };
    const events = async (objectId: string) => (await pool.query('SELECT state, line FROM assistant_reaction_events WHERE object_id = $1', [objectId])).rows;
    const before = await blockTask('Captured before the flip');
    assert.equal((await events(before)).length, 1, 'control: captured while AI is on');
    const turnedOff = expectStatus(await put(owner, 'blocked'), 200) as { stopped: { reactions: number } };
    assert.ok(turnedOff.stopped.reactions >= 1);
    assert.deepEqual((await events(before)).map((row) => row.line), ['Skipped: AI was turned off'], 'the sweep skips it');
    const afterFlip = await blockTask('Written after the flip');
    assert.equal((await events(afterFlip)).length, 0, 'nothing is captured while AI is off');
  });

  test('a chunk held at the delivery fence when AI is turned off is refused with the JSON-RPC error on HTTP 200', async () => {
    const connection = expect(await scene.owner.browser.request('POST', '/api/v1/agent-connections',
      { body: { agentId: scene.agentId, selectedProjectIds: [scene.place.id], scopes: ['flux.context.read'] } }), 201);
    const clientId = `flux-test-${randomUUID()}`;
    const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
      response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
    const token = (await oauthToken(scene.owner.browser, String(connection.id), clientId, redirectUri,
      await beginOauth(scene.owner.browser, clientId, redirectUri, { scope: 'flux.context.read offline_access' }))).access_token;
    const gate = `ai-lock-${randomUUID()}`;
    const held = async (flip: boolean) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [gate]);
        const baseline = await lockWaiters();
        const pending = mcp(token, 7, 'tools/list', {}, { headers: { 'x-flux-test-delivery-gate': gate } });
        await waitFor(async () => (await lockWaiters()) > baseline, 'the response held before its fence');
        if (flip) await setWorkspaceAi(scene.ws.id, 'blocked');
        await client.query('COMMIT');
        return await pending;
      } finally { client.release(); }
    };
    assert.ok(lists(await held(false)), 'control: a held chunk is delivered while AI stays on');
    const refused = await held(true);
    assert.deepEqual([refused.status, errorCode(refused.message), refused.message?.id], [200, 'WORKSPACE_AI_BLOCKED', 7], 'refused with the same JSON-RPC error, not a 403');
  });
});

describe('workspace AI lock: a comparison in flight and a comparison publish against the flip', () => {
  let owner: Person; let peer: Person; let wsId: string; let projectId: string; let material: Material; let conversation: Conversation;
  const masterKey = readFileSync('/run/secrets/flux_background_key');
  const negative = async (title: string) => expectStatus(await peer.browser.request('POST', `/api/v1/projects/${projectId}/results`, { body: { title, finding: 'negative',
    evidence: 'Camera misses at 5 lux', sources: [{ type: 'material', id: material.materialId, version: 1 }, { type: 'message', id: conversation.messages[0]!.id }] } }), 201) as WorkResult;
  const candidateOf = async (resultId: string) => (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id = $1', [resultId])).rows[0]!.id as string;
  const answer = (input: Parameters<ComparisonProvider['createMessage']>[0]) => ({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 },
    answer: { kind: 'comparison', fact: 'Sensor A misses gestures.', interpretation: 'Exposure may be short.', suggestedAction: 'Compare a second sensor.',
      citations: input.sources.map(({ type, id, version }) => ({ type, id, version })) } }) as never;
  const put = async (state: 'allowed' | 'blocked') => expectStatus(await owner.browser.request('PUT', workspaceAiPolicyPath(wsId),
    { body: { state }, headers: { 'if-match': `"${(await workspaceAiRow(wsId))!.version}"` } }), 200) as { stopped: { comparisons: number } | null };

  before(async () => {
    [owner, peer] = await Promise.all(['ai-sweep-cmp-owner', 'ai-sweep-cmp-peer'].map(person));
    const ws = await workspace(owner, 'Comparison cutover workspace');
    wsId = ws.id;
    await addMember(owner, ws.id, peer, 'member');
    projectId = (await project(owner, ws.id, 'Low-light sensors', 'restricted')).id;
    await grant(owner, projectId, peer, 'contributor');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Comparison agent', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`, { body: { agentId, trigger: 'human_negative_result',
      purpose: 'camera_sensor_comparison', dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal', maxRunsPerDay: 3, periodBudgetCents: 50, perRunCents: 5 } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
      provider: 'anthropic', model: 'claude-sonnet-5', apiKey: `sk-ant-api03-${'ai-sweep-owner-key-'.repeat(4)}END8`, payerOrganization: 'Lock payer', providerWorkspace: 'One',
      workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true, providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
      maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 5 } }), 201);
    await pool.query("UPDATE proactive_comparison_rules SET status = 'enabled' WHERE id = $1", [rule.id]);
    material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Sensor measurement', body: 'Camera A captured 38% of gestures at 5 lux.' } }), 201) as Material;
    conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
      { body: { body: 'Compare sensor measurements.', clientMessageId: randomUUID() } }), 201) as Conversation;
  });
  after(async () => { await ensureWorkspaceAiAllowed(wsId); });

  test('a reserved comparison not yet sent is ended by the sweep (the whole sweep still commits)', async () => {
    const candidate = await candidateOf((await negative('Reserved, not sent')).id);
    await comparisonDispatchFixtureDue(pool, candidate);
    assert.equal((await proactiveReservation(db).reserve(candidate)).status, 'reserved');
    const turnedOff = await put('blocked');
    assert.deepEqual([turnedOff.stopped?.comparisons, (turnedOff.stopped as unknown as { failed: string[] }).failed], [1, []]);
    assert.deepEqual((await pool.query('SELECT status, failure_code, connection_id, reserved_at FROM proactive_comparison_outbox WHERE id = $1', [candidate])).rows[0],
      { status: 'not_run', failure_code: 'AI_OFF', connection_id: null, reserved_at: null });
    await put('allowed');
  });

  test('a comparison in flight when AI is turned off is aborted and its late answer never becomes a proposal', async () => {
    const candidate = await candidateOf((await negative('In flight')).id);
    await comparisonDispatchFixtureDue(pool, candidate);
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false; let started = false;
    const provider: ComparisonProvider = {
      async countInputTokens() { return 100; },
      async createMessage(input) {
        started = true;
        input.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
        await late;
        return answer(input);
      },
    };
    const dispatching = dispatchProactiveComparison({ db, candidateId: candidate, masterKey, provider });
    await waitFor(async () => started, 'the provider request in flight');
    await put('blocked');
    await waitFor(async () => aborted, 'the watcher aborted the request', 3_000);
    release();
    const outcome = await dispatching;
    assert.notEqual(outcome.status, 'proposal', JSON.stringify(outcome));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_proposals WHERE outbox_id = $1', [candidate])).rows[0].n, 0);
    await put('allowed');
  });

  test('flip against a comparison publish, both orders', async () => {
    // The flip lands while the provider answers: nothing is published.
    const first = await candidateOf((await negative('Flip before publish')).id);
    await comparisonDispatchFixtureDue(pool, first);
    const flipping: ComparisonProvider = { async countInputTokens() { return 100; }, async createMessage(input) { await setWorkspaceAi(wsId, 'blocked'); return answer(input); } };
    assert.notEqual((await dispatchProactiveComparison({ db, candidateId: first, masterKey, provider: flipping })).status, 'proposal');
    await setWorkspaceAi(wsId, 'allowed');
    // Published first, then the flip: the proposal stays as history.
    const second = await candidateOf((await negative('Publish before flip')).id);
    await comparisonDispatchFixtureDue(pool, second);
    const plain: ComparisonProvider = { async countInputTokens() { return 100; }, async createMessage(input) { return answer(input); } };
    assert.equal((await dispatchProactiveComparison({ db, candidateId: second, masterKey, provider: plain })).status, 'proposal');
    await put('blocked');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_proposals WHERE outbox_id = $1', [second])).rows[0].n, 1);
    await put('allowed');
  });
});
