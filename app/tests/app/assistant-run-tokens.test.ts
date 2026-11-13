import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  agentConnectionPath, ASSISTANT_RUN_EFFECT_TOOLS, assistantRunTools,
  personalRunTokenPath, RUN_TOKEN_LIMITS, type AgentMayDo, type Conversation, type Project, type Workspace,
} from '@flux/contracts';
import type { Principal } from '@flux/core';
import { personalRunTokenRows } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { agentSettings } from './support/agent-settings.js';
import { db, pool } from './support/db.js';
import { apiUrl, publicOrigin } from './support/http.js';
import { mcp } from './support/mcp.js';
import { addMember, expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';
import { waitFor } from './support/wait.js';

// F-027 A2 (#280) and A6 rest (#484): a personal run's MCP token, minted by the API (the authorization
// server) for the worker, and the agent (pi in the agent runtime) as an MCP client of the real `/mcp` route with it. The route
// lists exactly the run's switch-derived tools, reaches only the run's place, bounds tool results and
// refuses the token once the run ended, the connection was revoked or a switch turned off. Driven through
// the real use cases, worker processor, `/mcp` route and database; the agent that works a run is pi in the
// agent runtime (#1441, RT-1) on a scripted model gateway, which reaches the route with the run's token like
// any client. No model is called; none of this is a provider, billing or compatibility pass.

const connections = new FakeConnections();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
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
  let agentId: string; let docId: string; let otherDocId: string; let bigThreadId: string; let dmId: string;
  let pi: PiRuntime; let processor: ReturnType<PiRuntime['processor']>;
  const WIKI_CANARY = `wiki-canary-${randomBytes(4).toString('hex')}`;
  const OTHER_CANARY = `other-project-canary-${randomBytes(4).toString('hex')}`;
  const DM_CANARY = `dm-canary-${randomBytes(4).toString('hex')}`;
  const PRIVATE_CANARY = `private-sketch-canary-${randomBytes(4).toString('hex')}`;

  const settings = () => agentSettings(owner, ws.id);
  /** Ask me first (F-036 AG-3), set by the owner in their own session. */
  async function setMayDo(mayDo: AgentMayDo) {
    expectStatus(await owner.browser.request('PATCH', agentConnectionPath((await settings()).connectionId), { body: { mayDo } }), 200);
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
    pi = await startPiRuntime();
    processor = pi.processor(connections);
    owner = await person('rt-owner');
    ws = await createWorkspace(owner, 'Run tokens');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    other = await createProject(owner, ws.id, 'Other project', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    docId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Sensor notes', body: `The sensor is a PIR. ${WIKI_CANARY}` } }), 201) as { id: string }).id;
    // Ten long messages: a run that has almost used up its results reads past the bound on them (#484).
    bigThreadId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'long message. '.repeat(300), clientMessageId: randomUUID() } }), 201) as Conversation).id;
    for (let i = 1; i < 10; i += 1)
      expectStatus(await owner.browser.request('POST', `/api/v1/conversations/${bigThreadId}/messages`, { body: { body: 'long message. '.repeat(300), clientMessageId: randomUUID() } }), 201);
    otherDocId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${other.id}/docs`, { body: { title: 'Elsewhere', body: OTHER_CANARY } }), 201) as { id: string }).id;
    const privateMap = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: PRIVATE_CANARY, scope: 'private' } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', `/api/v1/sketches/${privateMap.id}/thoughts`, { body: { text: PRIVATE_CANARY, x: 0, y: 0 } }), 201);
    const peer = await person('rt-peer');
    await addMember(owner, ws.id, peer, 'member');
    const opened = await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [peer.id] } });
    assert.ok(opened.status === 201 || opened.status === 200, `open DM: ${opened.status}`);
    const dm = opened.json as { id: string };
    dmId = dm.id;
    expectStatus(await owner.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: DM_CANARY, clientMessageId: randomUUID() } }), 201);
    const connectionId = randomUUID();
    connections.connect(owner.id, connectionId);
    // Turning the assistant on creates its one `owner_assistant` connection and joins the projects the owner manages (A1).
    await runs.enable(human(owner), { agentId, connection: connectionId, model: 'claude-sonnet-5' });
    await pi.place(owner.id);
  });
  after(async () => { await pi.close(); });
  beforeEach(async () => {
    pi.gateway.script([]);
    await pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0
      WHERE owner_user_id = $1 AND status IN ('queued', 'reading', 'dispatching')`, [owner.id]);
    if ((await settings()).mayDo !== 'act') await setMayDo('act');
  });

  test('F-024: provider suspension refuses run-token minting and held run tokens without revoking the assistant', async () => {
    const runId = await inFlight();
    const suspend = () => pool.query(`INSERT INTO auth_idp_standing (user_id, provider_id, state, reason)
      VALUES ($1, 'oidc-standing-fixture', 'sign_in_required', 'invalid_grant')
      ON CONFLICT (user_id, provider_id) DO UPDATE SET state = 'sign_in_required'`, [owner.id]);
    const recover = () => pool.query(`DELETE FROM auth_idp_standing WHERE user_id = $1 AND provider_id = 'oidc-standing-fixture'`, [owner.id]);
    try {
      await suspend();
      assert.equal((await mint(runId)).status, 404, 'a real nonce cannot mint for a suspended owner');
      assert.equal((await row(runId)).run_token_jti, null);
      await recover();
      const grant = await token(runId);
      assert.equal((await mcp(grant.token, 1, 'tools/list')).status, 200);
      await suspend();
      // This stack is unmanaged: the universal connection gate refuses with 403. The managed
      // Keycloak lane separately proves the provider-labelled 401 for every bearer.
      assert.equal((await mcp(grant.token, 2, 'tools/list')).status, 403);
      await recover();
      assert.equal((await mcp(grant.token, 3, 'tools/list')).status, 200, 'the held token and connection recover');
    } finally { await recover(); await end(runId); }
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
    assert.deepEqual(signed.flux_place, { project: place.id, conversation: thread.id, dm: null });
    assert.equal(signed.aud, `${publicOrigin}/mcp`);
    assert.equal(signed.azp, 'flux-personal-run', 'the MCP resource server requires an authorized party (Better Auth 1.7.18)');
    assert.equal(signed.scope, undefined, 'no scope ceiling: what a run may call is its tool list (A3) and its owner\'s rights');
    assert.ok((signed.exp as number) - (signed.iat as number) <= RUN_TOKEN_LIMITS.lifetimeSeconds, 'no longer than the run\'s clock');
    assert.deepEqual(grant.tools, assistantRunTools(false));
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
    for (const absent of ['flux_bootstrap', 'flux_claim_unit', 'flux_transfer_unit', 'flux_create_proposal', 'flux_acknowledge_playbook']) assert.ok(!names.includes(absent), absent);
    assert.ok(names.includes('flux_create_unit'), 'the one hand-off tool, with its own private input (assistant-handoff.test.ts)');
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
    const effect = await mcp(grant.token, 6, 'tools/call', { name: 'flux_claim_unit', arguments: { projectId: place.id, clientCommandId: randomUUID() } });
    assert.equal(refusal(effect.message)?.code, 'MCP_ENTRY_UNAVAILABLE', 'a tool outside the run\'s list is refused before anything runs');
    await end(runId);
    assert.equal((await mcp(grant.token, 7, 'tools/call', { name: 'flux_list_contexts', arguments: {} })).status, 403, 'the token fails after the run ended');
  });

  test('#1165: a run\'s resource requests as the pinned Codex sends them (2025-06-18): no resources, no templates, any address not found, none declared', async () => {
    const runId = await inFlight();
    const grant = await token(runId);
    const legacy = { protocol: '2025-06-18' as const };
    const init = await mcp(grant.token, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.160.1' } }, legacy);
    assert.equal(init.status, 200);
    assert.deepEqual(Object.keys((init.message?.result as { capabilities: Record<string, unknown> }).capabilities), ['tools'],
      'a run declares no resources, so a client that reads capabilities offers no resource tool');
    for (const [id, params] of [[2, {}], [3, { cursor: 'next' }]] as const) {
      const listed = await mcp(grant.token, id, 'resources/list', params, legacy);
      assert.deepEqual([listed.status, listed.message], [200, { jsonrpc: '2.0', id, result: { resources: [] } }]);
    }
    const templates = await mcp(grant.token, 4, 'resources/templates/list', {}, legacy);
    assert.deepEqual([templates.status, templates.message], [200, { jsonrpc: '2.0', id: 4, result: { resourceTemplates: [] } }]);
    // Any address, whatever it names, is not found: the client's playbook, a file, a cloud metadata address, this run's own wiki page.
    const addresses = ['flux://playbook/flux.cowork/1.0.0', 'file:///etc/passwd', 'http://169.254.169.254/latest/meta-data/', `flux://projects/${place.id}/docs/${docId}`];
    for (const [index, uri] of addresses.entries()) {
      const read = await mcp(grant.token, 5 + index, 'resources/read', { uri }, legacy);
      assert.deepEqual([read.status, read.message], [200, { jsonrpc: '2.0', id: 5 + index, error: { code: -32002, message: 'Resource not found' } }], uri);
    }
    // A malformed request is the SDK's to answer, and the 2026-07-28 era is the SDK's: neither is a resource.
    const malformed = await mcp(grant.token, 10, 'resources/read', {}, legacy);
    assert.equal(malformed.message?.result, undefined);
    assert.equal((await mcp(grant.token, 11, 'resources/list')).message?.result, undefined);
    // The run's tools still work after them.
    const contexts = await mcp(grant.token, 12, 'tools/call', { name: 'flux_list_contexts', arguments: {} }, legacy);
    assert.ok(toolText(contexts.message).includes(place.id));
    await end(runId);
    assert.equal((await mcp(grant.token, 13, 'resources/list', {}, legacy)).status, 403, 'nothing, not even an empty list, once the run ended');
  });

  test('Ask me first gets the same tools, whose changes wait (#1419), and the token reads the place', async () => {
    await setMayDo('ask');
    const runId = await inFlight();
    const grant = await token(runId);
    assert.deepEqual(grant.tools, assistantRunTools(false), 'Ask me first makes a change wait; it hides no tool');
    await setMayDo('act');
    const contexts = await mcp(grant.token, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
    assert.equal(contexts.status, 200);
    assert.ok(toolText(contexts.message).includes(place.id));
    await end(runId);
  });

  test('a tool result past the route\'s bound is not returned and the run ends in its own state', async () => {
    pi.gateway.script([{ tool: 'mcp__flux__flux_get_conversation', args: { projectId: place.id, id: bigThreadId } }, { text: 'done' }]);
    const started = await ask();
    // A safety bound (#843): this run starts close to it instead of reading 8 MiB.
    await pool.query('UPDATE personal_runs SET mcp_result_bytes = $1 WHERE id = $2', [RUN_TOKEN_LIMITS.resultBytesPerRun - 1024, started.run.id]);
    assert.equal(await processor.process(started.run.id), 'cap_reached', JSON.stringify(pi.lastPi()));
    const stored = await row(started.run.id);
    assert.deepEqual([stored.status, stored.end_reason, stored.mcp_limit, stored.answer_body], ['cap_reached', 'mcp_results_too_large', 'run', null]);
    assert.ok(!JSON.stringify(pi.gateway.requests).includes('long message. long message. long message.'), 'the oversized result never reached the provider');
  });

  test('#484: a run\'s flux_get_doc on a 50,000-character doc returns a first page under 16 KiB with a next-page cursor, and the run does not end', async () => {
    const body = 'log line. '.repeat(5_000);
    const longDocId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Long log', body } }), 201) as { id: string }).id;
    const runId = await inFlight();
    const grant = await token(runId);
    const readPage = (id: number, args: Record<string, unknown>) => mcp(grant.token, id, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: place.id, id: longDocId, ...args } });
    const first = await readPage(1, {});
    assert.equal((first.message?.result as { isError?: boolean } | undefined)?.isError, undefined, 'the first page is returned, not refused');
    const content = (first.message?.result as { content: unknown[] }).content;
    assert.ok(Buffer.byteLength(JSON.stringify(content), 'utf8') < 16 * 1024, 'the first page fits one tool result');
    const page = JSON.parse((content[0] as { text: string }).text) as { body: string; totalLength: number; nextOffset: number | null; version: number };
    assert.equal(page.totalLength, 50_000);
    assert.equal(page.nextOffset, page.body.length, 'a next-page cursor continues where the first page ended');
    const second = await readPage(2, { offset: page.nextOffset, version: page.version });
    const next = JSON.parse(((second.message?.result as { content: { text: string }[] }).content[0]!).text) as { body: string; offset: number };
    assert.equal(next.offset, page.nextOffset);
    assert.equal(page.body + next.body, body.slice(0, page.body.length + next.body.length), 'pages join without gaps');
    assert.equal((await mcp(grant.token, 3, 'tools/call', { name: 'flux_list_contexts', arguments: {} })).status, 200, 'the run still reads after paging');
    await end(runId);
  });

  test('revoking the assistant connection mid-run makes the next MCP call fail with 403 and ends the run', async () => {
    const restore = async () => {
      // Turning the assistant on again revives the same connection and switches (A1).
      await runs.remove(human(owner)).catch(() => undefined);
      agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada assistant', owner: 'self' } }), 201) as { id: string }).id;
      const connectionId = randomUUID();
      connections.connect(owner.id, connectionId);
      await runs.enable(human(owner), { agentId, connection: connectionId, model: 'claude-sonnet-5' });
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
    // The worker: a revocation while pi works ends the run `revoked` at once, and nothing more is sent to the model.
    pi.gateway.script([{ tool: 'bash', args: { command: 'sleep 20' } }, { text: 'Should not be posted.' }]);
    const started = await ask();
    const working = processor.process(started.run.id);
    await waitFor(async () => pi.gateway.requests.length > 0, 'pi to ask its model');
    await new Promise((wait) => setTimeout(wait, 300));
    await revoke();
    assert.equal(await working, 'revoked', JSON.stringify(pi.lastPi()));
    assert.equal(pi.gateway.requests.length, 1, 'nothing more is sent after the revocation');
    const stored = await row(started.run.id);
    assert.equal(stored.answer_body, null);
    assert.ok(stored.run_token_closed_at, 'the token is closed');
    await restore();
  });

  /** One step of the run's model: it calls a Flux tool (pi names them `mcp__flux__<tool>`). */
  const call = (name: string, args: Record<string, unknown>) => ({ tool: `mcp__flux__${name}`, args });
  /**
   * The Flux tools a run's model request offers pi (its own `bash`, `read`, `edit` and `write` left out), without pi's prefix, sorted. Flux's web
   * search, which the run token adds for pi where the API has one (#1441), is not one of the assistant's tools and is left out.
   */
  const offered = (request: { tools: string[] }) => request.tools.filter((name) => name.startsWith('mcp__flux__')).map((name) => name.slice('mcp__flux__'.length))
    .filter((name) => name !== 'flux_web_search').sort();
  /** What the run's tools returned, in the order they were called: the last request of the run carries them all. */
  const results = () => pi.gateway.requests.at(-1)?.results ?? [];

  test('AST-9.1: a DM, a private map and another project never reach the provider or the tool results', async () => {
    pi.gateway.script([call('flux_search', { q: 'canary', kind: 'message' }), call('flux_search', { q: 'canary' }), call('flux_list_maps', { projectId: place.id }),
      call('flux_get_doc', { projectId: other.id, id: otherDocId }), call('flux_list_contexts', {}), { text: 'Fact: nothing private here.' }]);
    const started = await ask('Summarize the canary');
    assert.equal(await processor.process(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.equal(pi.gateway.requests.length, 6, 'every step of the model was one request');
    const sent = JSON.stringify(pi.gateway.requests);
    for (const canary of [DM_CANARY, PRIVATE_CANARY, OTHER_CANARY]) assert.ok(!sent.includes(canary), `${canary} never reaches the provider`);
    assert.ok(pi.gateway.requests[0]!.prompt.includes('Summarize the canary'), 'the owner\'s request is input');
    const stored = await row(started.run.id);
    assert.ok(stored.run_token_closed_at, 'the session closed the token');
  });

  test('#842 (C-37): the tools of a run follow its place: a DM run has one and reaches no space, a chat reads like its owner and changes nothing, the main conversation reaches its own space', async () => {
    const asked = async (place: Parameters<typeof runs.invoke>[1], steps: Parameters<PiRuntime['gateway']['script']>[0]) => {
      const started = await runs.invoke(human(owner), place, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Summarise what you can' });
      pi.gateway.script(steps);
      assert.equal(await processor.process(started.run.id), 'completed', `${JSON.stringify(place)}: ${JSON.stringify(pi.lastPi())}`);
      return started.run.id;
    };
    // A direct message: it reads a web page and finds, reads around and summarises the messages of that DM and of nothing else (F-042, #1290,
    // #1292); the DM itself is given in the request, and no space is reachable.
    const inDm = await asked({ kind: 'dm', dmId, threadRootId: null }, [call('flux_search', { q: 'canary' }), { text: 'Fact: done.' }]);
    assert.deepEqual(offered(pi.gateway.requests[0]!), ['flux_read_around', 'flux_read_web', 'flux_search', 'flux_summarize']);
    assert.match(pi.gateway.requests[0]!.prompt, new RegExp(DM_CANARY), 'the DM is what the model reads');
    assert.ok((results()[0] ?? '').includes(`/dm/${dmId}#message-`), 'it finds the message of its DM');
    assert.ok(!(results()[0] ?? '').includes('/projects/'), 'and nothing of a space, though the Wiki says "canary" too');
    for (const canary of [WIKI_CANARY, OTHER_CANARY, PRIVATE_CANARY]) assert.ok(!JSON.stringify(pi.gateway.requests).includes(canary), `${canary} never reaches the provider`);
    const dmToken = await pool.query('SELECT run_tools FROM personal_runs WHERE id = $1', [inDm]);
    assert.deepEqual((dmToken.rows[0].run_tools as string[]).filter((name) => name !== 'flux_web_search'), ['flux_read_around', 'flux_read_web', 'flux_search', 'flux_summarize']);
    // A call of any other tool is refused by the route (pi itself stops a run that asks for a tool it was not given: agent-runtime-pi.test.ts).
    const dmRun = await runs.invoke(human(owner), { kind: 'dm', dmId, threadRootId: null }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' });
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [dmRun.run.id]);
    const dmHeld = await token(dmRun.run.id);
    for (const [name, args] of [['flux_get_doc', { projectId: place.id, id: docId }], ['flux_list_contexts', {}]] as const)
      assert.equal(refusal((await mcp(dmHeld.token, 1, 'tools/call', { name, arguments: args })).message)?.code, 'MCP_ENTRY_UNAVAILABLE', name);
    await end(dmRun.run.id);

    // A chat: every read tool, in every space its owner reaches, a picture for its own answer, and no tool that changes anything.
    const inChat = await asked({ kind: 'chat', agentId }, [call('flux_get_doc', { projectId: other.id, id: otherDocId }), call('flux_list_contexts', {}), { text: 'Fact: done.' }]);
    const names = offered(pi.gateway.requests[0]!);
    const chatTools = (await pool.query('SELECT run_tools FROM personal_runs WHERE id = $1', [inChat])).rows[0].run_tools as string[];
    assert.deepEqual(names, chatTools.filter((name) => name !== 'flux_web_search').sort(), 'pi was offered exactly the tools the run token was minted for');
    assert.equal(names.length, 24, 'the 22 read tools (flux_view_image, #1217; flux_search and flux_read_around, #1290; flux_summarize, #1292; flux_read_file, #1382), a picture and a file for its answer (flux_attach_image, #1217; flux_attach_file, #1437)');
    assert.ok(names.includes('flux_attach_image') && names.includes('flux_attach_file'), 'its answer in the chat can carry a picture (founder decision on #1217) and a file (coordinator decision on #1437)');
    assert.ok(ASSISTANT_RUN_EFFECT_TOOLS.filter((tool) => tool !== 'flux_attach_image' && tool !== 'flux_attach_file').every((tool) => !names.includes(tool)), 'no tool that changes anything');
    assert.ok(JSON.stringify(pi.gateway.requests).includes(OTHER_CANARY), 'another space of its owner is read: nobody else reads this answer');
    // It can find its owner's spaces itself, with no id given to it (the list of what a run reaches follows its place, not a project it has none of).
    assert.ok((results()[1] ?? '').includes(place.id) && (results()[1] ?? '').includes(other.id), 'flux_list_contexts lists the spaces of its owner');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'From the chat'`)).rows[0].n, 0);
    const armed = await runs.invoke(human(owner), { kind: 'chat', agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'x' });
    await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [armed.run.id]);
    const armedToken = await token(armed.run.id);
    assert.deepEqual(claims(armedToken.token).flux_place, { project: null, conversation: null, dm: null });
    // The call to change something is refused by the route.
    assert.equal(refusal((await mcp(armedToken.token, 1, 'tools/call', { name: 'flux_create_task', arguments: { projectId: place.id, title: 'From the chat', clientCommandId: randomUUID() } })).message)?.code,
      'MCP_ENTRY_UNAVAILABLE');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_work_items WHERE title = 'From the chat'`)).rows[0].n, 0);
    await end(armed.run.id);

    // The space's main conversation: its own space and no other, with every switch on: the 22 read tools and every change tool (A3).
    const quiet = await createProject(owner, ws.id, 'Quiet corner', 'workspace');
    const QUIET = `quiet-canary-${randomBytes(4).toString('hex')}`;
    const quietDoc = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${quiet.id}/docs`, { body: { title: 'Quiet notes', body: QUIET } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${quiet.id}/conversations`, { body: { body: 'Short hello', clientMessageId: randomUUID() } }), 201);
    await asked({ kind: 'space', projectId: quiet.id, conversationId: null }, [call('flux_get_doc', { projectId: other.id, id: otherDocId }), call('flux_get_doc', { projectId: quiet.id, id: quietDoc }), { text: 'Fact: done.' }]);
    assert.equal(offered(pi.gateway.requests[0]!).length, 22 + ASSISTANT_RUN_EFFECT_TOOLS.length,
      '22 read tools (flux_read_web, #918; flux_view_image, #1217; flux_search and flux_read_around, #1290; flux_summarize, #1292; flux_read_file, #1382) and every change tool (A3)');
    assert.ok(JSON.stringify(pi.gateway.requests).includes(QUIET), 'its own space is read');
    assert.ok(!JSON.stringify(pi.gateway.requests).includes(OTHER_CANARY), 'another space of its owner is not');
  });
});
