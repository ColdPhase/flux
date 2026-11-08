import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import type { PgBoss } from 'pg-boss';
import { assistantRunChangesActionPath, personalRunTokenPath, type Conversation, type Material, type WorkResult } from '@flux/contracts';
import { assistantReactionTick, deliverNotificationEmail, settleAssistantSummaries, startAssistantSummary, type NotificationMailer } from '@flux/core';
import { coworkUnitRows, personalRunTokenRows, pushDeliveryRepository, type Database } from '@flux/db';
import { assistantUnitOfWork, startBackgroundOf } from '../../apps/worker/src/assistant/index.js';
import { emailUnitOfWork } from '../../apps/worker/src/notifications/adapters.js';
import { registerPersonalRunTokenRoute } from '../../apps/server/src/personal-runs/run-tokens.js';
import type { FluxAuth } from '../../apps/server/src/identity/auth.js';
import { assistantScene, changesOf, human, text, type AssistantScene } from './support/assistant-scene.js';
import { db, pool } from './support/db.js';
import { publicOrigin } from './support/http.js';
import { beginOauth, consentContext, mcp, oauthToken, toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import type { ComparisonProvider } from '@flux/core';
import { readFileSync } from 'node:fs';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';
import { createConnection, oauthTokenFor, registerOauthClient } from './support/mcp-actions.js';

// AG-10 (F-029 S1 rows of the AC-5 matrix, #614; per space under F-037), each an AI-off case with its control.
// Push and e-mail of AI-origin notifications created before the block; the morning summary's facts, anchor and settle across spaces;
// the reaction tick and the epoch; an external client's tool call that names the space; co-work epochs; the run-token mint refused
// before any GitHub facts are read; connecting a client, which is not a space's business; idempotent replay of a gated command;
// the owner's Undo while AI is off; comparisons (a person's negative result, dispatch under an older epoch).

const code = (json: unknown) => (json as { code?: string } | null)?.code;
const fakeBoss = () => {
  const sent: { name: string; data: unknown }[] = [];
  const boss = { send: async (name: string, data?: unknown) => { sent.push({ name, data }); return randomUUID(); } } as unknown as Pick<PgBoss, 'send'> & PgBoss;
  return { boss, sent };
};

async function externalConnection(scene: AssistantScene) {
  const connection = await createConnection(pool, scene.owner.browser, { agentId: scene.agentId });
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
    response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const scope = 'offline_access';
  const tokens = await oauthTokenFor(pool, scene.owner.browser, String(connection.id), clientId, redirectUri);
  return { connectionId: String(connection.id), clientId, redirectUri, scope, accessToken: tokens.access_token };
}

describe('space AI switch: the remaining surfaces', () => {
  let scene: AssistantScene; let other: AssistantScene;

  before(async () => {
    scene = await assistantScene('ai-surfaces');
    other = await assistantScene('ai-surfaces-other');
  });
  beforeEach(async () => { await ensureSpaceAiAllowed(scene.place.id); await scene.reset(); });
  after(async () => { await ensureSpaceAiAllowed(scene.place.id); });

  test('push and e-mail skip an AI-origin notification created before the block; a person\'s notification is still sent; read is refused', async () => {
    const { owner, ws, place, agentId } = scene;
    const eventId = randomUUID(); const ai = randomUUID(); const person = randomUUID();
    await pool.query(`INSERT INTO events (id, workspace_id, kind, object_id, actor_id, data) VALUES ($1, $2, 'project.agent_question_asked.v1', $3, $4, '{}')`,
      [eventId, ws.id, place.id, `agent:${agentId}`]);
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, event_id, ai_origin) VALUES
      ($1, $2, $3, 'project', $4, 'From the agent', $5, true), ($6, $2, $3, 'project', $4, 'From Jonas', NULL, false)`, [ai, owner.id, ws.id, place.id, eventId, person]);
    const session = (await pool.query('SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [owner.id])).rows[0].id as string;
    const subscriptionId = randomUUID();
    await pool.query(`INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, 'p256dh', 'auth')`,
      [subscriptionId, owner.id, session, `https://push.example.test/${subscriptionId}`]);
    const emails = { ai: randomUUID(), person: randomUUID() };
    await pool.query(`INSERT INTO notification_emails (id, notification_id, user_id, address_kind) VALUES ($1, $2, $4, 'account'), ($3, $5, $4, 'account')`,
      [emails.ai, ai, emails.person, owner.id, person]);
    const target = (notificationId: string) => pushDeliveryRepository(db).findTarget({ notificationId, subscriptionId, userId: owner.id });
    assert.ok(await target(ai), 'control: while AI is on the AI-origin notification is a push target');
    await setSpaceAi(place.id, 'blocked');
    assert.equal(await target(ai), null, 'not pushed while AI is off');
    assert.ok(await target(person), 'a person\'s notification is still pushed');
    const sent: string[] = [];
    const mailer = { send: async (message: { to: string }) => { sent.push(message.to); return { messageId: randomUUID() }; } } as unknown as NotificationMailer;
    const options = { available: true, origin: publicOrigin, uow: emailUnitOfWork(db, fakeBoss().boss), mailer };
    const aiMail = await deliverNotificationEmail(options, { emailId: emails.ai });
    assert.equal((aiMail as { reason?: string }).reason, 'AI is off in this space', JSON.stringify(aiMail));
    const personMail = await deliverNotificationEmail(options, { emailId: emails.person });
    assert.equal(personMail.outcome, 'sent', JSON.stringify(personMail));
    assert.equal(sent.length, 1, 'only the person\'s notification was e-mailed');
    assert.equal((await owner.browser.request('POST', `/api/v1/inbox/${ai}/read`)).status, 404, 'a hidden notification cannot be marked read');
    expectStatus(await owner.browser.request('POST', `/api/v1/inbox/${person}/read`), 200);
  });

  test('the morning summary gives the assistant no fact of a space whose AI is off, anchors only where AI is on, and writes no line for a blocked run', async () => {
    const blockedSpace = randomUUID(); const openSpace = randomUUID(); const workspaceId = randomUUID();
    const blocked = new Set<string>([blockedSpace]);
    const started: { projectId: string; prompt: string }[] = [];
    const access = { spaceAi: async (id: string) => ({ state: blocked.has(id) ? 'blocked' : 'allowed', epoch: 1 }) };
    const rows = [{ id: 'n-blocked', source: { workspaceId, type: 'project', id: blockedSpace } }, { id: 'n-open', source: { workspaceId, type: 'project', id: openSpace } }];
    const titles = new Map([['n-blocked', 'Secret plan of the blocked club'], ['n-open', 'Lamp sensor ordered']]);
    const ports = {
      access,
      runs: { enablement: async () => ({ status: 'active', engine: 'server', provider: 'anthropic', model: 'm', connectionId: 'c',
        agents: [{ workspaceId, agentId: randomUUID() }] }) },
      jobs: { noteVersion: async () => null },
      summaries: { titles: async (ids: string[]) => new Map(ids.map((id) => [id, titles.get(id)!])), firstName: async () => 'Ada',
        // The blocked space is the first place the person could be anchored in.
        anchors: async () => [{ projectId: blockedSpace, conversationId: randomUUID() }, { projectId: openSpace, conversationId: randomUUID() }],
        create: async () => true },
    };
    const summary = { unread: async () => rows, isMuted: async () => false,
      authorizer: { canRead: async (_user: string, source: { workspaceId: string }) => ({ visible: true, allowed: true, workspaceId: source.workspaceId }) } };
    const startBackground = async (_ports: unknown, spec: { projectId: string; prompt: string }) => { started.push(spec); return { started: true, run: { id: 'run' }, created: true }; };
    assert.equal(await startAssistantSummary(ports as never, summary as never, startBackground as never, 'user', '2026-10-23', new Date()), true);
    assert.equal(started.length, 1);
    assert.equal(started[0]!.projectId, openSpace, 'anchored in the space whose AI is on');
    assert.ok(started[0]!.prompt.includes('Lamp sensor ordered'), 'control: the open space\'s fact is given');
    assert.ok(!started[0]!.prompt.includes('Secret plan'), 'nothing of the blocked space reaches the prompt');
    // With every space blocked there is no run (the plain summary goes out).
    blocked.add(openSpace);
    assert.equal(await startAssistantSummary(ports as never, summary as never, startBackground as never, 'user', '2026-10-23', new Date()), false);
    // Settling: a completed run of a blocked space writes no assistant line; the plain summary goes out.
    const settled: string[] = [];
    const settlePorts = (projectId: string) => ({ access,
      summaries: { writing: async () => [{ ownerUserId: 'user', day: '2026-10-23' }], lock: async () => ({ ownerUserId: 'user', day: '2026-10-23', runId: 'run', createdAt: new Date() }),
        settle: async (_u: string, _d: string, state: string) => { settled.push(state); } },
      runs: { findRun: async () => ({ id: 'run', projectId, status: 'completed', answerBody: 'You have two new things' }) } });
    const plainSummary = { unread: async () => [], insertSummary: async () => undefined, deliver: async () => undefined } as never;
    const uow = (projectId: string) => ({ run: (work: (ports: never, summary: never) => Promise<unknown>) => work(settlePorts(projectId) as never, plainSummary) });
    await settleAssistantSummaries(uow(blockedSpace) as never);
    blocked.delete(openSpace);
    await settleAssistantSummaries(uow(openSpace) as never);
    assert.equal(settled[0], 'plain', 'a blocked space\'s run writes no line');
    assert.equal(settled[1], 'written', 'control: a run where AI is on writes its line');
  });

  test('a reaction event captured before AI was turned off is skipped after re-enable; one captured now runs', async () => {
    const { owner, ws, place } = scene;
    const rule = randomUUID();
    await pool.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'blocked', 'tell', true)`,
      [rule, ws.id, place.id, owner.id]);
    const epoch = async () => Number((await pool.query('SELECT epoch FROM project_ai_policies WHERE project_id = $1', [place.id])).rows[0].epoch);
    const future = new Date(Date.now() + 7 * 86_400_000); // ahead of the real clock: the Compose worker's own tick never meets it
    const event = async (aiEpoch: number) => (await pool.query(`INSERT INTO assistant_reaction_events (reaction_id, owner_user_id, object_id, source_id, action, event,
      reaction_version, state, ai_epoch, created_at) VALUES ($1, $2, $3, $4, 'tell', 'blocked', 1, 'queued', $5, $6) RETURNING id`,
    [rule, owner.id, randomUUID(), randomUUID(), aiEpoch, future])).rows[0].id as string;
    const stale = await event(await epoch());
    await setSpaceAi(place.id, 'blocked');
    await setSpaceAi(place.id, 'allowed');
    const current = await event(await epoch());
    const { boss } = fakeBoss();
    await assistantReactionTick({ uow: assistantUnitOfWork(db, boss), startBackground: startBackgroundOf({ connections: scene.connections, providerEnabled: true }, db, boss) },
      new Date(future.getTime() + 60_000));
    const line = async (id: string) => (await pool.query('SELECT state, line FROM assistant_reaction_events WHERE id = $1', [id])).rows[0] as { state: string; line: string };
    assert.deepEqual(await line(stale), { state: 'skipped', line: 'Skipped: AI was turned off' });
    assert.notEqual((await line(current)).line, 'Skipped: AI was turned off', 'control: the current event is not skipped for AI');
    await pool.query('DELETE FROM assistant_reactions WHERE id = $1', [rule]);
  });

  test('an external client\'s tool call that names the space answers SPACE_AI_OFF while AI is off there, and works again; the connection itself stays', async () => {
    const external = await externalConnection(scene);
    const call = (id: number) => mcp(external.accessToken, id, 'tools/call', { name: 'flux_bootstrap', arguments: { projectId: scene.place.id, clientSessionId: randomUUID() } });
    const first = await call(1);
    assert.ok(!(first.message?.result as { isError?: boolean } | undefined)?.isError, `control: ${JSON.stringify(first.message).slice(0, 300)}`);
    await setSpaceAi(scene.place.id, 'blocked');
    const refused = await call(2);
    assert.match(JSON.stringify(refused.message), /SPACE_AI_OFF/, 'the tool call is refused for that space');
    // Not for the connection: the tool list is served (a refusal of a whole connection would drop its sign-in in real clients).
    assert.ok((((await mcp(external.accessToken, 3, 'tools/list')).message?.result as { tools?: unknown[] } | undefined)?.tools ?? []).length > 0, 'the connection still lists its tools');
    await setSpaceAi(scene.place.id, 'allowed');
    const again = await call(4);
    assert.ok(!(again.message?.result as { isError?: boolean } | undefined)?.isError, 'works again once AI is on');
    assert.ok(toolValue(again.message));
  });

  test('a co-work unit admitted under an older epoch is not found by its agent', async () => {
    const work = await scene.task(scene.owner, 'Hand to a unit');
    const unitId = randomUUID();
    const epoch = Number((await pool.query('SELECT epoch FROM project_ai_policies WHERE project_id = $1', [scene.place.id])).rows[0].epoch);
    await pool.query(`INSERT INTO cowork_units (id, workspace_id, project_id, work_id, lineage_work_id, run_id, unit_key, role, assignment_connection_id, ai_epoch)
      VALUES ($1, $2, $3, $4, $4, $5, 'unit', 'execute', $6, $7)`, [unitId, scene.ws.id, scene.place.id, work.id, randomUUID(), await scene.assistantConnectionId(), epoch]);
    const connectionId = await scene.assistantConnectionId();
    // The agent's claim path locks its own unit (`coworkUnitRows.lock`, the `own` predicate carries the epoch).
    const located = () => db.transaction(async (tx) => (await coworkUnitRows(tx).lock({ workspaceId: scene.ws.id, projectId: scene.place.id, connectionId, unitId }))?.unit ?? null);
    assert.ok(await located(), 'control: the unit is found at its epoch');
    await setSpaceAi(scene.place.id, 'blocked');
    await setSpaceAi(scene.place.id, 'allowed');
    assert.equal(await located(), null, 'admitted before the block: never found again');
  });

  test('the run-token mint refuses before any GitHub facts are read', async () => {
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Check the PR' });
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [started.run.id]);
    const rule = randomUUID();
    await pool.query(`INSERT INTO assistant_reactions (id, workspace_id, project_id, owner_user_id, event, action, enabled) VALUES ($1, $2, $3, $4, 'pr_ready', 'check_task', true)`,
      [rule, scene.ws.id, scene.place.id, scene.owner.id]);
    const epoch = Number((await pool.query('SELECT epoch FROM project_ai_policies WHERE project_id = $1', [scene.place.id])).rows[0].epoch);
    await pool.query(`INSERT INTO assistant_reaction_events (reaction_id, owner_user_id, object_id, source_id, action, event, reaction_version, state, run_id, ai_epoch)
      VALUES ($1, $2, $3, $4, 'check_task', 'pr_ready', 1, 'running', $5, $6)`, [rule, scene.owner.id, randomUUID(), randomUUID(), started.run.id, epoch]);
    const facts: string[] = [];
    const app = Fastify();
    registerPersonalRunTokenRoute(app, db as Database, {} as FluxAuth, publicOrigin, async (_owner, taskId) => { facts.push(taskId); throw new Error('stop here'); });
    try {
      const mint = async () => {
        const nonce = randomBytes(32).toString('hex');
        await pool.query('UPDATE personal_runs SET run_token_nonce_hash = NULL WHERE id = $1', [started.run.id]);
        assert.equal(await db.transaction((tx) => personalRunTokenRows(tx).arm(started.run.id, createHash('sha256').update(nonce).digest('hex'))), true);
        return app.inject({ method: 'POST', url: personalRunTokenPath(started.run.id), payload: { nonce } });
      };
      await setSpaceAi(scene.place.id, 'blocked');
      assert.equal((await mint()).statusCode, 404);
      assert.deepEqual(facts, [], 'no GitHub facts were read while AI is off');
      await setSpaceAi(scene.place.id, 'allowed');
      await pool.query('UPDATE assistant_reaction_events SET ai_epoch = $2 WHERE run_id = $1', [started.run.id, epoch + 2]);
      await pool.query('UPDATE personal_runs SET ai_epoch = $2 WHERE id = $1', [started.run.id, epoch + 2]);
      await mint();
      assert.equal(facts.length, 1, 'control: with AI on the mint reaches the GitHub facts');
    } finally {
      await app.close();
      await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [started.run.id]);
      await pool.query('DELETE FROM assistant_reactions WHERE id = $1', [rule]);
    }
  });

  test('connecting a client is not a space\'s business: the consent page and Allow work while a space\'s AI is off', async () => {
    const { clientId, redirectUri } = await registerOauthClient(pool);
    await setSpaceAi(scene.place.id, 'blocked');
    const started = await beginOauth(scene.owner.browser, clientId, redirectUri);
    assert.equal((await consentContext(scene.owner.browser, started)).clientName, 'Flux HTTP test client', 'the consent page works');
    assert.ok((await oauthToken(scene.owner.browser, clientId, redirectUri, started)).access_token, 'Allow signs the client in');
  });

  test('flux_list_contexts leaves out a space whose AI is off and still lists the client\'s other spaces', async () => {
    const second = await project(scene.owner, scene.ws.id, 'Second room', 'restricted');
    const { accessToken } = await externalConnection(scene);
    let id = 70;
    const listed = async () => (toolValue((await mcp(accessToken, id += 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} })).message).projects as { id: string }[]).map((row) => row.id).sort();
    assert.deepEqual(await listed(), [scene.place.id, second.id].sort(), 'control: both are listed while AI is on');
    await setSpaceAi(scene.place.id, 'blocked');
    assert.deepEqual(await listed(), [second.id], 'the space with AI off is left out and the call still works for the other');
    await setSpaceAi(scene.place.id, 'allowed');
    assert.deepEqual(await listed(), [scene.place.id, second.id].sort(), 'listed again once AI is on');
  });

  test('an idempotent replay of a gated command is refused while AI is off', async () => {
    const key = randomUUID();
    // A proposal the assistant drafted: its owner dismisses it with an Idempotency-Key (test fixture row, as in space-ai-routes).
    const proposalId = randomUUID();
    const fixture = await pool.connect();
    try {
      await fixture.query('BEGIN');
      await fixture.query('SET LOCAL session_replication_role = replica');
      await fixture.query(`INSERT INTO assistant_proposals (id, workspace_id, project_id, run_id, owner_user_id, fact, interpretation, change_type, result_title, result_finding)
        VALUES ($1, $2, $3, $4, $5, 'Fact', 'Meaning', 'result', 'Result', 'negative')`, [proposalId, scene.ws.id, scene.place.id, randomUUID(), scene.owner.id]);
      await fixture.query('COMMIT');
    } catch (error) { await fixture.query('ROLLBACK'); throw error; } finally { fixture.release(); }
    const ask = () => scene.owner.browser.request('POST', `/api/v1/assistant-proposals/${proposalId}/dismiss`, { body: { expectedVersion: 1 }, headers: { 'idempotency-key': key } });
    const first = await ask();
    assert.equal(first.status, 200, `the proposal is dismissed with an Idempotency-Key: ${first.text}`);
    await setSpaceAi(scene.place.id, 'blocked');
    const replay = await ask();
    assert.deepEqual([replay.status, code(replay.json)], [403, 'SPACE_AI_OFF']);
    assert.equal(replay.headers.get('idempotent-replayed'), null, 'the stored body is not returned');
    await setSpaceAi(scene.place.id, 'allowed');
    assert.equal((await ask()).headers.get('idempotent-replayed'), 'true', 'control: replayed once AI is on');
  });

  test('the owner can Undo an applied assistant change while AI is off', async () => {
    const mine = await scene.task(scene.owner, 'Order spare probes');
    const run = await scene.liveRun();
    assert.ok(JSON.parse(text((await run.call('flux_update_task', { workId: mine.id, expectedVersion: mine.version, changes: { title: 'Order four spare probes' } })).message)).workId);
    assert.deepEqual((await changesOf(run.runId)).map((row) => row.state), ['applied']);
    await scene.complete(run.runId);
    await setSpaceAi(scene.place.id, 'blocked');
    expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(run.runId, 'undo'), { body: {} }), 200);
    assert.equal((await scene.taskRow(mine.id)).title, 'Order spare probes', 'the person reversed the AI output');
    const apply = await scene.owner.browser.request('POST', assistantRunChangesActionPath(run.runId, 'apply'), { body: {} });
    assert.equal(code(apply.json), 'SPACE_AI_OFF', 'while Apply stays refused');
  });

  test('other spaces keep AI: the second scene\'s owner works normally while the first is blocked', async () => {
    await setSpaceAi(scene.place.id, 'blocked');
    const asked = await other.owner.browser.request('POST', `/api/v1/workspaces/${other.ws.id}/assistants/${other.owner.id}/schedules`,
      { body: { projectId: other.place.id, text: 'List what moved', schedule: { kind: 'weekly', at: '16:00', weekday: 5 }, timeZone: 'UTC' } });
    assert.equal(asked.status, 201, asked.text);
    const space = expectStatus(await other.owner.browser.request('GET', `/api/v1/projects/${other.place.id}`), 200) as { ai: string };
    assert.equal(space.ai, 'allowed');
    // The same person in the blocked space: the schedule is refused there.
    const refused = await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/assistants/${scene.owner.id}/schedules`,
      { body: { projectId: scene.place.id, text: 'List what moved', schedule: { kind: 'weekly', at: '16:00', weekday: 5 }, timeZone: 'UTC' } });
    assert.deepEqual([refused.status, code(refused.json)], [403, 'SPACE_AI_OFF']);
  });
});

describe('space AI switch: background comparisons', () => {
  let owner: Person; let peer: Person; let projectId: string; let material: Material; let conversation: Conversation;
  const calls: string[] = [];
  const masterKey = readFileSync('/run/secrets/flux_background_key');
  const provider: ComparisonProvider = {
    async countInputTokens() { calls.push('count'); return 100; },
    async createMessage(input) {
      calls.push('message');
      return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 }, answer: { kind: 'comparison', fact: 'Sensor A misses gestures.',
        interpretation: 'Exposure may be short.', suggestedAction: 'Compare a second sensor.', citations: input.sources.map(({ type, id, version }) => ({ type, id, version })) } } as never;
    },
  };
  const negative = async (title: string) => expectStatus(await peer.browser.request('POST', `/api/v1/projects/${projectId}/results`, { body: { title, finding: 'negative',
    evidence: 'Camera misses at 5 lux', sources: [{ type: 'material', id: material.materialId, version: 1 }, { type: 'message', id: conversation.messages[0]!.id }] } }), 201) as WorkResult;
  const candidateOf = async (resultId: string) => (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id = $1', [resultId])).rows[0]?.id as string | undefined;

  before(async () => {
    [owner, peer] = await Promise.all(['ai-comparison-owner', 'ai-comparison-peer'].map(person));
    const ws = await workspace(owner, 'Comparison lock workspace');
    await addMember(owner, ws.id, peer, 'member');
    projectId = (await project(owner, ws.id, 'Low-light sensors', 'restricted')).id;
    await grant(owner, projectId, peer, 'contributor');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Comparison agent', owner: 'self' } }), 201) as { id: string }).id;
    const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`, { body: { agentId, trigger: 'human_negative_result',
      purpose: 'camera_sensor_comparison', dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal' } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
      provider: 'anthropic', model: 'claude-sonnet-5', apiKey: `sk-ant-api03-${'ai-lock-owner-key-'.repeat(4)}END8`, dailyBudgetCents: 17 } }), 201);
    await pool.query("UPDATE proactive_comparison_rules SET status = 'enabled' WHERE id = $1", [rule.id]);
    material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Sensor measurement', body: 'Camera A captured 38% of gestures at 5 lux.' } }), 201) as Material;
    conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
      { body: { body: 'Compare sensor measurements.', clientMessageId: randomUUID() } }), 201) as Conversation;
  });
  after(async () => { await ensureSpaceAiAllowed(projectId); });

  test('a person\'s negative result while AI is off commits and queues no comparison; while AI is on it does', async () => {
    assert.ok(await candidateOf((await negative('Control trial')).id), 'control: a comparison is queued while AI is on');
    await setSpaceAi(projectId, 'blocked');
    try {
      const result = await negative('Trial while AI is off');
      assert.ok(result.id, 'the person\'s result is recorded');
      assert.equal(await candidateOf(result.id), undefined, 'no comparison is queued');
    } finally { await setSpaceAi(projectId, 'allowed'); }
  });

  test('a comparison admitted before AI was turned off is never sent to the provider, even after re-enable', async () => {
    const stale = await candidateOf((await negative('Admitted before the block')).id);
    await setSpaceAi(projectId, 'blocked');
    await setSpaceAi(projectId, 'allowed');
    await comparisonDispatchFixtureDue(pool, stale!);
    const before = calls.length;
    const outcome = await dispatchProactiveComparison({ db, candidateId: stale!, masterKey, provider });
    assert.notEqual(outcome.status, 'proposal', JSON.stringify(outcome));
    assert.equal(calls.length, before, 'negative control: no provider request');
    const fresh = await candidateOf((await negative('Admitted after re-enable')).id);
    await comparisonDispatchFixtureDue(pool, fresh!);
    const control = await dispatchProactiveComparison({ db, candidateId: fresh!, masterKey, provider });
    assert.ok(calls.length > before, `positive control: the provider is called (${JSON.stringify(control)})`);
  });
});
