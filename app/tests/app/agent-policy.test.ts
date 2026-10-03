import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { agentPolicyDigest, renderAgentPolicy } from '@flux/core';
import { agentProjectPolicyUri, type AgentProjectPolicy } from '@flux/contracts';
import { pool } from './support/db.js';
import { publicOrigin, register, uniqueEmail, type Browser } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken, toolValue } from './support/mcp.js';

// The approved project policy for connected agents (#160 AC-1, F-018 CW-1): only a project manager publishes
// a revision; readers and connected agents read it; bootstrap names the newest revision and its digest.

const password = 'correct horse battery staple';
const body = (expectedRevision: number, scope = 'Firmware for the night lamp only.') =>
  ({ scope, priorities: 'Low-light sensing first.', reviewCriteria: 'Every change names its test.', allowedWork: 'Tasks and results; no releases.', expectedRevision });

describe('approved project policy', () => {
  let owner: Browser; let contributor: Browser; let viewer: Browser; let outsider: Browser;
  let workspaceId: string; let projectId: string; let agentId: string;
  const path = () => `/api/v1/projects/${projectId}/agent-policy`;

  before(async () => {
    owner = (await register(uniqueEmail('policy-owner'), password)).browser;
    const people: { browser: Browser; id: string }[] = [];
    for (const label of ['policy-contributor', 'policy-viewer', 'policy-outsider']) {
      const { browser } = await register(uniqueEmail(label), password);
      people.push({ browser, id: (expect(await browser.request('GET', '/api/v1/me'), 200).user as { id: string }).id });
    }
    [contributor, viewer, outsider] = people.map((person) => person.browser) as [Browser, Browser, Browser];
    const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Policy workspace' } }), 201);
    workspaceId = String(workspace.id);
    for (const person of people.slice(0, 2)) {
      expect(await owner.request('POST', `/api/v1/workspaces/${workspaceId}/members`, { body: { userId: person.id, role: 'member' } }), 201);
    }
    const project = expect(await owner.request('POST', `/api/v1/workspaces/${workspaceId}/projects`, { body: { name: 'Night lamp', visibility: 'restricted' } }), 201);
    projectId = String(project.id);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: people[0]!.id }, role: 'contributor' } }), 201);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: people[1]!.id }, role: 'viewer' } }), 201);
    agentId = String(expect(await owner.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name: 'Policy agent', owner: 'self' } }), 201).id);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
  });

  test('only a project manager publishes; readers read it; revisions are compare-and-set and kept', async () => {
    assert.deepEqual(expect(await viewer.request('GET', path()), 200), { policy: null }, 'nothing published yet');
    assert.equal((await outsider.request('GET', path())).status, 404, 'an outsider learns nothing');
    assert.equal((await contributor.request('PUT', path(), { body: body(0) })).status, 403, 'a contributor cannot publish');
    assert.equal((await viewer.request('PUT', path(), { body: body(0) })).status, 403);
    assert.equal((await outsider.request('PUT', path(), { body: body(0) })).status, 404);
    assert.equal((await owner.request('PUT', path(), { body: { ...body(0), scope: 'x'.repeat(4001) } })).status, 400);
    const empty = await owner.request('PUT', path(), { body: { scope: ' ', priorities: '', reviewCriteria: '', allowedWork: '', expectedRevision: 0 } });
    assert.equal((empty.json as { code: string }).code, 'POLICY_EMPTY');

    const first = expect(await owner.request('PUT', path(), { body: body(0) }), 201) as unknown as AgentProjectPolicy;
    assert.equal(first.revision, 1);
    assert.equal(first.digest, agentPolicyDigest({ projectId, revision: 1, ...body(0) }));
    assert.deepEqual(expect(await viewer.request('GET', path()), 200), { policy: first }, 'every project reader sees the approved policy');
    const stale = await owner.request('PUT', path(), { body: body(0, 'A stale edit') });
    assert.equal(stale.status, 409);
    assert.deepEqual([(stale.json as { code: string }).code, (stale.json as { currentVersion: number }).currentVersion], ['VERSION_CONFLICT', 1]);
    const second = expect(await owner.request('PUT', path(), { body: body(1, 'Firmware and the PIR mount.') }), 201) as unknown as AgentProjectPolicy;
    assert.equal(second.revision, 2);
    assert.notEqual(second.digest, first.digest);
    const stored = await pool.query('SELECT revision, scope FROM agent_project_policies WHERE project_id=$1 ORDER BY revision', [projectId]);
    assert.deepEqual(stored.rows, [{ revision: 1, scope: 'Firmware for the night lamp only.' }, { revision: 2, scope: 'Firmware and the PIR mount.' }],
      'every revision is kept unchanged');
    const events = await pool.query("SELECT data FROM events WHERE kind='project.agent_policy_published.v1' AND object_id=$1 ORDER BY seq", [projectId]);
    assert.deepEqual(events.rows.map((row) => row.data), [{ revision: 1 }, { revision: 2 }], 'events carry the revision, never the text');
    // A lost answer to a publish is retried with the same key and gets the same revision back.
    const key = randomUUID();
    const retried = [await owner.request('PUT', path(), { body: body(2, 'Third'), headers: { 'idempotency-key': key } }),
      await owner.request('PUT', path(), { body: body(2, 'Third'), headers: { 'idempotency-key': key } })];
    assert.deepEqual(retried.map((response) => [response.status, (response.json as { revision: number }).revision]), [[201, 3], [201, 3]]);
    assert.deepEqual(retried.map((response) => response.headers.get('idempotent-replayed')), [null, 'true']);
    // Length is counted in characters: 4,000 emoji fit, 4,001 do not.
    assert.equal((await owner.request('PUT', path(), { body: { ...body(3), scope: '🪔'.repeat(4000) } })).status, 201);
    assert.equal((await owner.request('PUT', path(), { body: { ...body(4), scope: '🪔'.repeat(4001) } })).status, 400);
  });

  test('a publish with an Idempotency-Key commits with its key or not at all (#214 review B1)', async () => {
    const before = expect(await viewer.request('GET', path()), 200) as { policy: AgentProjectPolicy };
    const key = randomUUID();
    // Only this test's key is refused when the key is stored: the publish must roll back with it.
    const constraint = `policy_key_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`ALTER TABLE idempotency_keys ADD CONSTRAINT ${constraint} CHECK (key <> '${key}') NOT VALID`);
    try {
      const failed = await owner.request('PUT', path(), { body: body(before.policy!.revision, 'Never committed'), headers: { 'idempotency-key': key } });
      assert.equal(failed.status, 500);
    } finally {
      await pool.query(`ALTER TABLE idempotency_keys DROP CONSTRAINT ${constraint}`);
    }
    const after = expect(await viewer.request('GET', path()), 200) as { policy: AgentProjectPolicy };
    assert.deepEqual(after, before, 'no revision was committed without its key');
    const retried = await owner.request('PUT', path(), { body: body(before.policy!.revision, 'Never committed'), headers: { 'idempotency-key': key } });
    assert.deepEqual([retried.status, (retried.json as { revision: number }).revision], [201, before.policy!.revision + 1], 'the retry publishes once');
  });

  test('two managers publishing the same revision at once: one wins, the other gets the current revision', async () => {
    const { policy: seen } = expect(await viewer.request('GET', path()), 200) as { policy: AgentProjectPolicy };
    const race = await Promise.all(['First manager', 'Second manager'].map((scope) => owner.request('PUT', path(), { body: body(seen.revision, scope) })));
    assert.deepEqual(race.map((response) => response.status).sort(), [201, 409]);
    const lost = race.find((response) => response.status === 409)!.json as { code: string; currentVersion: number };
    assert.deepEqual([lost.code, lost.currentVersion], ['VERSION_CONFLICT', seen.revision + 1]);
  });

  test('bootstrap names the approved revision and a connected agent reads it as a resource', async () => {
    const connection = expect(await owner.request('POST', '/api/v1/agent-connections',
      { body: { agentId, selectedProjectIds: [projectId], scopes: ['flux.context.read'] } }), 201);
    const clientId = `flux-test-${randomUUID()}`;
    const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
      response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
    const tokens = await oauthToken(owner, String(connection.id), clientId, redirectUri, await beginOauth(owner, clientId, redirectUri, { scope: 'flux.context.read offline_access' }));
    const current = (expect(await viewer.request('GET', path()), 200) as { policy: AgentProjectPolicy }).policy;
    const bootstrap = toolValue((await mcp(tokens.access_token, 401, 'tools/call', { name: 'flux_bootstrap',
      arguments: { projectId, clientSessionId: randomUUID() } })).message);
    const trusted = bootstrap.trusted as { approvedPolicy: unknown };
    assert.deepEqual(trusted.approvedPolicy, { policyId: `${projectId}:agent-policy`, revision: current.revision, digest: current.digest,
      retrievalReference: agentProjectPolicyUri(projectId, current.revision) });
    assert.ok(!(bootstrap.gaps as string[]).includes('approved_policy_unavailable'), 'a published policy is no longer a gap');
    const read = await mcp(tokens.access_token, 402, 'resources/read', { uri: agentProjectPolicyUri(projectId, current.revision) });
    assert.equal(read.status, 200);
    const contents = (read.message!.result as { contents: { uri: string; mimeType: string; text: string }[] }).contents;
    assert.deepEqual(contents.map(({ uri, mimeType }) => [uri, mimeType]), [[agentProjectPolicyUri(projectId, current.revision), 'text/markdown']]);
    assert.equal(contents[0]!.text, renderAgentPolicy(current));
    assert.ok(contents[0]!.text.includes('never widens them'));
    // An earlier revision stays readable for comparison; one that does not exist is refused.
    const earlier = await mcp(tokens.access_token, 403, 'resources/read', { uri: agentProjectPolicyUri(projectId, 1) });
    assert.ok(((earlier.message!.result as { contents: { text: string }[] }).contents[0]!.text).includes('revision 1'));
    const missing = await mcp(tokens.access_token, 404, 'resources/read', { uri: agentProjectPolicyUri(projectId, 99) });
    assert.ok(missing.message?.error, 'no such revision');
    for (const [id, revision] of [[405, '01'], [406, '1e0'], [407, '1.0'], [408, '99999999999'], [409, '0']] as const) {
      const odd = await mcp(tokens.access_token, id, 'resources/read', { uri: `flux://policy/${projectId}/${revision}` });
      assert.ok(odd.message?.error, `revision "${revision}" names nothing`);
    }

    // Another project of the same workspace, with its own policy and the same agent granted, is not
    // readable through a connection that did not select it.
    const other = String(expect(await owner.request('POST', `/api/v1/workspaces/${workspaceId}/projects`, { body: { name: 'Bike light', visibility: 'restricted' } }), 201).id);
    expect(await owner.request('POST', `/api/v1/projects/${other}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    expect(await owner.request('PUT', `/api/v1/projects/${other}/agent-policy`, { body: body(0, 'Bike light only') }), 201);
    const unselected = await mcp(tokens.access_token, 410, 'resources/read', { uri: agentProjectPolicyUri(other, 1) });
    assert.ok(unselected.message?.error && !JSON.stringify(unselected.message).includes('Bike light only'), 'an unselected project is refused');

    // A viewer agent reads project context, so it reads the policy; a denied agent reads nothing.
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'viewer' } }), 201);
    const asViewer = await mcp(tokens.access_token, 411, 'resources/read', { uri: agentProjectPolicyUri(projectId, current.revision) });
    assert.equal((asViewer.message!.result as { contents: { text: string }[] }).contents[0]!.text, renderAgentPolicy(current));
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'denied' } }), 201);
    const denied = await mcp(tokens.access_token, 412, 'resources/read', { uri: agentProjectPolicyUri(projectId, current.revision) });
    assert.ok(denied.status !== 200 || denied.message?.error, 'a denied agent reads no policy');
    assert.ok(!JSON.stringify(denied.message ?? {}).includes(current.scope));
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);

    // Revoking the connection removes the resource with every other MCP surface.
    expect(await owner.request('DELETE', `/api/v1/agent-connections/${connection.id}`), 204);
    assert.equal((await mcp(tokens.access_token, 413, 'resources/read', { uri: agentProjectPolicyUri(projectId, current.revision) })).status, 403);
  });
});
