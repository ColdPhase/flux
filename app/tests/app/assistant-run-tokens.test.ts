import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import {
  assistantRunTools, assistantSettingsPath, compileAssistantAreas, DEFAULT_ASSISTANT_AREAS, PERSONAL_RUN_CONSENT_VERSION, PERSONAL_RUN_LIMITS,
  personalRunTokenPath, RUN_TOKEN_LIMITS, type AssistantSettings, type Conversation, type Project, type Workspace,
} from '@flux/contracts';
import { createPersonalRunProcessor, type PersonalComputeResult, type PersonalToolCall, type Principal } from '@flux/core';
import { personalRunTokenRows } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { mcpToolHost } from '../../apps/worker/src/personal-runs/mcp-session.js';
import { runTokenIssuer } from '../../apps/worker/src/personal-runs/run-tokens.js';
import { db, pool } from './support/db.js';
import { apiUrl, publicOrigin } from './support/http.js';
import { mcp } from './support/mcp.js';
import { addMember, expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeCompute, FakeConnections, FakeQueue } from './support/personal-runs.js';

// F-027 A2 (#280) and A6 rest (#484): a personal run's MCP token, minted by the API (the authorization
// server) for the worker, and the worker as an MCP client of the real `/mcp` route with it. The route
// lists exactly the run's switch-derived tools, reaches only the run's place, bounds tool results and
// refuses the token once the run ended, the connection was revoked or a switch turned off. Driven through
// the real use cases, worker processor, `/mcp` route and database with a FAKE provider. No model is
// called; none of this is a provider, billing or compatibility pass.

const connections = new FakeConnections();
const compute = new FakeCompute();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true, toolTurns: PERSONAL_RUN_LIMITS.maxTurns });
const tokens = runTokenIssuer(db, apiUrl);
const processor = createPersonalRunProcessor({ uow: personalRunWorkerUnitOfWork(db), connections, compute, stopPollMs: 20,
  tools: mcpToolHost(tokens, `${apiUrl}/mcp`), tokens });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
const toolText = (message: Record<string, unknown> | null) => JSON.stringify(message);
const refusal = (message: Record<string, unknown> | null) => {
  const result = message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  return result?.isError === true ? JSON.parse(result.content?.[0]?.text ?? '{}') as { code?: string } : null;
};

async function row(runId: string) {
  return (await pool.query(`SELECT status, end_reason, answer_body, run_token_jti, run_token_closed_at, run_tools, mcp_result_bytes, mcp_limit, stopped_at_stage
    FROM personal_runs WHERE id = $1`, [runId])).rows[0] as { status: string; end_reason: string | null; answer_body: string | null; run_token_jti: string | null;
    run_token_closed_at: Date | null; run_tools: string[]; mcp_result_bytes: number; mcp_limit: string | null; stopped_at_stage: string | null };
}

describe('the run token and the worker as an MCP client of /mcp (F-027 A2, A6; #280, #484)', () => {
  let owner: Person; let ws: Workspace; let place: Project; let other: Project; let thread: Conversation;
  let agentId: string; let docId: string; let otherDocId: string; let bigDocId: string;
  const WIKI_CANARY = `wiki-canary-${randomBytes(4).toString('hex')}`;
  const OTHER_CANARY = `other-project-canary-${randomBytes(4).toString('hex')}`;
  const DM_CANARY = `dm-canary-${randomBytes(4).toString('hex')}`;
  const PRIVATE_CANARY = `private-sketch-canary-${randomBytes(4).toString('hex')}`;

  const settings = async () => expectStatus(await owner.browser.request('GET', assistantSettingsPath(ws.id, owner.id)), 200) as unknown as AssistantSettings;
  async function setWiki(mode: 'off' | 'read' | 'edit') {
    const current = await settings();
    expectStatus(await owner.browser.request('PATCH', assistantSettingsPath(ws.id, owner.id), { body: { areas: { wiki: mode } }, headers: { 'if-match': `"${current.version}"` } }), 200);
  }
  const ask = (prompt = 'What does the wiki say?') => runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt });
  /** A run moved to `reading` (as the worker's claim does) and armed with a nonce, ready to mint. */
  async function inFlight(prompt?: string) {
    const started = await ask(prompt);
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [started.run.id]);
    return started.run.id;
  }
  async function mint(runId: string) {
    const nonce = randomBytes(32).toString('hex');
    assert.equal(await db.transaction((tx) => personalRunTokenRows(tx).arm(runId, sha256(nonce))), true);
    return fetch(`${apiUrl}${personalRunTokenPath(runId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  }
  async function token(runId: string) {
    const response = await mint(runId);
    assert.equal(response.status, 200);
    return await response.json() as { token: string; tools: string[]; expiresAt: string };
  }
  const end = (runId: string) => pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [runId]);

  before(async () => {
    owner = await person('rt-owner');
    ws = await createWorkspace(owner, 'Run tokens');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    other = await createProject(owner, ws.id, 'Other project', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    docId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Sensor notes', body: `The sensor is a PIR. ${WIKI_CANARY}` } }), 201) as { id: string }).id;
    bigDocId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Big log', body: 'log line. '.repeat(2_000) } }), 201) as { id: string }).id;
    otherDocId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${other.id}/docs`, { body: { title: 'Elsewhere', body: OTHER_CANARY } }), 201) as { id: string }).id;
    const privateMap = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: PRIVATE_CANARY, scope: 'private' } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', `/api/v1/sketches/${privateMap.id}/thoughts`, { body: { text: PRIVATE_CANARY, x: 0, y: 0 } }), 201);
    const peer = await person('rt-peer');
    await addMember(owner, ws.id, peer, 'member');
    const opened = await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [peer.id] } });
    assert.ok(opened.status === 201 || opened.status === 200, `open DM: ${opened.status}`);
    const dm = opened.json as { id: string };
    expectStatus(await owner.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: DM_CANARY, clientMessageId: randomUUID() } }), 201);
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    // Turning the assistant on creates its one `owner_assistant` connection and joins the projects the owner manages (A1).
    await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId, perRunCents: 50, dailyCapCents: 1_000 });
  });
  beforeEach(async () => {
    compute.dispatched = []; compute.counted = [];
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    await setWiki('edit');
  });

  test('the API mints one token per in-flight run, only for the nonce the worker armed; it is never stored', async () => {
    const runId = await inFlight();
    const nonce = randomBytes(32).toString('hex');
    await db.transaction((tx) => personalRunTokenRows(tx).arm(runId, sha256(nonce)));
    const post = (body: unknown) => fetch(`${apiUrl}${personalRunTokenPath(runId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ nonce: randomBytes(32).toString('hex') })).status, 404, 'another nonce is refused');
    const granted = await post({ nonce });
    assert.equal(granted.status, 200);
    const grant = await granted.json() as { token: string; tools: string[]; expiresAt: string };
    assert.equal((await post({ nonce })).status, 404, 'a token is minted once');
    const signed = claims(grant.token);
    const assistant = await settings();
    assert.equal(signed.sub, owner.id); assert.equal(signed.flux_owner_user_id, owner.id);
    assert.equal(signed.flux_connection_id, assistant.connectionId, 'the run uses the assistant\'s one owner_assistant connection');
    assert.equal(signed.flux_run_id, runId);
    assert.deepEqual(signed.flux_place, { project: place.id, conversation: thread.id });
    assert.equal(signed.aud, `${publicOrigin}/mcp`);
    assert.equal(signed.scope, 'flux.context.read', 'read tools only in #280\'s first delivery step');
    assert.ok((signed.exp as number) - (signed.iat as number) <= RUN_TOKEN_LIMITS.lifetimeSeconds, 'no longer than the run\'s clock');
    assert.deepEqual(grant.tools, assistantRunTools(compileAssistantAreas(DEFAULT_ASSISTANT_AREAS), ['flux.context.read']));
    const stored = await pool.query(`SELECT row_to_json(r)::text AS text FROM personal_runs r WHERE id = $1`, [runId]);
    assert.ok(!stored.rows[0].text.includes(grant.token) && !stored.rows[0].text.includes(grant.token.split('.')[2]!), 'the token is never stored');
    assert.ok(!stored.rows[0].text.includes(nonce), 'nor is the nonce');
    await end(runId);
    // A run that is not in flight gets nothing, whatever nonce it holds.
    const queued = (await ask()).run.id;
    const queuedNonce = randomBytes(32).toString('hex');
    assert.equal(await db.transaction((tx) => personalRunTokenRows(tx).arm(queued, sha256(queuedNonce))), false, 'a queued run cannot be armed');
    assert.equal((await post({ nonce: queuedNonce })).status, 404);
    await end(queued);
    assert.equal(await db.transaction((tx) => personalRunTokenRows(tx).arm(runId, sha256(queuedNonce))), false, 'an ended run cannot be armed');
  });

  test('the route lists exactly the run\'s switch-derived tools and reaches only the run\'s place; the token fails once the run ends', async () => {
    const runId = await inFlight();
    const grant = await token(runId);
    const listed = await mcp(grant.token, 1, 'tools/list');
    assert.equal(listed.status, 200);
    const names = ((listed.message?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name).sort();
    assert.deepEqual(names, grant.tools, 'exactly the minted list');
    for (const absent of ['flux_bootstrap', 'flux_create_task', 'flux_claim_unit', 'flux_create_proposal', 'flux_acknowledge_playbook']) assert.ok(!names.includes(absent), absent);
    const templates = await mcp(grant.token, 2, 'resources/templates/list');
    assert.ok(templates.message?.error || !((templates.message?.result as { resourceTemplates?: unknown[] } | undefined)?.resourceTemplates?.length), 'no resource is offered to a run');
    const contexts = await mcp(grant.token, 3, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
    assert.deepEqual((JSON.parse((contexts.message?.result as { content: { text: string }[] }).content[0]!.text) as { projects: { id: string }[] }).projects.map((p) => p.id), [place.id],
      'the run\'s place only, though the assistant also joined the other project');
    const elsewhere = await mcp(grant.token, 4, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: other.id, id: otherDocId } });
    assert.ok(refusal(elsewhere.message), 'another project is refused');
    assert.ok(!toolText(elsewhere.message).includes(OTHER_CANARY));
    const here = await mcp(grant.token, 5, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: place.id, id: docId } });
    assert.ok(toolText(here.message).includes(WIKI_CANARY), 'the place\'s wiki is readable while Wiki is on');
    const effect = await mcp(grant.token, 6, 'tools/call', { name: 'flux_create_task', arguments: { projectId: place.id, title: 'Sneaky', clientCommandId: randomUUID() } });
    assert.equal(refusal(effect.message)?.code, 'MCP_ENTRY_UNAVAILABLE', 'a tool outside the run\'s list is refused before anything runs');
    await end(runId);
    assert.equal((await mcp(grant.token, 7, 'tools/call', { name: 'flux_list_contexts', arguments: {} })).status, 403, 'the token fails after the run ended');
  });

  test('an assistant a manager let only read gets a read-only run token that reads the place', async () => {
    const grants = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${place.id}/grants`), 200) as { id: string; principal: { kind: string; id: string }; role: string }[];
    const joined = grants.find((g) => g.principal.kind === 'agent' && g.principal.id === agentId)!;
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${place.id}/grants/${joined.id}`), 204);
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'viewer' } }), 201);
    try {
      const runId = await inFlight();
      const grant = await token(runId);
      const contexts = await mcp(grant.token, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
      assert.equal(contexts.status, 200);
      assert.ok(toolText(contexts.message).includes(place.id));
      await end(runId);
    } finally {
      const now = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${place.id}/grants`), 200) as { id: string; principal: { kind: string; id: string } }[];
      const viewer = now.find((g) => g.principal.kind === 'agent' && g.principal.id === agentId)!;
      expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${place.id}/grants/${viewer.id}`), 204);
      expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    }
  });

  test('AST-4.2 (read part): with the Wiki off the run lists no Wiki tool, flux_get_doc gets the S6 refusal and untyped search is refused', async () => {
    await setWiki('off');
    const runId = await inFlight();
    const grant = await token(runId);
    for (const wiki of ['flux_get_doc', 'flux_list_docs', 'flux_list_materials', 'flux_read_material']) assert.ok(!grant.tools.includes(wiki), wiki);
    const names = (((await mcp(grant.token, 1, 'tools/list')).message?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);
    assert.ok(!names.some((name) => ['flux_get_doc', 'flux_list_docs', 'flux_list_materials', 'flux_read_material'].includes(name)), 'no Wiki tool is listed');
    const doc = await mcp(grant.token, 2, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: place.id, id: docId } });
    assert.equal(refusal(doc.message)?.code, 'MCP_ENTRY_UNAVAILABLE', 'the S6 refusal');
    assert.ok(!toolText(doc.message).includes(WIKI_CANARY));
    const search = await mcp(grant.token, 3, 'tools/call', { name: 'flux_search_project', arguments: { projectId: place.id, q: 'sensor' } });
    assert.ok(refusal(search.message) || search.status === 403, 'untyped search could return Wiki text, so it is refused');
    assert.ok(!toolText(search.message).includes(WIKI_CANARY));
    await end(runId);
  });

  test('AST-4.4: turning the Wiki off during a run refuses its next Wiki read with the run\'s existing token', async () => {
    const runId = await inFlight();
    const grant = await token(runId);
    assert.ok(toolText((await mcp(grant.token, 1, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: place.id, id: docId } })).message).includes(WIKI_CANARY));
    await setWiki('off');
    const again = await mcp(grant.token, 2, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: place.id, id: docId } });
    assert.equal(refusal(again.message)?.code, 'MCP_ENTRY_UNAVAILABLE');
    assert.ok(!toolText(again.message).includes(WIKI_CANARY));
    const names = (((await mcp(grant.token, 3, 'tools/list')).message?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);
    assert.ok(!names.includes('flux_get_doc'), 'Off means off: the next listing drops the Wiki tools too');
    await end(runId);
  });

  test('a tool result over 16 KiB is not returned and the run ends in its own state', async () => {
    const replies: PersonalComputeResult[] = [
      { kind: 'completed', text: 'reading', stopReason: 'tool_use', usage: { inputTokens: 500, outputTokens: 20 },
        toolCalls: [{ id: 'c1', name: 'flux_get_doc', input: { projectId: place.id, id: bigDocId } }] },
      { kind: 'completed', text: 'done', stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 20 } },
    ];
    compute.respond = async () => replies.shift()!;
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'cap_reached');
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.end_reason, stored.mcp_limit, stored.answer_body], ['cap_reached', 'mcp_results_too_large', 'call', null]);
    const second = compute.dispatched.at(-1)!;
    assert.ok(!JSON.stringify(second.turns ?? []).includes('log line. log line. log line.'), 'the oversized result never reached the provider');
  });

  test('revoking the assistant connection mid-run makes the next MCP call fail with 403 and ends the run', async () => {
    const restore = async () => {
      // Turning the assistant on again revives the same connection and switches (A1).
      await runs.remove(human(owner)).catch(() => undefined);
      const connectionId = randomUUID();
      connections.connect(owner.id, connectionId);
      await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId, perRunCents: 50, dailyCapCents: 1_000 });
    };
    const revoke = async () => {
      const assistant = await settings();
      expectStatus(await owner.browser.request('DELETE', `/api/v1/agent-connections/${assistant.connectionId}`), 204);
    };
    // The route: the run's own token, still in flight, gets 403 on its next call.
    const runId = await inFlight();
    const grant = await token(runId);
    assert.equal((await mcp(grant.token, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} })).status, 200);
    await revoke();
    assert.equal((await mcp(grant.token, 2, 'tools/call', { name: 'flux_list_contexts', arguments: {} })).status, 403);
    await end(runId);
    await restore();
    // The worker: a revocation between two turns ends the run `revoked` before another call or request.
    compute.respond = async () => {
      if (compute.dispatched.length === 2) await revoke();
      return { kind: 'completed', text: 'again', stopReason: 'tool_use', usage: { inputTokens: 500, outputTokens: 20 },
        toolCalls: [{ id: `c${compute.dispatched.length}`, name: 'flux_list_contexts', input: {} }] };
    };
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'revoked');
    assert.equal(compute.dispatched.length, 2, 'nothing more is sent after the revocation');
    const stored = await row(started.run.id);
    assert.equal(stored.answer_body, null);
    assert.ok(stored.run_token_closed_at, 'the token is closed');
    await restore();
  });

  test('AST-9.1 and AST-4.2 (server part): a DM, a private map and another project never reach the provider or the tool results; with the Wiki off no Wiki text is sent', async () => {
    const calls: PersonalToolCall[] = [
      { id: 's1', name: 'flux_search_project', input: { projectId: place.id, q: 'canary', type: 'message' } },
      { id: 's2', name: 'flux_list_maps', input: { projectId: place.id } },
      { id: 's3', name: 'flux_get_doc', input: { projectId: other.id, id: otherDocId } },
      { id: 's4', name: 'flux_list_contexts', input: {} },
    ];
    compute.respond = async () => compute.dispatched.length === 1
      ? { kind: 'completed', text: 'looking', stopReason: 'tool_use', usage: { inputTokens: 800, outputTokens: 40 }, toolCalls: calls }
      : { kind: 'completed', text: 'Fact: nothing private here [S1].', stopReason: 'end_turn', usage: { inputTokens: 800, outputTokens: 40 } };
    await setWiki('off');
    const started = await ask('Summarize the canary');
    assert.equal(await processor.process(started.run.id), 'completed');
    const sent = JSON.stringify(compute.dispatched);
    for (const canary of [DM_CANARY, PRIVATE_CANARY, OTHER_CANARY, WIKI_CANARY]) assert.ok(!sent.includes(canary), `${canary} never reaches the provider`);
    assert.ok(!(compute.dispatched[0]!.tools ?? []).some((tool) => tool.name === 'flux_get_doc'), 'no Wiki tool on the wire');
    assert.ok(compute.dispatched[0]!.input.includes('Summarize the canary'), 'the owner\'s request is input');
    const stored = await row(started.run.id);
    assert.ok(stored.run_token_closed_at, 'the session closed the token');
  });

  test('AST-8.2 through /mcp: a provider that keeps calling tools stops at the turn cap, every call made through the route', async (t) => {
    // Measured, not asserted: with every switch on, how many turns fit the per-request input bound.
    compute.respond = async () => ({ kind: 'completed', text: 'again', stopReason: 'tool_use', usage: { inputTokens: 500, outputTokens: 20 },
      toolCalls: [{ id: `c${compute.dispatched.length}`, name: 'flux_list_contexts', input: {} }] });
    const full = await ask();
    const fullOutcome = await processor.process(full.run.id);
    t.diagnostic(`all switches on: ${fullOutcome} after ${compute.dispatched.length} requests; ${JSON.stringify(compute.dispatched[0]?.tools ?? []).length} bytes of tool definitions, `
      + `${compute.dispatched[0]?.tools?.length ?? 0} tools`);
    compute.dispatched = [];
    // Only the always-on project tools: each request carries the run's tool definitions, and the per-request
    // input bound (16,000 at one token per byte, PROV-3) leaves room for ten turns only with a short list.
    const current = await settings();
    expectStatus(await owner.browser.request('PATCH', assistantSettingsPath(ws.id, owner.id), { body: { areas: { tasks: 'off', wiki: 'off', maps: 'off', conversations: 'off', decisions: 'off' } },
      headers: { 'if-match': `"${current.version}"` } }), 200);
    compute.respond = async () => ({ kind: 'completed', text: 'again', stopReason: 'tool_use', usage: { inputTokens: 500, outputTokens: 20 },
      toolCalls: [{ id: `c${compute.dispatched.length}`, name: 'flux_list_contexts', input: {} }] });
    const started = await ask();
    const outcome = await processor.process(started.run.id);
    const sizes = compute.dispatched.map((request) => JSON.stringify(request.tools ?? []).length);
    const restored = await settings();
    expectStatus(await owner.browser.request('PATCH', assistantSettingsPath(ws.id, owner.id), { body: { areas: { tasks: 'edit', maps: 'edit', conversations: 'edit', decisions: 'edit' } },
      headers: { 'if-match': `"${restored.version}"` } }), 200);
    assert.equal(outcome, 'cap_reached');
    assert.equal(compute.dispatched.length, PERSONAL_RUN_LIMITS.maxTurns, `tool definitions on the wire: ${sizes.join(', ')} bytes`);
    const last = compute.dispatched.at(-1)!;
    assert.equal(last.turns!.length, PERSONAL_RUN_LIMITS.maxTurns - 1);
    assert.ok(last.turns!.every((turn) => turn.results[0]!.isError === false && turn.results[0]!.content.includes(place.id)), 'each call was answered by the real route');
  });

  test('AST-8.3: a model marked without tool calling gets one request with no tools and no token', async () => {
    const connectionId = randomUUID();
    await runs.remove(human(owner));
    connections.connect(owner.id, connectionId, { toolCalling: false });
    await runs.enable(human(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId, perRunCents: 50, dailyCapCents: 1_000 });
    compute.respond = async () => ({ kind: 'completed', text: 'Fact: one answer [S1].', stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 20 } });
    const started = await ask();
    assert.equal(await processor.process(started.run.id), 'completed');
    assert.equal(compute.dispatched.length, 1);
    assert.equal(compute.dispatched[0]!.tools, undefined);
    assert.equal((await row(started.run.id)).run_token_jti, null, 'no run token was minted');
  });
});
