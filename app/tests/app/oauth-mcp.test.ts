import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { DomainError } from '@flux/core';
import { withAgentConnection } from '../../apps/server/src/agent-connection/context.js';
import { apiUrl, publicOrigin, register, uniqueEmail, type Browser } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken, toolValue, type Tokens } from './support/mcp.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

test('issued OAuth bearer reads and proposes through MCP, then connection revocation rejects it immediately', async () => {
  const { browser } = await register(uniqueEmail('oauth-mcp'), 'correct horse battery staple');
  const workspace = expect(await browser.request('POST', '/api/v1/workspaces',
    { body: { name: 'OAuth MCP verification' } }), 201);
  const workspaceId = String(workspace.id);
  const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspaceId}/projects`,
    { body: { name: 'Selected restricted project', visibility: 'restricted' } }), 201);
  const projectId = String(project.id);
  const agent = expect(await browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`,
    { body: { name: 'Test local agent', owner: 'self' } }), 201);
  const agentId = String(agent.id);
  expect(await browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  const material = expect(await browser.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Battery observation', body: 'Battery lasts four hours.' } }), 201);
  const materialId = String(material.materialId);
  const secondMaterial = expect(await browser.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Capacity observation', body: 'Capacity is limited.' } }), 201);
  const doc = expect(await browser.request('POST', `/api/v1/projects/${projectId}/docs`,
    { body: { title: 'Experiment notes', body: 'A project doc source.\n' + 'Observation. '.repeat(4000) } }), 201);
  const hiddenProject = expect(await browser.request('POST', `/api/v1/workspaces/${workspaceId}/projects`,
    { body: { name: 'Unselected private project', visibility: 'restricted' } }), 201);
  const hiddenProjectId = String(hiddenProject.id);
  const hiddenMaterial = expect(await browser.request('POST', `/api/v1/projects/${hiddenProjectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Secret source title', body: 'Private content.' } }), 201);
  // The agent can read this other project via its domain grant; this connection still may not.
  expect(await browser.request('POST', `/api/v1/projects/${hiddenProjectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  const work = expect(await browser.request('POST', `/api/v1/projects/${projectId}/work`,
    { body: { title: 'Battery comparison', outcome: 'Compare current battery runtime' } }), 201);
  const decision = expect(await browser.request('POST', `/api/v1/projects/${projectId}/decisions`,
    { body: { title: 'Battery comparison decision', rationale: 'Run a comparison first' } }), 201);
  const result = expect(await browser.request('POST', `/api/v1/projects/${projectId}/results`,
    { body: { title: 'Battery observation result', finding: 'negative', evidence: 'Four hours observed' } }), 201);
  const conversation = expect(await browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
    { body: { body: 'Battery comparison discussion', clientMessageId: randomUUID() } }), 201);
  const map = expect(await browser.request('POST', `/api/v1/workspaces/${workspaceId}/sketches`,
    { body: { title: 'Battery comparison map', scope: 'project', projectId } }), 201);
  expect(await browser.request('POST', `/api/v1/sketches/${map.id}/thoughts`,
    { body: { text: 'Battery capacity observation', x: 0, y: 0 } }), 201);
  expect(await browser.request('POST', `/api/v1/sketches/${map.id}/thoughts`,
    { body: { text: 'Battery duration question', x: 200, y: 0 } }), 201);
  const privateMap = expect(await browser.request('POST', `/api/v1/workspaces/${workspaceId}/sketches`,
    { body: { title: 'Secret private battery map', scope: 'private' } }), 201);
  const connection = expect(await browser.request('POST', '/api/v1/agent-connections',
    { body: { agentId, selectedProjectIds: [projectId], scopes: ['flux.context.read', 'flux.proposal.write'] } }), 201);
  const connectionId = String(connection.id);

  // A local OAuth client fixture exercises the provider's real authorization-code
  // and PKCE endpoints without fetching external client metadata in Docker CI.
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'none', $5, $6, $7, true, now(), now())`,
  [randomUUID(), clientId, 'Flux HTTP test client', [redirectUri], ['authorization_code', 'refresh_token'], ['code'],
    ['flux.context.read', 'flux.proposal.write', 'offline_access']]);
  await pool.query(`INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
    VALUES ($1, $2, $3, now())`, [randomUUID(), clientId, `${publicOrigin}/mcp`]);

  const bearer = (await oauthToken(browser, connectionId, clientId, redirectUri)).access_token;
  const signedClaims = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString()) as { flux_grant_reference: string; sub: string };
  let projected = false;
  await assert.rejects(withAgentConnection(db, { ownerUserId: signedClaims.sub, connectionId,
    clientId: 'another-actual-client', grantReferenceId: signedClaims.flux_grant_reference,
    scopes: ['flux.context.read'] }, 'flux.context.read', projectId, async () => { projected = true; }),
  (error: unknown) => error instanceof DomainError && error.code === 'CONNECTION_NOT_FOUND');
  assert.equal(projected, false, 'actual-client substitution is rejected inside the transaction before content');
  const listed = await mcp(bearer, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
  assert.equal(listed.status, 200, `MCP call returned ${listed.status}: ${JSON.stringify(listed.message)}`);
  assert.deepEqual(toolValue(listed.message).projects, [{ id: projectId,
    name: 'Selected restricted project', workspaceId }]);
  const sources = await mcp(bearer, 5, 'tools/call', { name: 'flux_list_materials', arguments: { projectId, limit: 1 } });
  assert.equal(sources.status, 200);
  const firstPage = toolValue(sources.message);
  assert.equal(firstPage.total, 3);
  assert.equal((firstPage.items as unknown[]).length, 1);
  const nextPage = toolValue((await mcp(bearer, 6, 'tools/call', {
    name: 'flux_list_materials', arguments: { projectId, limit: 1, offset: 1 },
  })).message);
  assert.equal(nextPage.total, 3);
  const thirdPage = toolValue((await mcp(bearer, 8, 'tools/call', {
    name: 'flux_list_materials', arguments: { projectId, limit: 1, offset: 2 },
  })).message);
  const items = [...firstPage.items as Record<string, unknown>[],
    ...nextPage.items as Record<string, unknown>[], ...thirdPage.items as Record<string, unknown>[]];
  assert.deepEqual(new Set(items.map((item) => item.materialId)), new Set([materialId, secondMaterial.materialId, doc.id]));
  assert.ok(items.every((item) => item.version === 1 && typeof item.title === 'string'));
  assert.equal(items.find((item) => item.materialId === doc.id)?.kind, 'doc');
  assert.ok(!JSON.stringify(items).includes('Battery lasts four hours.'), 'the picker does not include source bodies');
  const deniedSources = await mcp(bearer, 7, 'tools/call', { name: 'flux_list_materials',
    arguments: { projectId: hiddenProjectId } });
  assert.equal(deniedSources.status, 200);
  assert.equal((deniedSources.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(!JSON.stringify(deniedSources.message).includes('Secret source title'));
  assert.ok(!JSON.stringify(deniedSources.message).includes(String(hiddenMaterial.materialId)));
  const recorded: Record<string, unknown>[] = [];
  for (const [kind, id] of [['material', materialId], ['doc', doc.id], ['work', work.id], ['decision', decision.id],
    ['result', result.id], ['conversation', conversation.id], ['map', map.id]] as const) {
    const index = toolValue((await mcp(bearer, 40, 'tools/call', { name: 'flux_project_orientation', arguments: { projectId, kind, limit: 1 } })).message);
    assert.equal(index.coverage, 'canonical_metadata_page'); assert.equal((index.items as unknown[]).length, 1);
    const window = toolValue((await mcp(bearer, 41, 'tools/call', { name: 'flux_project_orientation', arguments: { projectId, kind, limit: 50 } })).message);
    const refs = window.items as { checkpoint: Record<string, unknown>; title: string; state: string | null }[];
    const own = refs.find((row) => row.checkpoint.id === id); assert.ok(own, `${kind} is indexed by its canonical ID`);
    assert.ok(!JSON.stringify(refs).includes('Battery lasts four hours.'), 'metadata omits bodies');
    if (kind === 'conversation') assert.equal(own.checkpoint.sequence, 1);
    if (kind === 'map') assert.equal(own.checkpoint.version, 1);
    if (kind === 'doc') assert.equal(own.state, 'draft', 'publication state is separate from source version');
    recorded.push(own.checkpoint);
  }
  const hiddenIndex = await mcp(bearer, 42, 'tools/call', { name: 'flux_project_orientation', arguments: { projectId: hiddenProjectId, kind: 'material' } });
  assert.equal((hiddenIndex.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(!JSON.stringify(hiddenIndex.message).includes('Secret source title'));
  const privateComparison = toolValue((await mcp(bearer, 43, 'tools/call', { name: 'flux_changes_since', arguments: { projectId, known: [
    { kind: 'map', id: privateMap.id, version: 1, updatedAt: new Date().toISOString() },
    { kind: 'material', id: hiddenMaterial.materialId, version: 1 }, { kind: 'work', id: randomUUID(), version: 1 },
  ] } })).message);
  assert.equal((privateComparison.unavailable as unknown[]).length, 3);
  assert.ok(!JSON.stringify(privateComparison).includes('Secret'));
  assert.ok((privateComparison.unavailable as Record<string, unknown>[]).every((row) => Object.keys(row).sort().join(',') === 'id,kind'));
  const originalChanges = toolValue((await mcp(bearer, 44, 'tools/call', { name: 'flux_changes_since', arguments: { projectId, known: recorded } })).message);
  assert.equal((originalChanges.unchanged as unknown[]).length, 7); assert.deepEqual(originalChanges.changed, []);
  for (const [name, arguments_] of [
    ['flux_project_orientation', { projectId, kind: 'work', limit: 51 }],
    ['flux_changes_since', { projectId, known: [recorded[0], recorded[0]] }],
    ['flux_changes_since', { projectId, known: Array.from({ length: 51 }, () => ({ kind: 'result', id: randomUUID() })) }],
    ['flux_bootstrap', { projectId, clientSessionId: randomUUID(), clientInfo: { name: 'trusted' }, loadedInstructions: true }],
  ] as const) {
    const denied = await mcp(bearer, 45, 'tools/call', { name, arguments: arguments_ });
    assert.ok(denied.message?.error || (denied.message?.result as { isError?: boolean })?.isError, name);
  }
  // Native task plans (#152): the agent reads the same canonical task, with criteria, prerequisite state and plan revision.
  const charged = expect(await browser.request('POST', `/api/v1/projects/${projectId}/work`, { body: { title: 'Charge the pack', status: 'done' } }), 201);
  const planned = expect(await browser.request('POST', `/api/v1/projects/${projectId}/work`, { body: { title: 'Run the battery comparison',
    criteria: ['Four hours observed'], dependencyIds: [charged.id], planIntent: { materialId, version: 1, intentKey: 'battery-plan' } } }), 201);
  const plannedRead = toolValue((await mcp(bearer, 60, 'tools/call', { name: 'flux_get_work', arguments: { projectId, id: planned.id } })).message);
  assert.deepEqual([plannedRead.criteria, plannedRead.dependencyIds, plannedRead.planIntent], [['Four hours observed'], [charged.id], { materialId, version: 1, intentKey: 'battery-plan' }]);
  assert.deepEqual((plannedRead.prerequisites as { id: string; met: boolean }[]).map((item) => [item.id, item.met]), [[charged.id, true]]);
  const plannedList = toolValue((await mcp(bearer, 61, 'tools/call', { name: 'flux_list_work', arguments: { projectId, limit: 50 } })).message);
  assert.deepEqual((plannedList.items as { id: string; criteria: string[] }[]).find((item) => item.id === planned.id)?.criteria, ['Four hours observed']);
  assert.deepEqual((plannedList.items as { id: string; planIntent: unknown }[]).find((item) => item.id === work.id)?.planIntent, null, 'earlier tasks present no guessed plan');
  const clientSessionId = randomUUID();
  const bootstrap = toolValue((await mcp(bearer, 46, 'tools/call', { name: 'flux_bootstrap', arguments: { projectId, clientSessionId } })).message);
  const repeatedBootstrap = toolValue((await mcp(bearer, 47, 'tools/call', { name: 'flux_bootstrap', arguments: { projectId, clientSessionId } })).message);
  assert.deepEqual(repeatedBootstrap.runtime, bootstrap.runtime, 'runtime retry preserves original identity and expiry');
  assert.equal((bootstrap.readiness as { state: string }).state, 'pending');
  assert.deepEqual(bootstrap.trusted, { playbook: null, approvedPolicy: null, coordination: null, repositoryReferences: null });
  assert.ok((bootstrap.gaps as string[]).includes('trusted_playbook_unavailable'));
  assert.equal((bootstrap.runtime as { clientId: string }).clientId, clientId);
  const discovery = await mcp(bearer, 48, 'tools/list');
  const tools = (discovery.message?.result as { tools: { name: string }[] }).tools;
  assert.deepEqual(new Set((bootstrap.capabilities as { name: string }[]).map((row) => row.name)), new Set(tools.map((row) => row.name)),
    'bootstrap capability names come from actual registered MCP tools');
  const writes = (bootstrap.capabilities as { name: string; operation: string | null; available: boolean }[]).filter((row) => row.operation !== null);
  assert.deepEqual(writes.map(({ name, operation, available }) => ({ name, operation, available })),
    [{ name: 'flux_create_task', operation: 'work.create', available: false }, { name: 'flux_update_task', operation: 'work.update', available: false },
      { name: 'flux_record_result', operation: 'result.record', available: false }, { name: 'flux_propose_decision', operation: 'decision.propose', available: false }],
    'only the verified native work actions are advertised, unavailable without the action scope');
  const unscoped = await mcp(bearer, 147, 'tools/call', { name: 'flux_create_task', arguments: { projectId,
    runtimeSessionId: (bootstrap.runtime as { id: string }).id, grantId: randomUUID(), clientCommandId: randomUUID(),
    peerRequestClass: 'plan', sources: [], task: { title: 'Not without the action scope' } } });
  assert.equal((unscoped.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(JSON.stringify(unscoped.message).includes('MCP_SCOPE_REQUIRED'));
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [(bootstrap.runtime as { id: string }).id]);
  const expiredRuntime = await mcp(bearer, 49, 'tools/call', { name: 'flux_bootstrap', arguments: { projectId, clientSessionId } });
  assert.ok(JSON.stringify(expiredRuntime.message).includes('RUNTIME_UNAVAILABLE'));
  const read = await mcp(bearer, 2, 'tools/call', { name: 'flux_read_material', arguments: { projectId, materialId } });
  assert.equal(read.status, 200);
  assert.equal(toolValue(read.message).body, 'Battery lasts four hours.');
  const hiddenRead = await mcp(bearer, 21, 'tools/call', { name: 'flux_read_material',
    arguments: { projectId, materialId: hiddenMaterial.materialId } });
  assert.equal((hiddenRead.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(!JSON.stringify(hiddenRead.message).includes('Private content'));
  for (const [name, record] of [['work', work], ['decision', decision], ['result', result], ['conversation', conversation], ['map', map]] as const) {
    const read = toolValue((await mcp(bearer, 22, 'tools/call', { name: `flux_get_${name}`, arguments: { projectId, id: record.id } })).message);
    assert.equal(read.id, record.id);
  }
  const privateMapRead = await mcp(bearer, 23, 'tools/call', { name: 'flux_get_map', arguments: { projectId, id: privateMap.id } });
  assert.equal((privateMapRead.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(!JSON.stringify(privateMapRead.message).includes('Secret private'));
  const docPage = toolValue((await mcp(bearer, 24, 'tools/call', { name: 'flux_get_doc', arguments: { projectId, id: doc.id } })).message);
  assert.equal((docPage.body as string).length, 20_000);
  assert.equal(docPage.nextOffset, 20_000);
  assert.equal('html' in docPage, false);
  const docNext = toolValue((await mcp(bearer, 25, 'tools/call', { name: 'flux_get_doc', arguments: { projectId, id: doc.id, offset: 20_000, version: 1 } })).message);
  assert.equal(docNext.offset, 20_000);
  expect(await browser.request('PATCH', `/api/v1/docs/${doc.id}`, { body: { body: 'Updated wiki observation' }, headers: { 'if-match': '"1"' } }), 200);
  const staleDoc = await mcp(bearer, 26, 'tools/call', { name: 'flux_get_doc', arguments: { projectId, id: doc.id, offset: 20_000, version: 1 } });
  assert.equal((staleDoc.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(JSON.stringify(staleDoc.message).includes('SOURCE_VERSION_CONFLICT'));
  const search = toolValue((await mcp(bearer, 27, 'tools/call', { name: 'flux_search_project', arguments: { projectId, q: 'Battery', limit: 2 } })).message);
  assert.equal((search.items as Record<string, unknown>[]).length, 2);
  assert.ok(search.next, 'search exposes its continuation');
  assert.ok(!JSON.stringify(search).includes('Secret private'));
  const mapSearch = toolValue((await mcp(bearer, 28, 'tools/call', { name: 'flux_search_project', arguments: { projectId, q: 'Battery', type: 'sketch' } })).message);
  assert.ok((mapSearch.items as Record<string, unknown>[]).some((row) => row.kind === 'thought'));
  assert.ok(!JSON.stringify(mapSearch).includes('Secret private'));
  const mapPage = toolValue((await mcp(bearer, 29, 'tools/call', { name: 'flux_get_map', arguments: { projectId, id: map.id, limit: 1 } })).message);
  assert.equal((mapPage.thoughts as unknown[]).length, 1);
  assert.equal((mapPage.thoughtPage as { nextOffset: number }).nextOffset, 1);
  const mapNext = toolValue((await mcp(bearer, 30, 'tools/call', { name: 'flux_get_map', arguments: { projectId, id: map.id, limit: 1, offset: 1, expectedUpdatedAt: mapPage.updatedAt } })).message);
  assert.equal((mapNext.thoughts as unknown[]).length, 1);
  expect(await browser.request('POST', `/api/v1/sketches/${map.id}/thoughts`, { body: { text: 'A later observation', x: 0, y: 200 } }), 201);
  const staleMap = await mcp(bearer, 31, 'tools/call', { name: 'flux_get_map', arguments: { projectId, id: map.id, offset: 1, expectedUpdatedAt: mapPage.updatedAt } });
  assert.equal((staleMap.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(JSON.stringify(staleMap.message).includes('SOURCE_VERSION_CONFLICT'));
  expect(await browser.request('PATCH', `/api/v1/work/${work.id}`, { body: { expectedVersion: 1, outcome: 'A revised comparison' } }), 200);
  expect(await browser.request('POST', `/api/v1/conversations/${conversation.id}/messages`, { body: { body: 'A later real contribution', clientMessageId: randomUUID() } }), 201);
  const changed = toolValue((await mcp(bearer, 50, 'tools/call', { name: 'flux_changes_since', arguments: { projectId, known: recorded } })).message);
  assert.deepEqual(new Set((changed.changed as { checkpoint: { kind: string } }[]).map((row) => row.checkpoint.kind)), new Set(['doc', 'work', 'conversation', 'map']));
  assert.equal((changed.unchanged as unknown[]).length, 3);
  assert.equal(changed.coverage, 'supplied_references_only'); assert.equal(changed.newObjectDiscovery, 'use_project_orientation');
  const created = await mcp(bearer, 3, 'tools/call', { name: 'flux_create_proposal', arguments: {
    projectId, materialId, version: 1, clientCommandId: randomUUID(),
    fact: 'Battery lasts four hours', interpretation: 'Runtime may be short',
    suggestedAction: 'Compare another battery',
  } });
  assert.equal(created.status, 200);
  assert.equal(toolValue(created.message).status, 'proposed');

  const grants = expect(await browser.request('GET', `/api/v1/projects/${projectId}/grants`), 200) as unknown as { id: string; principal: { kind: string; id: string } }[];
  const agentGrant = grants.find((grant) => grant.principal.kind === 'agent' && grant.principal.id === agentId);
  assert.ok(agentGrant);
  expect(await browser.request('DELETE', `/api/v1/projects/${projectId}/grants/${agentGrant.id}`), 204);
  const lostGrant = await mcp(bearer, 9, 'tools/call', { name: 'flux_list_materials', arguments: { projectId } });
  assert.equal(lostGrant.status, 403, 'grant loss invalidates the bearer before tool dispatch');
  assert.ok(!JSON.stringify(lostGrant.message).includes('Battery observation'));

  const restoredGrant = expect(await browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  assert.notEqual(restoredGrant.id, agentGrant.id, 'the restored grant is a new authority');
  const restoredSources = await mcp(bearer, 10, 'tools/call', { name: 'flux_list_materials', arguments: { projectId } });
  assert.equal(restoredSources.status, 200, 'the original connection works again after a current grant is restored');
  assert.equal(toolValue(restoredSources.message).total, 3);

  expect(await browser.request('DELETE', `/api/v1/agent-connections/${connectionId}`), 204);
  const revoked = await mcp(bearer, 11, 'tools/call', { name: 'flux_list_materials', arguments: { projectId } });
  assert.equal(revoked.status, 403, 'the same already-issued bearer loses access before expiry');
});


async function refresh(clientId: string, token: string) {
  const response = await fetch(new URL('/api/auth/oauth2/token', apiUrl), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token,
      resource: `${publicOrigin}/mcp` }),
  });
  return { status: response.status, tokens: await response.json() as Tokens };
}

test('three named connections share one actual client; same-session choices, refresh families and revocation remain independent', async () => {
  const owner = (await register(uniqueEmail('connections-owner'), 'correct horse battery staple')).browser;
  const peer = (await register(uniqueEmail('connections-peer'), 'correct horse battery staple')).browser;
  async function connection(browser: Browser, name: string, clientDesignation: 'codex' | 'claude_code', actions = false) {
    const workspace = expect(await browser.request('POST', '/api/v1/workspaces', { body: { name } }), 201);
    const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
      { body: { name: `${name} project`, visibility: 'restricted' } }), 201);
    const agent = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/agents`,
      { body: { name: `${name} agent`, owner: 'self' } }), 201);
    expect(await browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const saved = expect(await browser.request('POST', '/api/v1/agent-connections', { body: {
      name, clientDesignation, agentId: agent.id, selectedProjectIds: [project.id],
      scopes: ['flux.context.read', 'flux.proposal.write', ...(actions ? ['flux.action.execute'] : [])],
    } }), 201);
    assert.equal(saved.name, name); assert.equal(saved.clientDesignation, clientDesignation);
    assert.equal(saved.computeSource, 'user_operated_external_client');
    return { id: String(saved.id), projectId: String(project.id) };
  }
  const [a, b, c] = await Promise.all([connection(owner, 'Hubert research', 'codex', true),
    connection(owner, 'Hubert delivery', 'claude_code'), connection(peer, 'Peer research', 'codex')]);
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'],
    ['flux.context.read', 'flux.proposal.write', 'flux.action.execute', 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const actionScope = 'flux.context.read flux.proposal.write flux.action.execute offline_access';
  const [flowA, flowB, flowC] = await Promise.all([beginOauth(owner, clientId, redirectUri, { prompt: 'consent', scope: actionScope }),
    beginOauth(owner, clientId, redirectUri), beginOauth(peer, clientId, redirectUri)]);
  const tampered = new URLSearchParams(flowA.oauthQuery); tampered.set('state', randomUUID());
  expect(await owner.request('POST', `/api/v1/agent-connections/${a.id}/select-for-oauth`,
    { body: { oauth_query: tampered.toString() } }), 400);
  const substitutedScope = new URLSearchParams(flowB.oauthQuery); substitutedScope.set('scope', actionScope);
  expect(await owner.request('POST', `/api/v1/agent-connections/${b.id}/select-for-oauth`,
    { body: { oauth_query: substitutedScope.toString() } }), 400);
  expect(await peer.request('POST', `/api/v1/agent-connections/${a.id}/select-for-oauth`,
    { body: { oauth_query: flowC.oauthQuery } }), 404);
  expect(await owner.request('POST', `/api/v1/agent-connections/${a.id}/select-for-oauth`,
    { body: { oauth_query: flowA.oauthQuery } }), 204);
  expect(await owner.request('POST', `/api/v1/agent-connections/${b.id}/select-for-oauth`,
    { body: { oauth_query: flowA.oauthQuery } }), 404); // A read/propose connection cannot accept action scope.
  expect(await owner.request('POST', `/api/v1/agent-connections/${b.id}/select-for-oauth`,
    { body: { oauth_query: flowB.oauthQuery } }), 204);
  expect(await owner.request('POST', `/api/v1/agent-connections/${a.id}/select-for-oauth`,
    { body: { oauth_query: flowB.oauthQuery } }), 409);
  const [tokensA, tokensB, tokensC] = await Promise.all([oauthToken(owner, a.id, clientId, redirectUri, flowA),
    oauthToken(owner, b.id, clientId, redirectUri, flowB), oauthToken(peer, c.id, clientId, redirectUri, flowC)]);
  for (const [tokens, actions] of [[tokensA, true], [tokensB, false], [tokensC, false]] as const) {
    const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString()) as { scope: string };
    assert.equal(claims.scope.split(' ').includes('flux.action.execute'), actions, 'only explicitly requested/selected action scope is issued');
  }
  for (const [tokens, connection] of [[tokensA, a], [tokensB, b], [tokensC, c]] as const) {
    const listed = await mcp(tokens.access_token, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
    assert.equal(listed.status, 200);
    assert.deepEqual((toolValue(listed.message).projects as { id: string }[]).map((p) => p.id), [connection.projectId]);
  }
  const manifestGrants: Record<string, unknown>[] = [];
  for (let i = 0; i < 4; i++) manifestGrants.push(expect(await owner.request('POST', `/api/v1/agent-connections/${a.id}/action-grants`, { body: {
    clientCommandId: randomUUID(), projectId: a.projectId, operation: 'work.create', peerRequestClass: 'plan', maximumUses: 1,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  } }), 201));
  await pool.query('UPDATE agent_standing_grants SET used=maximum_uses WHERE id=$1', [manifestGrants[1]!.id]);
  await pool.query("UPDATE agent_standing_grants SET expires_at=now()-interval '1 second' WHERE id=$1", [manifestGrants[2]!.id]);
  expect(await owner.request('DELETE', `/api/v1/agent-connections/${a.id}/action-grants/${manifestGrants[3]!.id}`), 204);
  const liveManifest = toolValue((await mcp(tokensA.access_token, 60, 'tools/call', { name: 'flux_bootstrap', arguments: {
    projectId: a.projectId, clientSessionId: randomUUID(), grantLimit: 1,
  } })).message).grants as { items: { id: string; remainingUses: number }[]; total: number; nextOffset: number | null };
  assert.equal(liveManifest.total, 2); assert.equal(liveManifest.items.length, 1); assert.equal(liveManifest.nextOffset, 1);
  const allManifest = toolValue((await mcp(tokensA.access_token, 61, 'tools/call', { name: 'flux_bootstrap', arguments: {
    projectId: a.projectId, clientSessionId: randomUUID(), grantLimit: 50,
  } })).message).grants as { items: { id: string; remainingUses: number }[] };
  assert.deepEqual(new Set(allManifest.items.map((row) => row.id)), new Set(manifestGrants.slice(0, 2).map((row) => row.id)));
  assert.equal(allManifest.items.find((row) => row.id === manifestGrants[1]!.id)?.remainingUses, 0, 'exhausted live grants explain receipt observation without authorizing new actions');
  const anotherConnection = toolValue((await mcp(tokensB.access_token, 62, 'tools/call', { name: 'flux_bootstrap', arguments: {
    projectId: b.projectId, clientSessionId: randomUUID(),
  } })).message);
  assert.equal((anotherConnection.grants as { total: number }).total, 0, 'the same actual OAuth client cannot see another connection manifest');
  assert.equal((anotherConnection.runtime as { connectionId: string }).connectionId, b.id);
  const hiddenBootstrap = await mcp(tokensB.access_token, 63, 'tools/call', { name: 'flux_bootstrap', arguments: {
    projectId: a.projectId, clientSessionId: randomUUID(),
  } });
  assert.equal((hiddenBootstrap.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(!JSON.stringify(hiddenBootstrap.message).includes('Hubert research project'));
  // The signed browser query expires independently of the durable token grant.
  await pool.query(`UPDATE agent_oauth_flows SET expires_at = now() - interval '1 second'
    WHERE binding_id IN (SELECT id FROM agent_oauth_bindings WHERE connection_id = $1)`, [a.id]);
  const rotatedA = await refresh(clientId, tokensA.refresh_token); assert.equal(rotatedA.status, 200);
  const cachedA = await refresh(clientId, tokensA.refresh_token);
  assert.equal(cachedA.status, 200, 'an immediate retry uses the configured provider reuse window');
  assert.equal(cachedA.tokens.refresh_token, rotatedA.tokens.refresh_token);
  const reconnectedA = await oauthToken(owner, a.id, clientId, redirectUri, await beginOauth(owner, clientId, redirectUri, { scope: actionScope }));
  await pool.query(`UPDATE oauth_refresh_token SET rotation_replay_expires_at = now() - interval '1 second'
    WHERE reference_id IN (SELECT 'flux-grant:' || id::text FROM agent_oauth_bindings WHERE connection_id = $1) AND revoked IS NOT NULL`, [a.id]);
  assert.equal((await refresh(clientId, tokensA.refresh_token)).status, 400, 'reuse rejects only its original authorization family');
  assert.equal((await refresh(clientId, rotatedA.tokens.refresh_token)).status, 400);
  const freshA = await refresh(clientId, reconnectedA.refresh_token); assert.equal(freshA.status, 200, 'reconnecting creates a separate lineage');
  const freshB = await refresh(clientId, tokensB.refresh_token); assert.equal(freshB.status, 200, 'same client/user second connection survives replay');
  assert.equal((await refresh(clientId, tokensC.refresh_token)).status, 200, 'second owner survives replay');
  expect(await owner.request('DELETE', `/api/v1/agent-connections/${a.id}`), 204);
  assert.equal((await mcp(freshA.tokens.access_token, 2, 'tools/list')).status, 403);
  assert.equal((await refresh(clientId, freshA.tokens.refresh_token)).status, 400);
  assert.equal((await refresh(clientId, reconnectedA.refresh_token)).status, 400, 'cached rotation response also rechecks revoked authority');
  assert.equal((await mcp(freshB.tokens.access_token, 2, 'tools/list')).status, 200);
  assert.equal((await refresh(clientId, freshB.tokens.refresh_token)).status, 200);
  await pool.query('UPDATE oauth_client SET disabled = true WHERE client_id = $1', [clientId]);
  assert.equal((await mcp(freshB.tokens.access_token, 3, 'tools/list')).status, 403, 'a disabled actual OAuth client loses access');
});
