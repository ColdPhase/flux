import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { personalRunTokenPath } from '@flux/contracts';
import { personalRunTokenRows } from '@flux/db';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';
import { db, pool } from './support/db.js';
import { apiUrl, publicOrigin } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken } from './support/mcp.js';
import { expectStatus } from './support/people.js';
import { ensureWorkspaceAiAllowed, setWorkspaceAi } from './support/workspace-ai.js';

// F-029 workspace AI lock, S1 (#614): already-issued tokens, existing connections and queued runs never override the block.
// An external MCP connection and a personal run's token are refused before any tool list; the refresh grant is refused;
// a queued run ends `stopped`/`ai_off` with no provider request; work admitted before AI was turned off never runs after it
// is turned on again (epoch). Every refusal has its control while AI is on.

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** The tool list really came back (a refusal is also HTTP 200, as a JSON-RPC error). */
const lists = (response: { message: Record<string, unknown> | null }) => (((response.message?.result as { tools?: unknown[] } | undefined)?.tools) ?? []).length > 0;
const errorCode = (message: Record<string, unknown> | null) => ((message?.error as { data?: { code?: string } } | undefined)?.data?.code);

describe('workspace AI lock: tokens, connections and runs', () => {
  let scene: AssistantScene;
  let accessToken: string; let refreshToken: string; let clientId: string;

  before(async () => {
    scene = await assistantScene('ai-runs');
    const connection = expect(await scene.owner.browser.request('POST', '/api/v1/agent-connections',
      { body: { agentId: scene.agentId, selectedProjectIds: [scene.place.id], scopes: ['flux.context.read'] } }), 201);
    clientId = `flux-test-${randomUUID()}`;
    const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
      response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
    const tokens = await oauthToken(scene.owner.browser, String(connection.id), clientId, redirectUri,
      await beginOauth(scene.owner.browser, clientId, redirectUri, { scope: 'flux.context.read offline_access' }));
    accessToken = tokens.access_token; refreshToken = tokens.refresh_token;
  });
  beforeEach(async () => { await ensureWorkspaceAiAllowed(scene.ws.id); });
  after(async () => { await ensureWorkspaceAiAllowed(scene.ws.id); });

  const refresh = () => fetch(new URL('/api/auth/oauth2/token', apiUrl), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }) });

  test('an existing external connection and its tokens are refused before any tool list; AI on again works again', async () => {
    const listed = await mcp(accessToken, 1, 'tools/list');
    assert.equal(listed.status, 200, 'control: the connection lists its tools while AI is on');
    assert.ok(((listed.message?.result as { tools?: unknown[] })?.tools ?? []).length > 0);
    await setWorkspaceAi(scene.ws.id, 'blocked');
    for (const [method, params] of [['tools/list', {}], ['tools/call', { name: 'flux_list_contexts', arguments: {} }], ['resources/list', {}]] as const) {
      const refused = await mcp(accessToken, 2, method, params);
      // A JSON-RPC error on HTTP 200: a 401/403 would make a real client drop its sign-in (see mcp-route.ts).
      assert.equal(refused.status, 200, method);
      assert.equal(errorCode(refused.message), 'WORKSPACE_AI_BLOCKED', method);
      assert.equal(refused.message?.id, 2, 'the refusal answers the request it refuses');
      assert.equal(JSON.stringify(refused.message).includes('tools'), false, 'nothing of the tool list is delivered');
    }
    const refreshed = await refresh();
    assert.equal(refreshed.status, 400, 'the refresh grant is refused');
    assert.match(JSON.stringify(await refreshed.json()), /invalid_grant.*AI is turned off in this workspace|AI is turned off in this workspace.*invalid_grant/);
    await setWorkspaceAi(scene.ws.id, 'allowed');
    assert.ok(lists(await mcp(accessToken, 3, 'tools/list')), 'the connection works again once AI is on (standing configuration resumes)');
    const again = await refresh();
    assert.equal(again.status, 200, 'and its refresh token too');
    refreshToken = ((await again.json()) as { refresh_token: string }).refresh_token ?? refreshToken;
  });

  test('flux_get_agent_thread reads the task inside the checked transaction: a task of a selected project is read, an unknown id is not found, a blocked workspace refuses first', async () => {
    const task = await scene.task(scene.owner, 'Agents thread task');
    const text = (message: Record<string, unknown> | null) => ((message?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text) ?? '';
    const known = await mcp(accessToken, 10, 'tools/call', { name: 'flux_get_agent_thread', arguments: { taskId: task.id } });
    assert.equal((known.message?.result as { isError?: boolean } | undefined)?.isError ?? false, false, `control: a task of a selected project is read: ${text(known.message)}`);
    const unknown = await mcp(accessToken, 11, 'tools/call', { name: 'flux_get_agent_thread', arguments: { taskId: randomUUID() } });
    assert.equal((unknown.message?.result as { isError?: boolean } | undefined)?.isError, true, 'an unknown task is an error result');
    assert.match(text(unknown.message), /PROJECT_NOT_FOUND/);
    await setWorkspaceAi(scene.ws.id, 'blocked');
    try {
      for (const taskId of [task.id, randomUUID()]) {
        const refused = await mcp(accessToken, 12, 'tools/call', { name: 'flux_get_agent_thread', arguments: { taskId } });
        assert.equal(errorCode(refused.message), 'WORKSPACE_AI_BLOCKED', 'existing and unknown ids are refused alike');
      }
    } finally { await setWorkspaceAi(scene.ws.id, 'allowed'); }
  });

  test('a run token minted before AI was turned off is refused, a new one is not minted, and neither works after re-enable', async () => {
    await scene.reset();
    const live = await scene.liveRun();
    assert.ok(lists(await live.raw('tools/list')), 'control: the run token lists its tools');
    await setWorkspaceAi(scene.ws.id, 'blocked');
    const refused = await live.raw('tools/list');
    assert.deepEqual([refused.status, errorCode(refused.message)], [200, 'WORKSPACE_AI_BLOCKED']);
    await setWorkspaceAi(scene.ws.id, 'allowed');
    const stale = await live.raw('tools/list');
    assert.equal(errorCode(stale.message), 'WORKSPACE_AI_BLOCKED', 'a run admitted before AI was turned off never works after it is turned on again');
    await scene.complete(live.runId);
  });

  test('no token is minted for a run while AI is off', async () => {
    await scene.reset();
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look' });
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [started.run.id]);
    const nonce = randomBytes(32).toString('hex');
    assert.equal(await db.transaction((tx) => personalRunTokenRows(tx).arm(started.run.id, sha256(nonce))), true);
    await setWorkspaceAi(scene.ws.id, 'blocked');
    const minted = await fetch(`${apiUrl}${personalRunTokenPath(started.run.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    assert.equal(minted.status, 404, 'the uniform refusal');
    assert.equal((await pool.query('SELECT run_token_jti FROM personal_runs WHERE id = $1', [started.run.id])).rows[0].run_token_jti, null);
    await setWorkspaceAi(scene.ws.id, 'allowed');
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [started.run.id]);
  });

  test('asking while AI is off is refused and writes no run; a queued run ends ai_off with no provider request', async () => {
    await scene.reset();
    await setWorkspaceAi(scene.ws.id, 'blocked');
    const asked = await scene.owner.browser.request('POST', `/api/v1/conversations/${scene.thread.id}/assistant-runs`,
      { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look' } });
    assert.deepEqual([asked.status, (asked.json as { code?: string }).code], [403, 'WORKSPACE_AI_BLOCKED']);
    await assert.rejects(scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look' }),
      (error: { code?: string }) => error.code === 'WORKSPACE_AI_BLOCKED', 'the use case refuses as well');
    await setWorkspaceAi(scene.ws.id, 'allowed');

    // Queued while AI was on, then AI turned off: the worker ends it before reading or dispatching.
    const queued = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look' });
    await setWorkspaceAi(scene.ws.id, 'blocked');
    const dispatched = scene.compute.dispatched.length; const counted = scene.compute.counted.length;
    await scene.processor.process(queued.run.id);
    const ended = (await pool.query('SELECT status, end_reason, stopped_at_stage, cost_state FROM personal_runs WHERE id = $1', [queued.run.id])).rows[0];
    assert.deepEqual(ended, { status: 'stopped', end_reason: 'ai_off', stopped_at_stage: 'before_read', cost_state: 'released' });
    assert.deepEqual([scene.compute.dispatched.length, scene.compute.counted.length], [dispatched, counted], 'no provider request');

    // Admitted before AI was turned off and on again (an older epoch): never runs.
    await setWorkspaceAi(scene.ws.id, 'allowed');
    const earlier = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look' });
    await setWorkspaceAi(scene.ws.id, 'blocked');
    await setWorkspaceAi(scene.ws.id, 'allowed');
    await scene.processor.process(earlier.run.id);
    assert.equal((await pool.query('SELECT end_reason FROM personal_runs WHERE id = $1', [earlier.run.id])).rows[0].end_reason, 'ai_off');
    assert.equal(scene.compute.dispatched.length, dispatched, 'still no provider request');

    // The control: a run admitted while AI is on reaches the provider.
    const control = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look' });
    await scene.processor.process(control.run.id);
    assert.ok(scene.compute.dispatched.length > dispatched, 'control: the provider is called while AI is on');
    expectStatus(await scene.owner.browser.request('GET', `/api/v1/assistant-runs/${control.run.id}`), 200);
  });

  test('#68: Retry and Continue are refused while AI is off and write no run; Stop is not blocked; AI on again works again', async () => {
    await scene.reset();
    const invokePath = `/api/v1/conversations/${scene.thread.id}/assistant-runs`;
    const earlier = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look' });
    assert.equal(await scene.processor.process(earlier.run.id), 'completed');
    const waiting = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look again' });
    const runs = async () => Number((await pool.query('SELECT count(*) FROM personal_runs WHERE owner_user_id = $1', [scene.owner.id])).rows[0].count);
    const written = await runs(); const dispatched = scene.compute.dispatched.length;
    await setWorkspaceAi(scene.ws.id, 'blocked');
    const code = (response: { json: unknown }) => (response.json as { code?: string }).code;
    const retried = await scene.owner.browser.request('POST', `/api/v1/assistant-runs/${earlier.run.id}/retry`, { body: { clientRunId: randomUUID() } });
    assert.deepEqual([retried.status, code(retried)], [403, 'WORKSPACE_AI_BLOCKED']);
    const continued = await scene.owner.browser.request('POST', invokePath, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'More', continuesRunId: earlier.run.id } });
    assert.deepEqual([continued.status, code(continued)], [403, 'WORKSPACE_AI_BLOCKED']);
    assert.equal(await runs(), written, 'neither wrote a run');
    // A person can always stop their own run; the queued one ended with the switch and costs nothing.
    const stopped = expectStatus(await scene.owner.browser.request('POST', `/api/v1/assistant-runs/${waiting.run.id}/stop`), 200) as { status: string; cost: { state: string } };
    assert.deepEqual([stopped.status, stopped.cost.state], ['stopped', 'released']);
    assert.equal(scene.compute.dispatched.length, dispatched, 'no provider request');
    await setWorkspaceAi(scene.ws.id, 'allowed');
    // The HTTP composition is the production one (provider off); the fake provider of the scene stands for it in the control.
    const again = await scene.runs.retry(human(scene.owner), earlier.run.id, { clientRunId: randomUUID() });
    assert.deepEqual([again.created, again.run.id === earlier.run.id], [true, false], 'control: Retry starts a new run again once AI is on');
  });
});
