import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { PgBoss } from 'pg-boss';
import { PERSONAL_RUN_CONSENT_VERSION, workspaceAiPolicyPath, type Conversation, type Workspace } from '@flux/contracts';
import { PERSONAL_RUN_JOB, testFixturePersonalConnections } from '@flux/core';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { connectionString, db, pool } from './support/db.js';
import { Browser, publicOrigin } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken } from './support/mcp.js';
import { expectStatus, person, project, workspace, type Person } from './support/people.js';
import { FakeQueue } from './support/personal-runs.js';
import { waitFor } from './support/wait.js';
import { ensureWorkspaceAiAllowed, setWorkspaceAi, workspaceAiRow } from './support/workspace-ai.js';

// F-029 workspace AI lock, S2 (#614), AC-5 "actual multi-process enforcement and provider-call negative controls".
// Three processes of the check stack, one database: the `api` container takes the turn-off, the `api2` container must refuse
// at once (an MCP tool list, a new run), and the `worker` container must refuse a dispatch of work admitted before AI was
// turned off, with ZERO requests reaching the mock provider; the same steps while AI is on reach it (the positive control).
// Needs the real worker on the mock provider: run with FLUX_TEST_PERSONAL_RUNS=anthropic-mock and
// FLUX_TEST_ANTHROPIC_URL=http://providermock:8095 (see the PR; skipped otherwise).

const live = process.env.FLUX_TEST_PERSONAL_RUNS === 'anthropic-mock';
const api2Url = process.env.FLUX_API2_URL ?? 'http://api2:8080';
const providerUrl = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const code = (json: unknown) => (json as { code?: string } | null)?.code;
/** The tool list really came back (a refusal is also HTTP 200, as a JSON-RPC error). */
const lists = (response: { message: Record<string, unknown> | null }) => (((response.message?.result as { tools?: unknown[] } | undefined)?.tools) ?? []).length > 0;
const errorCode = (message: Record<string, unknown> | null) => ((message?.error as { data?: { code?: string } } | undefined)?.data?.code);
const providerCalls = async () => ((await (await fetch(`${providerUrl}/__requests`)).json()) as { requests: { wire: string; path: string }[] }).requests
  .filter((request) => request.wire === 'anthropic' && request.path.endsWith('/v1/messages')).length;
const runStatus = async (id: string) => (await pool.query('SELECT status, end_reason FROM personal_runs WHERE id = $1', [id])).rows[0] as { status: string; end_reason: string | null };
const ended = (id: string) => waitFor(async () => {
  const row = await runStatus(id);
  return ['queued', 'reading', 'dispatching'].includes(row.status) ? null : row;
}, `run ${id} ended by the worker container`, 30_000);

describe('workspace AI lock across the api, api2 and worker containers', { skip: !live && 'needs FLUX_TEST_PERSONAL_RUNS=anthropic-mock' }, () => {
  let owner: Person; let second: Browser; let ws: Workspace; let thread: Conversation; let agentId: string; let accessToken: string; let boss: PgBoss;
  const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections: testFixturePersonalConnections, providerEnabled: true });
  const put = async (state: 'allowed' | 'blocked') => expectStatus(await owner.browser.request('PUT', workspaceAiPolicyPath(ws.id),
    { body: { state }, headers: { 'if-match': `"${(await workspaceAiRow(ws.id))!.version}"` } }), 200);
  const ask = (who: Browser) => who.request('POST', `/api/v1/conversations/${thread.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'What failed?' } });

  before(async () => {
    owner = await person('ai-two-api');
    ws = await workspace(owner, 'Two API club');
    const place = await project(owner, ws.id, 'Lamp', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'The camera fails below 5 lux', clientMessageId: randomUUID() } }), 201) as Conversation;
    const connectionId = (await testFixturePersonalConnections.resolve(owner.id))!.id;
    expectStatus(await owner.browser.request('POST', '/api/v1/personal-assistant',
      { body: { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId, perRunCents: 50, dailyCapCents: 1_000 } }), 201);
    second = new Browser(api2Url, publicOrigin);
    for (const [name, value] of owner.browser.cookies) second.cookies.set(name, value);
    const connection = expect(await owner.browser.request('POST', '/api/v1/agent-connections',
      { body: { agentId, selectedProjectIds: [place.id], scopes: ['flux.context.read'] } }), 201);
    const clientId = `flux-test-${randomUUID()}`;
    const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
      response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
    accessToken = (await oauthToken(owner.browser, String(connection.id), clientId, redirectUri,
      await beginOauth(owner.browser, clientId, redirectUri, { scope: 'flux.context.read offline_access' }))).access_token;
    boss = new PgBoss({ connectionString });
    boss.on('error', () => undefined);
    await boss.start();
  });
  after(async () => { await ensureWorkspaceAiAllowed(ws.id); await boss?.stop({ graceful: false }).catch(() => undefined); });

  test('control: while AI is on, api2 serves the connection and a run started there reaches the provider through the worker', async () => {
    assert.ok(lists(await mcp(accessToken, 1, 'tools/list', {}, { base: api2Url })));
    const calls = await providerCalls();
    const started = expectStatus(await ask(second), 202) as { id: string };
    assert.match((await ended(started.id)).status, /completed|truncated/);
    assert.ok((await providerCalls()) > calls, 'the worker container called the mock provider');
  });

  test('turned off through api: api2 refuses the tool list and a new run at once; nothing reaches the provider', async () => {
    const calls = await providerCalls();
    await put('blocked');
    try {
      const listed = await mcp(accessToken, 2, 'tools/list', {}, { base: api2Url });
      assert.deepEqual([listed.status, errorCode(listed.message)], [200, 'WORKSPACE_AI_BLOCKED'], 'api2 has no stale copy of the policy');
      const asked = await ask(second);
      assert.deepEqual([asked.status, code(asked.json)], [403, 'WORKSPACE_AI_BLOCKED']);
      assert.equal(await providerCalls(), calls, 'no provider request');
    } finally { await put('allowed'); }
  });

  test('the worker container refuses to dispatch work admitted before AI was turned off, even after it is on again', async () => {
    const calls = await providerCalls();
    const stale = await runs.invoke({ kind: 'human', id: owner.id }, thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Old question' });
    await setWorkspaceAi(ws.id, 'blocked'); // a flip whose sweep never ran
    await setWorkspaceAi(ws.id, 'allowed');
    await boss.send(PERSONAL_RUN_JOB, { runId: stale.run.id });
    assert.deepEqual(await ended(stale.run.id), { status: 'stopped', end_reason: 'ai_off' });
    assert.equal(await providerCalls(), calls, 'negative control: zero provider requests');
    const fresh = await runs.invoke({ kind: 'human', id: owner.id }, thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'New question' });
    await boss.send(PERSONAL_RUN_JOB, { runId: fresh.run.id });
    assert.match((await ended(fresh.run.id)).status, /completed|truncated/);
    assert.ok((await providerCalls()) > calls, 'positive control: the same path reaches the provider');
  });
});
