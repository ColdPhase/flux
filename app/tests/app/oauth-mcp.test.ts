import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { coworkPlaybookReference, DomainError } from '@flux/core';
import { withAgentConnection } from '../../apps/server/src/agent-connection/context.js';
import { db, pool } from './support/db.js';
import { apiUrl, publicOrigin, register, uniqueEmail, type Browser } from './support/http.js';
import { expect, mcp, oauthToken, toolValue, type Tokens } from './support/mcp.js';
import { createConnection, oauthTokenFor, registerOauthClient } from './support/mcp-actions.js';

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
  const material = expect(await browser.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Battery observation', body: 'Battery lasts four hours.' } }), 201);
  const materialId = String(material.materialId);
  const secondMaterial = expect(await browser.request('POST', `/api/v1/projects/${projectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Capacity observation', body: 'Capacity is limited.' } }), 201);
  const doc = expect(await browser.request('POST', `/api/v1/projects/${projectId}/docs`,
    { body: { title: 'Experiment notes', body: 'A project doc source.\n' + 'Observation. '.repeat(4000) } }), 201);
  // Another person's project, in a company of their own: the owner cannot read it, so neither can the connection (it has the owner's rights).
  const stranger = (await register(uniqueEmail('oauth-mcp-stranger'), 'correct horse battery staple')).browser;
  const strangerWorkspace = expect(await stranger.request('POST', '/api/v1/workspaces', { body: { name: 'Stranger company' } }), 201);
  const hiddenProject = expect(await stranger.request('POST', `/api/v1/workspaces/${strangerWorkspace.id}/projects`,
    { body: { name: 'Stranger private project', visibility: 'restricted' } }), 201);
  const hiddenProjectId = String(hiddenProject.id);
  const hiddenMaterial = expect(await stranger.request('POST', `/api/v1/projects/${hiddenProjectId}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Secret source title', body: 'Private content.' } }), 201);
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
  const connection = await createConnection(pool, browser, { agentId });
  const connectionId = connection.id;

  // A local OAuth client fixture exercises the provider's real authorization-code
  // and PKCE endpoints without fetching external client metadata in Docker CI.
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'none', $5, $6, $7, true, now(), now())`,
  [randomUUID(), clientId, 'Flux HTTP test client', [redirectUri], ['authorization_code', 'refresh_token'], ['code'],
    ['offline_access']]);
  await pool.query(`INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
    VALUES ($1, $2, $3, now())`, [randomUUID(), clientId, `${publicOrigin}/mcp`]);

  const bearer = (await oauthTokenFor(pool, browser, connectionId, clientId, redirectUri)).access_token;
  const signedClaims = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString()) as { flux_grant_reference: string; sub: string };
  let projected = false;
  await assert.rejects(withAgentConnection(db, { ownerUserId: signedClaims.sub, connectionId,
    clientId: 'another-actual-client', grantReferenceId: signedClaims.flux_grant_reference }, 'read', projectId, async () => { projected = true; }),
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
    if (kind === 'doc') assert.equal(own.state, null, 'a page has no publication state');
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
  assert.deepEqual(bootstrap.trusted, { playbook: coworkPlaybookReference(),
    coordination: { activeClaimReference: null, checkpointReference: null }, repositoryReferences: null });
  assert.ok(!(bootstrap.gaps as string[]).includes('trusted_playbook_unavailable'));
  assert.ok(!(bootstrap.gaps as string[]).includes('coordination_unavailable'), 'units, claims and completion exist (#153)');
  assert.equal((bootstrap.runtime as { clientId: string }).clientId, clientId);
  const discovery = await mcp(bearer, 48, 'tools/list');
  const tools = (discovery.message?.result as { tools: { name: string }[] }).tools;
  const capabilityRows = bootstrap.capabilities as { name: string; operation: string | null; available: boolean }[];
  // Every tool is listed and named, whatever the client asked at sign-in: what a call may do is decided when it is made (#859).
  assert.deepEqual(new Set(capabilityRows.map((row) => row.name)), new Set(tools.map((row) => row.name)),
    'bootstrap names exactly the tools listed');
  assert.ok(capabilityRows.some((row) => row.name === 'flux_create_task'), 'the change tools are listed');
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

  // The agent has no project grant of its own (F-036 AG-3): a manager cannot list or remove one.
  const grants = expect(await browser.request('GET', `/api/v1/projects/${projectId}/grants`), 200) as unknown as { principal: { kind: string; id: string } }[];
  assert.equal(grants.some((grant) => grant.principal.kind === 'agent' || grant.principal.id === agentId), false);
  assert.equal((await browser.request('POST', `/api/v1/projects/${projectId}/grants`,
    { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } })).status, 400, 'an agent cannot be given a grant');

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

test('one client signs in for two people: each gets their own connection with one click, a second sign-in finds it, and refresh families and revocation stay independent', async () => {
  const owner = (await register(uniqueEmail('connections-owner'), 'correct horse battery staple')).browser;
  const peer = (await register(uniqueEmail('connections-peer'), 'correct horse battery staple')).browser;
  async function company(browser: Browser, name: string) {
    const workspace = expect(await browser.request('POST', '/api/v1/workspaces', { body: { name } }), 201);
    const project = expect(await browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
      { body: { name: `${name} project`, visibility: 'restricted' } }), 201);
    return { projectId: String(project.id) };
  }
  const [a, c] = await Promise.all([company(owner, 'Hubert research'), company(peer, 'Peer research')]);
  const { clientId, redirectUri } = await registerOauthClient(pool);
  const [tokensA, tokensC] = await Promise.all([oauthToken(owner, clientId, redirectUri), oauthToken(peer, clientId, redirectUri)]);
  const connectionsOf = async (browser: Browser) => (expect(await browser.request('GET', '/api/v1/agent-connections'), 200) as unknown as { id: string; ownerUserId: string; mayDo: string }[]);
  const [ownerConnections, peerConnections] = [await connectionsOf(owner), await connectionsOf(peer)];
  assert.equal(ownerConnections.length, 1); assert.equal(peerConnections.length, 1);
  assert.notEqual(ownerConnections[0]!.id, peerConnections[0]!.id);
  assert.equal(ownerConnections[0]!.mayDo, 'act', 'a new connection starts at "Do it and tell me"');
  const claimsOf = (tokens: Tokens) => JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString()) as { scope: string; flux_connection_id: string; flux_owner_user_id: string };
  assert.equal(claimsOf(tokensA).scope, 'offline_access', 'the only scope there is');
  assert.equal(claimsOf(tokensA).flux_connection_id, ownerConnections[0]!.id);
  assert.equal(claimsOf(tokensC).flux_connection_id, peerConnections[0]!.id);
  for (const [tokens, mine] of [[tokensA, a], [tokensC, c]] as const) {
    const listed = await mcp(tokens.access_token, 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} });
    assert.equal(listed.status, 200);
    assert.deepEqual((toolValue(listed.message).projects as { id: string }[]).map((p) => p.id), [mine.projectId]);
  }
  const otherProject = await mcp(tokensC.access_token, 63, 'tools/call', { name: 'flux_bootstrap', arguments: {
    projectId: a.projectId, clientSessionId: randomUUID(),
  } });
  assert.equal((otherProject.message?.result as { isError?: boolean })?.isError, true);
  assert.ok(!JSON.stringify(otherProject.message).includes('Hubert research project'));
  const rotatedA = await refresh(clientId, tokensA.refresh_token); assert.equal(rotatedA.status, 200);
  const cachedA = await refresh(clientId, tokensA.refresh_token);
  assert.equal(cachedA.status, 200, 'an immediate retry uses the configured provider reuse window');
  assert.equal(cachedA.tokens.refresh_token, rotatedA.tokens.refresh_token);
  // Signing in again finds the held connection: no page, no second connection, and a separate refresh lineage.
  const reconnectedA = await oauthToken(owner, clientId, redirectUri);
  assert.equal(claimsOf(reconnectedA).flux_connection_id, ownerConnections[0]!.id);
  assert.equal((await connectionsOf(owner)).length, 1);
  await pool.query(`UPDATE oauth_refresh_token SET rotation_replay_expires_at = now() - interval '1 second'
    WHERE reference_id = (SELECT 'flux-grant:' || id::text FROM agent_oauth_bindings WHERE connection_id = $1) AND revoked IS NOT NULL`, [ownerConnections[0]!.id]);
  assert.equal((await refresh(clientId, tokensA.refresh_token)).status, 400, 'reuse rejects only its original authorization family');
  assert.equal((await refresh(clientId, rotatedA.tokens.refresh_token)).status, 400);
  const freshA = await refresh(clientId, reconnectedA.refresh_token); assert.equal(freshA.status, 200, 'reconnecting creates a separate lineage');
  assert.equal((await refresh(clientId, tokensC.refresh_token)).status, 200, 'the second person survives replay');
  expect(await owner.request('DELETE', `/api/v1/agent-connections/${ownerConnections[0]!.id}`), 204);
  assert.equal((await mcp(freshA.tokens.access_token, 2, 'tools/list')).status, 403);
  assert.equal((await refresh(clientId, freshA.tokens.refresh_token)).status, 400);
  assert.equal((await refresh(clientId, reconnectedA.refresh_token)).status, 400, 'cached rotation response also rechecks revoked authority');
  const freshC = await refresh(clientId, tokensC.refresh_token); assert.equal(freshC.status, 200);
  assert.equal((await mcp(freshC.tokens.access_token, 2, 'tools/list')).status, 200, 'the other person\'s connection is untouched');
  await pool.query('UPDATE oauth_client SET disabled = true WHERE client_id = $1', [clientId]);
  assert.equal((await mcp(freshC.tokens.access_token, 3, 'tools/list')).status, 403, 'a disabled actual OAuth client loses access');
});
