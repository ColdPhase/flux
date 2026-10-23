import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { AI_HTTP_ROUTES, INBOX_PATH, NEEDS_YOU_PATH, type AiRouteRule, type AiScopeKind, type InboxResponse } from '@flux/contracts';
import type { Database } from '@flux/core';
import { aiRoutes } from '../../apps/server/src/access/ai-gate.js';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import type { SessionResolver } from '../../apps/server/src/identity/index.js';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';
import { pool } from './support/db.js';
import { expectStatus } from './support/people.js';
import { ensureWorkspaceAiAllowed, setWorkspaceAi } from './support/workspace-ai.js';

// F-029 workspace AI lock, S1 (#614): every gated route of AI_HTTP_ROUTES answers 403 WORKSPACE_AI_BLOCKED in a workspace
// whose AI is off, writing nothing; the same call in a workspace with AI on is the positive control, and a person who is not
// a member of the blocked workspace learns nothing about it. Every AI module route is classified, or the API does not start.
// A task is not handed to an agent, and AI-origin Inbox items are left out of lists, counts and direct reads, while AI is off.

type Objects = Record<AiScopeKind, string>;
const code = (json: unknown) => (json as { code?: string } | null)?.code;

/** One object of every kind a gated route names, in the scene's workspace (rows written directly where no API makes one). */
async function objectsOf(scene: AssistantScene): Promise<Objects> {
  const { owner, ws, place, thread, agentId } = scene;
  const work = await scene.task(owner, 'Calibrate the probes');
  const run = await scene.runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look around' });
  await pool.query(`UPDATE personal_runs SET status = 'completed', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [run.run.id]);
  const ids = { change: randomUUID(), proposal: randomUUID(), question: randomUUID(), rule: randomUUID(), comparison: randomUUID(),
    outcome: randomUUID(), join: randomUUID(), job: randomUUID(), notification: randomUUID() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Test fixture only: foreign keys are not what these rows exercise (only their workspace is read).
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(`INSERT INTO assistant_changes (id, workspace_id, project_id, run_id, owner_user_id, agent_id, client_command_id, fingerprint, tool, operation,
      object_type, state, policy_version, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'flux_update_task', 'work.update', 'work', 'not_now', 1, now() + interval '1 day')`,
    [ids.change, ws.id, place.id, run.run.id, owner.id, agentId, randomUUID(), createHash('sha256').update(ids.change).digest('hex')]);
    await client.query(`INSERT INTO assistant_proposals (id, workspace_id, project_id, run_id, owner_user_id, fact, interpretation, change_type, result_title, result_finding)
      VALUES ($1, $2, $3, $4, $5, 'Fact', 'Meaning', 'result', 'Result', 'negative')`, [ids.proposal, ws.id, place.id, randomUUID(), owner.id]);
    await client.query(`INSERT INTO agent_questions (id, workspace_id, project_id, conversation_id, message_id, agent_id, asked_user_id, question, options)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Which probe?', '["A","B"]')`, [ids.question, ws.id, place.id, thread.id, randomUUID(), agentId, owner.id]);
    await client.query(`INSERT INTO proactive_comparison_rules (id, workspace_id, project_id, owner_user_id, agent_id, max_runs_per_day, period_budget_cents, per_run_cents)
      VALUES ($1, $2, $3, $4, $5, 1, 10, 5)`, [ids.rule, ws.id, place.id, owner.id, agentId]);
    await client.query(`INSERT INTO proactive_comparison_proposals (id, outbox_id, owner_user_id, agent_id, project_id, result_id, source_fingerprint, sources,
      fact, interpretation, suggested_action, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, '[]', 'Fact', 'Meaning', 'Check', 'anthropic', 'claude-sonnet-5')`,
    [ids.comparison, randomUUID(), owner.id, agentId, place.id, randomUUID(), 'a'.repeat(64)]);
    await client.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title) VALUES ($1, $2, $3, 'project', $4, 'A note')`,
      [ids.notification, owner.id, ws.id, place.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { workspace: ws.id, project: place.id, conversation: thread.id, work: work.id, agent: agentId, connection: await scene.assistantConnectionId(),
    run: run.run.id, assistant_proposal: ids.proposal, assistant_change: ids.change, agent_question: ids.question, comparison_rule: ids.rule,
    comparison_proposal: ids.comparison, comparison_outcome: ids.outcome, assistant_join: ids.join, assistant_job: ids.job, notification: ids.notification };
}

/** The request a gated route answers to: its scope object in the path or body, the owner wherever an owner is named. */
function requestFor(route: string, rule: Extract<AiRouteRule, { gate: 'gated' }>, objects: Objects, ownerId: string) {
  const [method, pattern] = route.split(' ') as [string, string];
  const path = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => rule.from === 'params' && name === rule.key ? objects[rule.kind]
    : name === 'ownerUserId' || name === 'owner' ? ownerId : randomUUID());
  const body = method === 'GET' || method === 'DELETE' ? undefined : {
    ...(rule.from === 'body' ? { [rule.key]: objects[rule.kind] } : {}), ...(rule.onlyWhen ? { [rule.onlyWhen.body]: rule.onlyWhen.equals } : {}) };
  return { method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path, body };
}

const gatedRoutes = Object.entries(AI_HTTP_ROUTES).filter((entry): entry is [string, Extract<AiRouteRule, { gate: 'gated' }>] => entry[1].gate === 'gated');

describe('workspace AI lock: HTTP routes', () => {
  let blocked: AssistantScene; let allowed: AssistantScene; let a: Objects; let b: Objects;

  before(async () => {
    blocked = await assistantScene('ai-off');
    allowed = await assistantScene('ai-on');
    a = await objectsOf(blocked);
    b = await objectsOf(allowed);
  });
  beforeEach(async () => { if (blocked) await ensureWorkspaceAiAllowed(blocked.ws.id); });
  after(async () => { await ensureWorkspaceAiAllowed(blocked.ws.id); });

  test('every gated route refuses while AI is off and writes nothing; AI on and outsiders are unaffected', async () => {
    assert.ok(gatedRoutes.length >= 50, `the manifest gates the AI routes (${gatedRoutes.length})`);
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM personal_runs WHERE workspace_id = $1) AS runs, (SELECT count(*) FROM agent_connections WHERE workspace_id = $1) AS connections,
      (SELECT count(*) FROM assistant_jobs WHERE workspace_id = $1) AS jobs, (SELECT count(*) FROM assistant_reactions WHERE workspace_id = $1) AS reactions,
      (SELECT count(*) FROM agent_project_policies p JOIN projects j ON j.id = p.project_id WHERE j.workspace_id = $1) AS policies,
      (SELECT count(*) FROM events WHERE workspace_id = $1) AS events`, [blocked.ws.id])).rows[0];
    await setWorkspaceAi(blocked.ws.id, 'blocked');
    const before = await counts();
    const failures: string[] = [];
    for (const [route, rule] of gatedRoutes) {
      const off = requestFor(route, rule, a, blocked.owner.id);
      const refused = await blocked.owner.browser.request(off.method, off.path, off.body ? { body: off.body } : {});
      if (refused.status !== 403 || code(refused.json) !== 'WORKSPACE_AI_BLOCKED') failures.push(`${route}: ${refused.status} ${refused.text.slice(0, 120)}`);
      // A person outside the blocked workspace learns nothing about it.
      const outsider = await allowed.owner.browser.request(off.method, off.path, off.body ? { body: off.body } : {});
      if (code(outsider.json) === 'WORKSPACE_AI_BLOCKED') failures.push(`${route}: an outsider was told AI is off`);
      // The positive control: the same call where AI is on is not refused for AI.
      const on = requestFor(route, rule, b, allowed.owner.id);
      const answered = await allowed.owner.browser.request(on.method, on.path, on.body ? { body: on.body } : {});
      if (code(answered.json) === 'WORKSPACE_AI_BLOCKED') failures.push(`${route}: refused where AI is on`);
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(await counts(), before, 'no run, connection, schedule, reaction, policy or event was written');
  });

  test('a narrowing call is not refused: pausing a comparison rule, turning off a reaction', async () => {
    await setWorkspaceAi(blocked.ws.id, 'blocked');
    const pause = await blocked.owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${a.comparison_rule}`, { body: { expectedVersion: 1, status: 'paused' } });
    assert.notEqual(code(pause.json), 'WORKSPACE_AI_BLOCKED', 'pausing stays possible');
    const enable = await blocked.owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${a.comparison_rule}`, { body: { expectedVersion: 1, status: 'enabled' } });
    assert.equal(code(enable.json), 'WORKSPACE_AI_BLOCKED', 'turning it on is refused');
  });

  test('a task is not handed to an agent while AI is off; people stay assignable', async () => {
    await setWorkspaceAi(blocked.ws.id, 'blocked');
    const task = await blocked.task(blocked.owner, 'Hand this off');
    const handoff = await blocked.owner.browser.request('PATCH', `/api/v1/work/${task.id}`,
      { body: { owner: { kind: 'agent', id: blocked.agentId } }, headers: { 'if-match': `"${task.version}"` } });
    assert.deepEqual([handoff.status, code(handoff.json)], [403, 'WORKSPACE_AI_BLOCKED']);
    expectStatus(await blocked.owner.browser.request('PATCH', `/api/v1/work/${task.id}`,
      { body: { owner: { kind: 'human', id: blocked.peer.id } }, headers: { 'if-match': `"${task.version}"` } }), 200);
    const control = await allowed.task(allowed.owner, 'Hand this off');
    const allowedHandoff = await allowed.owner.browser.request('PATCH', `/api/v1/work/${control.id}`,
      { body: { owner: { kind: 'agent', id: allowed.agentId } }, headers: { 'if-match': `"${control.version}"` } });
    assert.notEqual(code(allowedHandoff.json), 'WORKSPACE_AI_BLOCKED', 'control: the same hand-off where AI is on');
  });

  test('AI-origin Inbox items leave lists, counts and direct reads while AI is off; people\'s items stay', async () => {
    await setWorkspaceAi(blocked.ws.id, 'allowed');
    const { owner, ws, place, agentId } = blocked;
    const eventId = randomUUID(); const aiNote = randomUUID(); const humanNote = randomUUID();
    await pool.query(`INSERT INTO events (id, workspace_id, kind, object_id, actor_id, data) VALUES ($1, $2, 'project.agent_question_asked.v1', $3, $4, '{}')`,
      [eventId, ws.id, place.id, `agent:${agentId}`]);
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, reason, event_id, ai_origin) VALUES
      ($1, $2, $3, 'project', $4, 'Your agent asks', 'question', $5, true), ($6, $2, $3, 'project', $4, 'Jonas asks', 'question', NULL, false)`,
    [aiNote, owner.id, ws.id, place.id, eventId, humanNote]);
    const inbox = async () => expectStatus(await owner.browser.request('GET', INBOX_PATH), 200) as InboxResponse;
    const needsYou = async () => (expectStatus(await owner.browser.request('GET', NEEDS_YOU_PATH), 200) as { items: { key: string }[] }).items.map((item) => item.key);
    const on = await inbox();
    assert.ok(on.items.some((item) => item.id === aiNote) && on.items.some((item) => item.id === humanNote), 'control: both are listed while AI is on');
    assert.ok((await needsYou()).includes(`note:${aiNote}`));
    await setWorkspaceAi(ws.id, 'blocked');
    const off = await inbox();
    assert.ok(!off.items.some((item) => item.id === aiNote), 'the AI-origin item is left out');
    assert.ok(off.items.some((item) => item.id === humanNote), 'a person\'s item stays');
    assert.equal(off.unread, on.unread - 1, 'and the count follows');
    assert.ok(!(await needsYou()).includes(`note:${aiNote}`) && (await needsYou()).includes(`note:${humanNote}`));
    assert.equal((await owner.browser.request('GET', `${INBOX_PATH}/${aiNote}`)).status, 404, 'a direct read finds nothing');
    expectStatus(await owner.browser.request('GET', `${INBOX_PATH}/${humanNote}`), 200);
  });

  test('every AI module route is classified, or the API does not start', async () => {
    const stub = { db: {} as Database, sessions: {} as SessionResolver };
    const unclassified = Fastify();
    await assert.rejects(async () => {
      await unclassified.register(aiRoutes(async (app) => { app.get('/api/v1/unclassified-ai-route', async () => ({})); }), stub);
      await unclassified.ready();
    }, /AI route is not classified in AI_HTTP_ROUTES: GET \/api\/v1\/unclassified-ai-route/);
    await unclassified.close().catch(() => undefined);
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `ai-routes-${'x'.repeat(40)}`,
      FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080' };
    const app = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'));
    await app.close();
  });
});

