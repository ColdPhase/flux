import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentMcpPolicyPath, type AgentMcpPolicy, type SaveAgentMcpPolicy } from '@flux/contracts';
import { coworkPlaybookReference, coworkPlaybookUri } from '@flux/core';
import { pool } from './support/db.js';
import { Browser, publicOrigin, register, uniqueEmail } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken, toolValue } from './support/mcp.js';

// Genuine OAuth/PKCE, old bearer, HTTP entry points and saved owner policy. These
// are admission tests; they do not prove held transport writes or action replay.
async function connected() {
  const { browser: owner } = await register(uniqueEmail('mcp-switch-dispatch'), 'correct horse battery staple');
  const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Switch tests' } }), 201);
  const agent = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/agents`,
    { body: { name: 'Owned external agent', owner: 'self' } }), 201);
  const projects: string[] = []; const grants: string[] = [];
  for (const name of ['Allowed project', 'Excluded project']) {
    const project = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
      { body: { name, visibility: 'restricted' } }), 201);
    const access = expect(await owner.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    projects.push(String(project.id)); grants.push(String(access.id));
  }
  const projectId = projects[0]!;
  const doc = expect(await owner.request('POST', `/api/v1/projects/${projectId}/docs`,
    { body: { title: 'Hidden knowledge reference', body: 'Knowledge-secret-78419' } }), 201);
  const material = expect(await owner.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { title: 'Hidden original material', body: 'Material-secret-32917', clientMutationId: randomUUID() } }), 201);
  const work = expect(await owner.request('POST', `/api/v1/projects/${projectId}/work`,
    { body: { title: 'Evidence pending review', outcome: 'Check the observation' } }), 201);
  const scopes = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];
  const connection = expect(await owner.request('POST', '/api/v1/agent-connections',
    { body: { agentId: agent.id, selectedProjectIds: projects, scopes } }), 201);
  const connectionId = String(connection.id);
  const clientId = `flux-test-${randomUUID()}`; const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], [...scopes, 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const token = (await oauthToken(owner, connectionId, clientId, redirectUri,
    await beginOauth(owner, clientId, redirectUri, { scope: `${scopes.join(' ')} offline_access` }))).access_token;
  const path = agentMcpPolicyPath(connectionId);
  const get = async () => (expect(await owner.request('GET', path), 200) as { policy: AgentMcpPolicy }).policy;
  const initial = await get(); let saved = initial;
  const save = async (input: SaveAgentMcpPolicy) => {
    saved = (expect(await owner.request('PATCH', path, { body: input,
      headers: { 'if-match': `"mcp-policy-${saved.version}"` } }), 200) as { policy: AgentMcpPolicy }).policy;
    assert.deepEqual(await get(), saved); return saved;
  };
  const input = (policy: AgentMcpPolicy): SaveAgentMcpPolicy => ({ enabledCapabilityIds: [...policy.enabledCapabilityIds],
    enabledEntryIds: [...policy.enabledEntryIds], selectedProjectIds: [...policy.selectedProjectIds] });
  let id = 100;
  const call = (method: string, params: Record<string, unknown>) => mcp(token, id++, method, params);
  const tool = (name: string, args: Record<string, unknown> = {}) => call('tools/call', { name, arguments: args });
  return { owner, workspaceId: String(workspace.id), agentId: String(agent.id), projects, grants, projectId,
    doc, material, work, initial, connection, connectionId, token, get, save, input, call, tool };
}

function unavailable(response: Awaited<ReturnType<typeof mcp>>) {
  assert.equal(response.status, 200);
  const result = response.message?.result as { isError?: boolean; messages?: unknown[] } | undefined;
  assert.ok(response.message?.error || result?.isError || (JSON.stringify(result?.messages) ?? '').includes('MCP_ENTRY_UNAVAILABLE'),
    'the actual entry returns an unavailable outcome');
  for (const secret of ['Hidden knowledge reference', 'Knowledge-secret-78419', 'Hidden original material', 'Material-secret-32917'])
    assert.ok(!JSON.stringify(response.message).includes(secret), 'a refused entry discloses no title or body');
}

test('one saved knowledge switch covers wiki/material aliases and aggregate sources on the already-issued bearer', async () => {
  const f = await connected();
  assert.equal(toolValue((await f.tool('flux_get_doc', { projectId: f.projectId, id: f.doc.id })).message).title, 'Hidden knowledge reference');
  const knowledgeOff = f.input(f.initial);
  knowledgeOff.enabledCapabilityIds = knowledgeOff.enabledCapabilityIds.filter((id) => id !== 'project.knowledge.read');
  await f.save(knowledgeOff);
  for (const [name, args] of [
    ['flux_list_docs', { projectId: f.projectId }], ['flux_list_materials', { projectId: f.projectId }],
    ['flux_get_doc', { projectId: f.projectId, id: f.doc.id }],
    ['flux_read_material', { projectId: f.projectId, materialId: f.doc.id }],
    ['flux_read_material', { projectId: f.projectId, materialId: f.material.materialId }],
    ['flux_project_orientation', { projectId: f.projectId, kind: 'doc' }],
    ['flux_changes_since', { projectId: f.projectId, known: [{ kind: 'doc', id: f.doc.id, version: 1 }] }],
    ['flux_search_project', { projectId: f.projectId, q: 'Evidence', type: 'doc' }],
    ['flux_search_project', { projectId: f.projectId, q: 'Evidence' }],
  ] as const) unavailable(await f.tool(name, args));
  assert.equal(toolValue((await f.tool('flux_get_work', { projectId: f.projectId, id: f.work.id })).message).title, 'Evidence pending review');
  const typed = toolValue((await f.tool('flux_search_project', { projectId: f.projectId, q: 'Evidence', type: 'work' })).message);
  assert.ok(!JSON.stringify(typed).includes('Knowledge-secret-78419'));
  const bootstrap = toolValue((await f.tool('flux_bootstrap', { projectId: f.projectId, clientSessionId: randomUUID() })).message);
  const catalog = bootstrap.capabilities as { name: string; available: boolean }[];
  assert.equal(catalog.find((item) => item.name === 'flux_get_doc')?.available, false);
  assert.equal(catalog.find((item) => item.name === 'flux_get_work')?.available, true);
  await f.save({ ...f.input(f.initial), enabledEntryIds: f.initial.enabledEntryIds.filter((id) => id !== 'tool:flux_get_doc') });
  unavailable(await f.tool('flux_get_doc', { projectId: f.projectId, id: f.doc.id }));
  assert.equal(toolValue((await f.tool('flux_read_material', { projectId: f.projectId, materialId: f.doc.id })).message).title,
    'Hidden knowledge reference', 'a permitted real alias still requires its own explicitly selected entry');
});

test('playbook resources and Start/Resume cannot bypass their shared switch, and policy template has its own switch', async () => {
  const f = await connected();
  assert.ok((await f.call('resources/read', { uri: coworkPlaybookUri() })).message?.result);
  const off = f.input(f.initial); off.enabledCapabilityIds = off.enabledCapabilityIds.filter((id) => id !== 'cowork.playbook.read');
  await f.save(off);
  unavailable(await f.call('resources/read', { uri: coworkPlaybookUri() }));
  for (const name of ['start_work', 'resume_work']) unavailable(await f.call('prompts/get', { name, arguments: { projectId: f.projectId } }));
  unavailable(await f.tool('flux_acknowledge_playbook', { clientSessionId: randomUUID(), bundleId: 'flux.cowork', version: '1.0.0', digest: 'unused' }));
  unavailable(await f.tool('flux_bootstrap', { projectId: f.projectId, clientSessionId: randomUUID() }));
  expect(await f.owner.request('PUT', `/api/v1/projects/${f.projectId}/agent-policy`,
    { body: { scope: 'Project policy secret', priorities: 'Observe', reviewCriteria: 'Evidence', allowedWork: 'Read', expectedRevision: 0 } }), 201);
  const policyUri = `flux://policy/${f.projectId}/1`;
  await f.save(f.input(f.initial));
  const current = await f.call('resources/read', { uri: policyUri });
  assert.ok(JSON.stringify(current.message).includes('Project policy secret'));
  const noPolicy = f.input(f.initial); noPolicy.enabledCapabilityIds = noPolicy.enabledCapabilityIds.filter((id) => id !== 'project.policy.read');
  await f.save(noPolicy);
  const denied = await f.call('resources/read', { uri: policyUri }); unavailable(denied);
  assert.ok(!JSON.stringify(denied.message).includes('Project policy secret'));
});

test('all Off stays manageable and an excluded inaccessible original project cannot poison a readable subset', async () => {
  const f = await connected();
  await f.save({ enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] });
  unavailable(await f.tool('flux_list_contexts'));
  assert.deepEqual((await f.get()).selectedProjectIds, []);
  expect(await f.owner.request('DELETE', `/api/v1/projects/${f.projects[1]}/grants/${f.grants[1]}`), 204);
  const narrow: SaveAgentMcpPolicy = { enabledCapabilityIds: ['project.identity.read', 'project.work.read'],
    enabledEntryIds: ['tool:flux_list_contexts', 'tool:flux_get_work'], selectedProjectIds: [f.projectId] };
  await f.save(narrow);
  assert.deepEqual((toolValue((await f.tool('flux_list_contexts')).message).projects as { id: string }[]).map((item) => item.id), [f.projectId]);
  assert.equal(toolValue((await f.tool('flux_get_work', { projectId: f.projectId, id: f.work.id })).message).title, 'Evidence pending review');
  unavailable(await f.tool('flux_get_work', { projectId: f.projects[1], id: randomUUID() }));
  const response = await f.owner.request('GET', '/api/v1/agent-connections');
  assert.equal(response.status, 200);
  const original = (response.json as { id: string; selectedProjectIds: string[]; scopes: string[] }[])
    .find((item) => item.id === f.connectionId)!;
  assert.deepEqual([...original.selectedProjectIds].sort(), [...f.projects].sort());
  assert.deepEqual([...original.scopes].sort(), [...f.connection.scopes as string[]].sort());
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}`), 204);
  assert.equal((await f.tool('flux_list_contexts')).status, 403);
});


test('removed owner membership refuses project-independent resources and runtime ACKs on the old bearer without blocking removal-only management', async () => {
  const f = await connected();
  const ownerId = (expect(await f.owner.request('GET', '/api/v1/me'), 200).user as { id: string }).id;
  const otherEmail = uniqueEmail('remaining-switch-owner');
  await register(otherEmail, 'correct horse battery staple');
  expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/members`,
    { body: { email: otherEmail, role: 'owner' } }), 201);
  const reference = coworkPlaybookReference(); const clientSessionId = randomUUID();
  const acknowledgement = { clientSessionId, bundleId: reference.bundleId, version: reference.version, digest: reference.digest };
  const acknowledged = toolValue((await f.tool('flux_acknowledge_playbook', acknowledgement)).message);
  assert.equal(typeof acknowledged.runtimeSessionId, 'string');
  assert.ok(JSON.stringify((await f.call('resources/read', { uri: reference.retrievalReference })).message).includes(reference.digest));
  const countRuntimes = async () => (await pool.query(
    'SELECT count(*)::int AS n FROM agent_runtime_sessions WHERE connection_id=$1', [f.connectionId])).rows[0].n as number;
  const before = await countRuntimes(); assert.equal(before, 1);
  const original = expect(await f.owner.request('GET', agentMcpPolicyPath(f.connectionId)), 200).connection;
  expect(await f.owner.request('DELETE', `/api/v1/workspaces/${f.workspaceId}/members/${ownerId}`), 204);
  assert.equal((await pool.query('SELECT revoked_at FROM agents WHERE id=$1', [f.agentId])).rows[0].revoked_at, null,
    'the actual membership removal leaves the agent row unrevoked, isolating the current-membership boundary');
  // With no reachable selected project the bearer is refused before any dispatch (main's contract).
  const refused = (response: Awaited<ReturnType<typeof mcp>>) => {
    assert.equal(response.status, 403);
    for (const secret of ['Hidden knowledge reference', 'Knowledge-secret-78419', 'Hidden original material', 'Material-secret-32917', reference.digest])
      assert.ok(!JSON.stringify(response.message).includes(secret), 'a refused bearer discloses no data');
  };
  refused(await f.call('resources/read', { uri: reference.retrievalReference }));
  refused(await f.tool('flux_acknowledge_playbook', acknowledgement));
  refused(await f.tool('flux_acknowledge_playbook', { ...acknowledgement, clientSessionId: randomUUID() }));
  assert.equal(await countRuntimes(), before, 'refused ACKs neither reuse authority nor create another runtime');
  assert.deepEqual(await f.get(), f.initial, 'an ordinary owner session can still inspect the structural saved policy');
  await f.save({ enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] });
  assert.deepEqual(expect(await f.owner.request('GET', agentMcpPolicyPath(f.connectionId)), 200).connection, original,
    'removal-only management changes no original consent');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_standing_grants WHERE connection_id=$1',
    [f.connectionId])).rows[0].n, 0, 'management creates no execution authority');
});


// Real transport handoff across two API processes on one database (#316 AC-3). The test gate (fixture token plus
// failure injection only) parks a request exactly after its tool ran and before the delivery fence, by waiting on an
// advisory lock this test holds; the owner changes the policy through the OTHER API process meanwhile.
const api2 = process.env.FLUX_API2_URL ?? 'http://api2:8080';
async function twoApi() {
  const f = await connected();
  const second = new Browser(api2, publicOrigin);
  for (const [name, value] of f.owner.cookies) second.cookies.set(name, value);
  const path = agentMcpPolicyPath(f.connectionId);
  const patchOn2 = async (input: SaveAgentMcpPolicy) => {
    const current = (expect(await second.request('GET', path), 200) as { policy: AgentMcpPolicy }).policy;
    return expect(await second.request('PATCH', path, { body: input, headers: { 'if-match': `"mcp-policy-${current.version}"` } }), 200);
  };
  const held = async (name: string, args: Record<string, unknown>, change: () => Promise<void>) => {
    const key = randomUUID(); const lock = await pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      const pending = mcp(f.token, 900, 'tools/call', { name, arguments: args }, { headers: { 'x-flux-test-delivery-gate': key } });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND mode='ShareLock'`);
        if (waiting.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal((await pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted`)).rowCount! > 0, true,
        'the request is held after its tool ran and before delivery');
      await change();
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      return await pending;
    } finally { lock.release(); }
  };
  return { ...f, second, patchOn2, held };
}

test('two API processes: Off, narrowing and Off-then-On committed on one are enforced on bytes held on the other', async () => {
  const f = await twoApi();
  const doc = { projectId: f.projectId, id: f.doc.id };
  const control = await f.held('flux_get_doc', doc, async () => undefined);
  assert.equal(control.status, 200, 'with no change the held bytes are delivered');
  assert.equal(toolValue(control.message).title, 'Hidden knowledge reference');

  const off = f.input(f.initial);
  off.enabledCapabilityIds = off.enabledCapabilityIds.filter((id) => id !== 'project.knowledge.read');
  const refusedOff = await f.held('flux_get_doc', doc, async () => { await f.patchOn2(off); });
  assert.equal(refusedOff.status, 403, 'a switch committed through the other API stops the held bytes');
  assert.ok(!JSON.stringify(refusedOff.message).includes('Knowledge-secret-78419'));
  assert.ok(!JSON.stringify(refusedOff.message).includes('Hidden knowledge reference'));

  // Off then On with identical content: the held request keeps its captured version and cannot adopt the new one.
  // Restore On first and prove the request is admitted under it, so the 403 below comes from the delivery fence.
  await f.patchOn2(f.input(f.initial));
  assert.equal(toolValue((await f.tool('flux_get_doc', doc)).message).title, 'Hidden knowledge reference');
  const cycle = await f.held('flux_get_doc', doc, async () => {
    const saved = await f.patchOn2({ ...f.input(f.initial), enabledCapabilityIds: [] });
    assert.ok(saved);
    await f.patchOn2(f.input(f.initial));
  });
  assert.equal(cycle.status, 403, 'Off then On does not resurrect a held request');
  assert.equal(toolValue((await f.tool('flux_get_doc', doc)).message).title, 'Hidden knowledge reference',
    'a newly admitted request after On is served');

  // Removing the selected project is a narrowing that also fences held bytes.
  const narrowed = await f.held('flux_get_doc', doc, async () => {
    await f.patchOn2({ ...f.input(f.initial), selectedProjectIds: [f.projects[1]!] });
  });
  assert.equal(narrowed.status, 403);
  await f.patchOn2(f.input(f.initial));

  // Deleting the agent's project grant on the other API also refuses held bytes.
  assert.equal(toolValue((await f.tool('flux_get_doc', doc)).message).title, 'Hidden knowledge reference');
  const grant = await f.held('flux_get_doc', doc, async () => {
    expect(await f.second.request('DELETE', `/api/v1/projects/${f.projectId}/grants/${f.grants[0]}`), 204);
  });
  assert.equal(grant.status, 403);
  assert.ok(!JSON.stringify(grant.message).includes('Knowledge-secret-78419'));
});
