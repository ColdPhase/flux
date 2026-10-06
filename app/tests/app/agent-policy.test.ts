import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { agentPolicyDigest, renderAgentPolicy } from '@flux/core';
import { agentProjectPolicyUri, type AgentPolicyReference, type AgentProjectPolicy } from '@flux/contracts';
import { pool } from './support/db.js';
import { apiUrl, publicOrigin, register, uniqueEmail, type Browser } from './support/http.js';
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

  test('a project id written in upper case names the same canonical policy and digest (#214 review B1)', async () => {
    const { policy: seen } = expect(await viewer.request('GET', path()), 200) as { policy: AgentProjectPolicy };
    const upper = `/api/v1/projects/${projectId.toUpperCase()}/agent-policy`;
    const published = expect(await owner.request('PUT', upper, { body: body(seen.revision, 'Published through an upper-case address') }), 201) as unknown as AgentProjectPolicy;
    assert.equal(published.projectId, projectId, 'the canonical lowercase id');
    assert.equal(published.digest, agentPolicyDigest(published), 'the digest binds the identity readers get back');
    assert.deepEqual(expect(await viewer.request('GET', upper), 200), { policy: published });
    assert.deepEqual(expect(await viewer.request('GET', path()), 200), { policy: published });
    // The next test's bootstrap reference and resource read this same newest revision.
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
    assert.equal(current.digest, agentPolicyDigest(current), 'the newest revision (published through an upper-case address) is self-consistent');
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

// The Agents view's policy editor (#160 T160-b) publishes with this same request: the revision it loaded as
// `expectedRevision` and one Idempotency-Key per attempt. What an agent is told comes from bootstrap, so these
// tests follow one connected agent's bootstrap, in one resumed client session, across the editor's publishes.
describe('publishing from the policy editor reaches the agent\'s next bootstrap', () => {
  let owner: Browser; let admin: Browser; let contributor: Browser; let viewer: Browser; let member: Browser;
  let projectId: string; let accessToken: string;
  const clientSessionId = randomUUID();
  let call = 600;
  const path = () => `/api/v1/projects/${projectId}/agent-policy`;
  const edit = (expectedRevision: number, scope: string) => ({ scope, priorities: 'The motion sensor before the light curve.',
    reviewCriteria: 'Every change names the test that shows it works.', allowedWork: 'Tasks, results and docs; no releases.', expectedRevision });
  const publish = (who: Browser, body: unknown) => who.request('PUT', path(), { body, headers: { 'idempotency-key': randomUUID() } });
  const current = async () => (expect(await viewer.request('GET', path()), 200) as { policy: AgentProjectPolicy | null }).policy;
  /** The agent resuming the same client session, as it does at a safe checkpoint. */
  const bootstrap = async () => {
    const value = toolValue((await mcp(accessToken, call++, 'tools/call', { name: 'flux_bootstrap', arguments: { projectId, clientSessionId } })).message);
    return { runtime: (value.runtime as { id: string }).id, approved: (value.trusted as { approvedPolicy: AgentPolicyReference | null }).approvedPolicy,
      gaps: value.gaps as string[] };
  };
  const resource = async (revision: number) => {
    const read = await mcp(accessToken, call++, 'resources/read', { uri: agentProjectPolicyUri(projectId, revision) });
    assert.equal(read.status, 200);
    return (read.message!.result as { contents: { text: string }[] }).contents[0]!.text;
  };
  const reference = (policy: AgentProjectPolicy): AgentPolicyReference => ({ policyId: `${projectId}:agent-policy`, revision: policy.revision,
    digest: policy.digest, retrievalReference: agentProjectPolicyUri(projectId, policy.revision) });
  /** The approved policy, publishing a first revision if none exists yet, so each test after the first stands alone. */
  const startingPoint = async () => (await current())
    ?? (expect(await publish(owner, edit(0, 'A starting point.')), 201) as unknown as AgentProjectPolicy);

  before(async () => {
    owner = (await register(uniqueEmail('editor-owner'), password)).browser;
    const people: Record<string, { browser: Browser; id: string }> = {};
    for (const label of ['admin', 'contributor', 'viewer', 'member']) {
      const { browser } = await register(uniqueEmail(`editor-${label}`), password);
      people[label] = { browser, id: (expect(await browser.request('GET', '/api/v1/me'), 200).user as { id: string }).id };
    }
    ({ admin, contributor, viewer, member } = Object.fromEntries(Object.entries(people).map(([label, person]) => [label, person.browser])) as
      Record<'admin' | 'contributor' | 'viewer' | 'member', Browser>);
    const workspaceId = String(expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Editor workspace' } }), 201).id);
    // A workspace admin manages every project without owning the workspace; the others are plain members.
    expect(await owner.request('POST', `/api/v1/workspaces/${workspaceId}/members`, { body: { userId: people.admin!.id, role: 'admin' } }), 201);
    for (const label of ['contributor', 'viewer', 'member']) {
      expect(await owner.request('POST', `/api/v1/workspaces/${workspaceId}/members`, { body: { userId: people[label]!.id, role: 'member' } }), 201);
    }
    projectId = String(expect(await owner.request('POST', `/api/v1/workspaces/${workspaceId}/projects`, { body: { name: 'Porch light', visibility: 'restricted' } }), 201).id);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: people.contributor!.id }, role: 'contributor' } }), 201);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: people.viewer!.id }, role: 'viewer' } }), 201);
    const agentId = String(expect(await owner.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name: 'Porch agent', owner: 'self' } }), 201).id);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    const connection = expect(await owner.request('POST', '/api/v1/agent-connections',
      { body: { agentId, selectedProjectIds: [projectId], scopes: ['flux.context.read'] } }), 201);
    const clientId = `flux-test-${randomUUID()}`;
    const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
      response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['flux.context.read', 'offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
    accessToken = (await oauthToken(owner, String(connection.id), clientId, redirectUri,
      await beginOauth(owner, clientId, redirectUri, { scope: 'flux.context.read offline_access' }))).access_token;
  });

  test('a manager publishes; the same session\'s next bootstrap names the new revision, and every revision stays readable', async () => {
    const start = await bootstrap();
    assert.equal(start.approved, null, 'nothing published yet');
    assert.ok(start.gaps.includes('approved_policy_unavailable'));

    // A workspace admin, not the owner, publishes the first revision from "none" (0).
    const first = expect(await publish(admin, edit(0, 'The porch light firmware only.')), 201) as unknown as AgentProjectPolicy;
    assert.equal(first.revision, 1);
    assert.equal(first.digest, agentPolicyDigest(first));
    const afterFirst = await bootstrap();
    assert.equal(afterFirst.runtime, start.runtime, 'the same resumed runtime');
    assert.deepEqual(afterFirst.approved, reference(first), 'its next bootstrap names revision 1');
    assert.ok(!afterFirst.gaps.includes('approved_policy_unavailable'));

    // The owner edits the revision they loaded.
    const loaded = (await current())!;
    assert.deepEqual(loaded, first);
    const second = expect(await publish(owner, edit(loaded.revision, 'The porch light firmware and its PIR mount.')), 201) as unknown as AgentProjectPolicy;
    assert.equal(second.revision, 2);
    assert.notEqual(second.digest, first.digest);
    const afterSecond = await bootstrap();
    assert.equal(afterSecond.runtime, start.runtime);
    assert.deepEqual(afterSecond.approved, reference(second), 'and after the edit it names revision 2, not 1');
    assert.equal(await resource(2), renderAgentPolicy(second));
    assert.ok((await resource(2)).includes('The porch light firmware and its PIR mount.'));
    assert.equal(await resource(1), renderAgentPolicy(first), 'the earlier revision is kept unchanged for comparison');
  });

  test('a contributor, a viewer, a member without access and the agent itself are refused and change nothing', async () => {
    const before = await startingPoint();
    const told = await bootstrap();
    for (const [who, label] of [[contributor, 'contributor'], [viewer, 'viewer']] as const) {
      const refused = await publish(who, edit(before.revision, `A ${label}'s scope`));
      assert.deepEqual([refused.status, (refused.json as { code: string }).code], [403, 'FORBIDDEN'], `a ${label} reads the policy but cannot publish it`);
    }
    // A workspace member with no grant on this restricted project learns nothing about it.
    assert.equal((await member.request('GET', path())).status, 404);
    assert.equal((await publish(member, edit(before.revision, 'A member\'s scope'))).status, 404);
    // The agent's own bearer is not a session: the HTTP publish refuses it before any policy check.
    const asAgent = await fetch(new URL(path(), apiUrl), { method: 'PUT', headers: { authorization: `Bearer ${accessToken}`, origin: publicOrigin,
      'content-type': 'application/json' }, body: JSON.stringify(edit(before.revision, 'An agent\'s own scope')) });
    assert.equal(asAgent.status, 401);
    assert.deepEqual(await current(), before, 'the approved policy is unchanged');
    assert.deepEqual((await bootstrap()).approved, told.approved, 'and the agent is told the same revision');
    const stored = await pool.query('SELECT count(*)::int AS n FROM agent_project_policies WHERE project_id=$1', [projectId]);
    assert.equal(stored.rows[0].n, before.revision, 'no revision was added');
  });

  test('an invalid policy is refused with a specific reason and changes nothing', async () => {
    const before = await startingPoint();
    const told = await bootstrap();
    const blank = await publish(owner, { scope: '  ', priorities: '\n', reviewCriteria: '', allowedWork: '\t', expectedRevision: before.revision });
    assert.deepEqual([blank.status, (blank.json as { code: string }).code], [400, 'POLICY_EMPTY'], 'whitespace is not a policy');
    const long = await publish(owner, { ...edit(before.revision, 'Fine'), priorities: 'p'.repeat(4001) });
    assert.equal(long.status, 400);
    assert.match(String((long.json as { message: string }).message), /priorities.*4000 characters/, 'the reason names the part and the limit');
    const missing: Partial<ReturnType<typeof edit>> = edit(before.revision, 'unused');
    delete missing.scope;
    assert.equal((await publish(owner, missing)).status, 400, 'every part is sent, even an empty one');
    assert.equal((await publish(owner, { ...edit(before.revision, 'Negative'), expectedRevision: -1 })).status, 400);
    assert.equal((await publish(owner, { ...edit(before.revision, 'Fraction'), expectedRevision: 1.5 })).status, 400);
    assert.deepEqual(await current(), before);
    assert.deepEqual((await bootstrap()).approved, told.approved);
  });

  test('two managers editing the same revision: the second gets a version conflict with the newer policy, then publishes over it knowingly', async () => {
    const loaded = await startingPoint();
    // Both opened the editor on the same revision. The admin publishes first.
    const theirs = expect(await publish(admin, edit(loaded.revision, 'The admin\'s scope')), 201) as unknown as AgentProjectPolicy;
    const stale = await publish(owner, edit(loaded.revision, 'The owner\'s scope'));
    assert.equal(stale.status, 409);
    const conflict = stale.json as { code: string; currentVersion: number; current: AgentProjectPolicy };
    assert.deepEqual([conflict.code, conflict.currentVersion], ['VERSION_CONFLICT', theirs.revision]);
    assert.deepEqual(conflict.current, theirs, 'the conflict carries the newer policy for the editor to show');
    assert.deepEqual((await bootstrap()).approved, reference(theirs), 'the refused edit never reached the agent');
    // The owner read it and publishes their text over the revision they were shown.
    const mine = expect(await publish(owner, edit(conflict.currentVersion, 'The owner\'s scope')), 201) as unknown as AgentProjectPolicy;
    assert.equal(mine.revision, theirs.revision + 1);
    assert.deepEqual((await bootstrap()).approved, reference(mine));
    assert.equal(await resource(theirs.revision), renderAgentPolicy(theirs), 'the admin\'s revision is kept');
  });
});
