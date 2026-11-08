import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AI_WORK_QUEUES, projectAiPolicyPath, type Conversation, type Material, type WorkResult } from '@flux/contracts';
import { sweepSpaceAi, type ComparisonProvider } from '@flux/core';
import { accessPorts } from '@flux/db';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { proactiveReservation } from '../../apps/worker/src/proactive-comparison/reservation-adapter.js';
import { assistantScene, human, lockWaiters, type AssistantScene } from './support/assistant-scene.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { db, pool } from './support/db.js';
import { publicOrigin } from './support/http.js';
import { mcp } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { waitFor } from './support/wait.js';
import { ensureSpaceAiAllowed, setSpaceAi, spaceAiRow } from './support/space-ai.js';
import { createConnection, oauthTokenFor } from './support/mcp-actions.js';

// AG-10 (F-029 S2 review fixes, #614; per space under F-037): the sweep with a real row in every state of every table it touches;
// a REAL role change of the flipping admin against the REAL flip, in both orders; the backstop per table; no events of the
// blocked period reach agents; flip against a run commit, a comparison publish and a reaction capture in both orders; a
// comparison's late answer; and the delivery fence's refusal of a chunk held by the test gate.

const code = (json: unknown) => (json as { code?: string } | null)?.code;
const errorCode = (message: Record<string, unknown> | null) => ((message?.error as { data?: { code?: string } } | undefined)?.data?.code);
const lists = (response: { message: Record<string, unknown> | null }) => (((response.message?.result as { tools?: unknown[] } | undefined)?.tools) ?? []).length > 0;
const epochOf = async (projectId: string) => (await spaceAiRow(projectId))!.epoch;

describe('space AI switch: sweep, role changes against the flip and remaining rows', () => {
  let scene: AssistantScene;
  const put = async (who: Person, state: 'allowed' | 'blocked') => who.browser.request('PUT', projectAiPolicyPath(scene.place.id), { body: { state } });

  before(async () => {
    scene = await assistantScene('ai-sweep');
    // The company admin is also one of the space's members, so a demotion leaves them an ordinary member of it.
    await grant(scene.lead, scene.place.id, scene.admin, 'contributor');
  });
  beforeEach(async () => { await ensureSpaceAiAllowed(scene.place.id); await scene.reset(); });
  after(async () => { await ensureSpaceAiAllowed(scene.place.id); });

  test('the sweep ends a real row in every state of every table it touches, and leaves rows of a newer epoch alone', async () => {
    const { ws, place, thread, owner } = scene;
    const connectionId = await scene.assistantConnectionId();
    const work = await scene.task(owner, 'Swept work');
    const template = await scene.runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Template' });
    const ids = { queued: randomUUID(), reading: randomUUID(), dispatching: randomUUID(), fresh: randomUUID(),
      rq: randomUUID(), rd: randomUUID(), rc: randomUUID(), up: randomUUID(), uc: randomUUID(), ua: randomUUID(), rule: randomUUID(), eq: randomUUID(), ep: randomUUID() };
    const old = await epochOf(place.id);
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
      ids.rule = (await client.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'blocked', 'tell', true)
        ON CONFLICT (owner_user_id, project_id, event) DO UPDATE SET action = 'tell', enabled = true RETURNING id`, [ids.rule, ws.id, place.id, owner.id])).rows[0].id;
      for (const [id, state] of [[ids.eq, 'queued'], [ids.ep, 'proof']] as const) await client.query(`INSERT INTO assistant_reaction_events (id, reaction_id, owner_user_id,
        object_id, source_id, action, event, reaction_version, state, ai_epoch) VALUES ($1, $2, $3, $4, $5, 'tell', 'blocked', 1, $6, $7)`,
      [id, ids.rule, owner.id, randomUUID(), randomUUID(), state, old]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [template.run.id]);

    const epoch = await setSpaceAi(place.id, 'blocked');
    await setSpaceAi(place.id, 'allowed');
    // Work admitted after re-enable carries the new epoch (inserted through the backstop; the owner's swept rows still count as in flight for the service).
    await pool.query(`INSERT INTO personal_runs (id, workspace_id, project_id, conversation_id, owner_user_id, agent_id, client_run_id, request_fingerprint, kind, prompt,
      status, cost_state, reserved_micros, provider, model, engine, ai_epoch) SELECT $1, workspace_id, project_id, conversation_id, owner_user_id, agent_id, gen_random_uuid(),
      request_fingerprint, kind, prompt, 'queued', 'reserved', reserved_micros, provider, model, engine, $3 FROM personal_runs WHERE id = $2`, [ids.fresh, template.run.id, await epochOf(place.id)]);
    const swept = await sweepSpaceAi({ projectId: place.id, epoch }, db, accessPorts);
    assert.deepEqual(swept, { runs: 3, tokens: 2, comparisons: 0, reactions: 2, requests: 3, units: 3, failed: [] });
    const one = async (sql: string, id: string) => (await pool.query(sql, [id])).rows[0];
    assert.deepEqual(await one('SELECT status, end_reason, stopped_at_stage FROM personal_runs WHERE id = $1', ids.queued), { status: 'stopped', end_reason: 'ai_off', stopped_at_stage: 'before_read' });
    for (const id of [ids.reading, ids.dispatching]) {
      const row = await one('SELECT stop_requested_at, run_token_closed_at FROM personal_runs WHERE id = $1', id);
      assert.ok(row.stop_requested_at && row.run_token_closed_at, 'in flight: asked to stop, its token closed');
    }
    for (const id of [ids.rq, ids.rd, ids.rc]) assert.deepEqual(await one('SELECT state, reason FROM cowork_requests WHERE id = $1', id), { state: 'cancelled', reason: 'ai_off' });
    for (const [id, generation] of [[ids.up, 1], [ids.uc, 2], [ids.ua, 1]] as const)
      assert.deepEqual(await one('SELECT state, generation, lease_id FROM cowork_units WHERE id = $1', id), { state: 'stopped', generation, lease_id: null });
    for (const id of [ids.eq, ids.ep]) assert.deepEqual(await one('SELECT state, line FROM assistant_reaction_events WHERE id = $1', id), { state: 'skipped', line: 'Skipped: AI was turned off' });
    assert.equal((await one('SELECT status FROM personal_runs WHERE id = $1', ids.fresh)).status, 'queued', 'work admitted after re-enable is untouched');
    assert.deepEqual(await sweepSpaceAi({ projectId: place.id, epoch }, db, accessPorts), { runs: 0, tokens: 0, comparisons: 0, reactions: 0, requests: 0, units: 0, failed: [] });
  });

  test('a real demotion and removal of the flipping admin against the real flip, in both orders: 200 and 403, never a deadlock', async () => {
    const { lead: owner, admin, ws } = scene;
    const restore = () => pool.query(`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`, [ws.id, admin.id]);
    const demote = () => owner.browser.request('PATCH', `/api/v1/workspaces/${ws.id}/members/${admin.id}`, { body: { role: 'member' } });
    // Both at once, three times each way round: whichever commits first, neither fails with a lock error, and a flip after the
    // demotion is refused while a flip before it stays done.
    for (const flipFirst of [true, false, true]) {
      const results = flipFirst ? await Promise.all([put(admin, 'blocked'), demote()]) : await Promise.all([demote(), put(admin, 'blocked')]);
      const [flip, change] = flipFirst ? results : [results[1]!, results[0]!];
      assert.ok([flip.status, change.status].every((status) => status < 500), `no deadlock (flip first: ${flipFirst}): ${flip.text} ${change.text}`);
      assert.equal(change.status, 200, `the demotion commits: ${change.text}`);
      assert.ok(flip.status === 200 || (flip.status === 403 && code(flip.json) === 'SPACE_AI_ADMIN_REQUIRED'), `the flip is done or refused: ${flip.status} ${flip.text}`);
      await restore();
      await setSpaceAi(scene.place.id, 'allowed');
    }
    // A removal of the flipping admin: the flip is refused (the admin is gone) or was done before it; never a failure.
    const spare = await person('ai-sweep-spare');
    await addMember(owner, ws.id, spare, 'admin');
    const [removed, flip] = await Promise.all([owner.browser.request('DELETE', `/api/v1/workspaces/${ws.id}/members/${spare.id}`), put(spare, 'blocked')]);
    assert.equal(removed.status, 204);
    assert.ok([200, 404].includes(flip.status), `the flip is done or finds the admin gone: ${flip.status} ${flip.text}`);
    await setSpaceAi(scene.place.id, 'allowed');
  });

  test('the backstop refuses a stale or missing epoch on every AI work table; the current epoch passes it', async () => {
    const { ws, place, owner } = scene;
    const rule = randomUUID();
    await pool.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'mentioned', 'tell', false)`,
      [rule, ws.id, place.id, owner.id]);
    const current = await epochOf(place.id);
    const attempt = async (table: string, epoch: number | null) => {
      const reference = table === 'assistant_reaction_events' ? 'reaction_id' : 'project_id';
      const value = table === 'assistant_reaction_events' ? rule : place.id;
      try { await pool.query(`INSERT INTO ${table} (${reference}, ai_epoch) VALUES ($1, $2)`, [value, epoch]); return 'inserted'; }
      catch (error) { return (error as Error).message; }
    };
    for (const table of AI_WORK_QUEUES.tables) {
      assert.match(await attempt(table, current - 1), /AI is turned off in this space/, `${table}: a stale epoch`);
      assert.match(await attempt(table, null), /AI is turned off in this space/, `${table}: a missing epoch`);
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
    await pool.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'blocked', 'tell', true)
      ON CONFLICT (owner_user_id, project_id, event) DO UPDATE SET action = 'tell', enabled = true`, [randomUUID(), ws.id, place.id, owner.id]);
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

  test('a chunk of a space-bound request held at the delivery fence when AI is turned off is refused with the JSON-RPC error on HTTP 200', async () => {
    const connection = await createConnection(pool, scene.owner.browser, { agentId: scene.agentId });
    const clientId = `flux-test-${randomUUID()}`;
    const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
      response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
    const token = (await oauthTokenFor(pool, scene.owner.browser, String(connection.id), clientId, redirectUri)).access_token;
    const gate = `ai-lock-${randomUUID()}`;
    const held = async (flip: boolean) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [gate]);
        const baseline = await lockWaiters();
        const pending = mcp(token, 7, 'tools/list', {}, { headers: { 'x-flux-test-delivery-gate': gate }, query: `flux_connection=${String(connection.id)}&flux_project=${scene.place.id}` });
        await waitFor(async () => (await lockWaiters()) > baseline, 'the response held before its fence');
        if (flip) await setSpaceAi(scene.place.id, 'blocked');
        await client.query('COMMIT');
        return await pending;
      } finally { client.release(); }
    };
    assert.ok(lists(await held(false)), 'control: a held chunk is delivered while AI stays on');
    const refused = await held(true);
    assert.deepEqual([refused.status, errorCode(refused.message), refused.message?.id], [200, 'SPACE_AI_OFF', 7], 'refused with the same JSON-RPC error, not a 403');
  });
});

describe('space AI switch: a comparison in flight and a comparison publish against the flip', () => {
  let owner: Person; let peer: Person; let projectId: string; let material: Material; let conversation: Conversation;
  const masterKey = readFileSync('/run/secrets/flux_background_key');
  const negative = async (title: string) => expectStatus(await peer.browser.request('POST', `/api/v1/projects/${projectId}/results`, { body: { title, finding: 'negative',
    evidence: 'Camera misses at 5 lux', sources: [{ type: 'material', id: material.materialId, version: 1 }, { type: 'message', id: conversation.messages[0]!.id }] } }), 201) as WorkResult;
  const candidateOf = async (resultId: string) => (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id = $1', [resultId])).rows[0]!.id as string;
  const answer = (input: Parameters<ComparisonProvider['createMessage']>[0]) => ({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 },
    answer: { kind: 'comparison', fact: 'Sensor A misses gestures.', interpretation: 'Exposure may be short.', suggestedAction: 'Compare a second sensor.',
      citations: input.sources.map(({ type, id, version }) => ({ type, id, version })) } }) as never;
  const put = async (state: 'allowed' | 'blocked') => expectStatus(await owner.browser.request('PUT', projectAiPolicyPath(projectId), { body: { state } }), 200) as { stopped: { comparisons: number } | null };

  before(async () => {
    [owner, peer] = await Promise.all(['ai-sweep-cmp-owner', 'ai-sweep-cmp-peer'].map(person));
    const ws = await workspace(owner, 'Comparison cutover workspace');
    await addMember(owner, ws.id, peer, 'member');
    projectId = (await project(owner, ws.id, 'Low-light sensors', 'restricted')).id;
    await grant(owner, projectId, peer, 'contributor');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Comparison agent', owner: 'self' } }), 201) as { id: string }).id;
    const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`, { body: { agentId, trigger: 'human_negative_result',
      purpose: 'camera_sensor_comparison', dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal' } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
      provider: 'anthropic', model: 'claude-sonnet-5', apiKey: `sk-ant-api03-${'ai-sweep-owner-key-'.repeat(4)}END8`, dailyBudgetCents: 50 } }), 201);
    await pool.query("UPDATE proactive_comparison_rules SET status = 'enabled' WHERE id = $1", [rule.id]);
    material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Sensor measurement', body: 'Camera A captured 38% of gestures at 5 lux.' } }), 201) as Material;
    conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
      { body: { body: 'Compare sensor measurements.', clientMessageId: randomUUID() } }), 201) as Conversation;
  });
  after(async () => { await ensureSpaceAiAllowed(projectId); });

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
    const flipping: ComparisonProvider = { async countInputTokens() { return 100; }, async createMessage(input) { await setSpaceAi(projectId, 'blocked'); return answer(input); } };
    assert.notEqual((await dispatchProactiveComparison({ db, candidateId: first, masterKey, provider: flipping })).status, 'proposal');
    await setSpaceAi(projectId, 'allowed');
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
