import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AGENT_MCP_ENTRIES, DEFAULT_ASSISTANT_AREAS, PERSONAL_RUN_CONSENT_VERSION, agentMcpPolicyPath, assistantSettingsPath,
  compileAssistantAreas, type AssistantSettings, type ProjectAgents } from '@flux/contracts';
import { assistantSettingsUseCases, createPersonalRunUseCases, type Principal } from '@flux/core';
import { personalRunUnitOfWork, personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { person, workspace, project, addMember, expectStatus, type Person } from './support/people.js';
import { beginOauth, mcp, oauthToken, toolValue } from './support/mcp.js';
import { Browser, publicOrigin } from './support/http.js';
import { FakeConnections, FakeQueue } from './support/personal-runs.js';
import { barrier, waitUntilBlockedBy } from './support/locks.js';

const principal = (owner: Person): Principal => ({ kind: 'human', id: owner.id });
const settings = async (owner: Person, workspaceId: string, status = 200) => {
  const response = await owner.browser.request('GET', assistantSettingsPath(workspaceId, owner.id));
  return { response, body: expectStatus(response, status) as unknown as AssistantSettings };
};
async function setup(label: string) {
  const manager = await person(`assistant-manager-${label}`);
  const owner = await person(`assistant-${label}`); const ws = await workspace(manager, 'Assistant workspace');
  await addMember(manager, ws.id, owner, 'admin');
  const managed = await project(owner, ws.id, 'Managed project', 'workspace');
  const blocked = await project(manager, ws.id, 'Outside owner scope', 'restricted');
  expectStatus(await manager.browser.request('POST', `/api/v1/projects/${blocked.id}/grants`,
    { body: { principal: { kind: 'human', id: owner.id }, role: 'denied' } }), 201);
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Owner assistant', owner: 'self' } }), 201) as { id: string };
  const connections = new FakeConnections(); const queue = new FakeQueue();
  connections.connect(owner.id, randomUUID());
  const runs = personalRunUseCases(db, { connections, queue: queue.factory, providerEnabled: true });
  await runs.enable(principal(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: agent.id });
  return { owner, manager, ws, managed, blocked, agent, connections, runs };
}

test('five areas map through S6; only read removes effects and reserved co-work tools are absent', () => {
  const enabled = compileAssistantAreas(DEFAULT_ASSISTANT_AREAS);
  for (const operation of ['doc.create','doc.update','conversation.reply','cowork.unit.create']) assert.ok(enabled.enabledCapabilityIds.includes(operation as never));
  for (const name of ['flux_bootstrap','flux_claim_unit','flux_renew_unit','flux_release_unit','flux_complete_unit','flux_transfer_unit','flux_claim_request','flux_decline_request'])
    assert.ok(!enabled.enabledEntryIds.includes(`tool:${name}`), name);
  const read = compileAssistantAreas({ ...DEFAULT_ASSISTANT_AREAS, maps: 'read', wiki: 'off' });
  assert.ok(read.enabledCapabilityIds.includes('project.maps.read'));
  assert.ok(!read.enabledCapabilityIds.includes('project.knowledge.read'));
  assert.ok(!read.enabledEntryIds.includes('tool:flux_get_doc'));
  for (const entry of AGENT_MCP_ENTRIES.filter((e) => e.operation?.startsWith('map.'))) assert.ok(!read.enabledEntryIds.includes(entry.id), entry.name);
});

test('enablement atomically creates one identity/policy/settings, auto-joins only managed projects, and engine changes retain it', async () => {
  const f = await setup('identity'); const saved = (await settings(f.owner, f.ws.id)).body;
  assert.equal(saved.approvalMode, 'act'); assert.equal(saved.changesPerRun, 20); assert.equal(saved.backgroundRunsPerDay, 24);
  assert.deepEqual(saved.areas, DEFAULT_ASSISTANT_AREAS);
  const row = (await pool.query('SELECT compute_source FROM agent_connections WHERE id=$1', [saved.connectionId])).rows[0];
  assert.equal(row.compute_source, 'owner_assistant');
  assert.equal((await pool.query("SELECT count(*)::int n FROM agent_connections WHERE owner_user_id=$1 AND workspace_id=$2 AND compute_source='owner_assistant'", [f.owner.id, f.ws.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT role FROM project_grants WHERE agent_id=$1 AND project_id=$2', [f.agent.id, f.managed.id])).rows[0].role, 'contributor');
  assert.equal((await pool.query('SELECT id FROM project_grants WHERE agent_id=$1 AND project_id=$2', [f.agent.id, f.blocked.id])).rowCount, 0, 'no automatic grant outside the owner’s current manage rights');
  const later = await project(f.owner, f.ws.id, 'Later owned project', 'workspace');
  assert.equal((await pool.query('SELECT role FROM project_grants WHERE agent_id=$1 AND project_id=$2', [f.agent.id, later.id])).rows[0].role, 'contributor');
  assert.ok((await settings(f.owner, f.ws.id)).body.policy.selectedProjectIds.includes(later.id));
  const engine = f.connections.connect(f.owner.id, randomUUID(), { provider: 'openai', model: 'fixture-engine' });
  assert.equal((await settings(f.owner, f.ws.id)).body.connectionId, saved.connectionId, 'payer/engine lookup does not replace identity');
  await f.runs.remove(principal(f.owner));
  const changedEngine = await f.runs.enable(principal(f.owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: f.agent.id });
  assert.equal(changedEngine.enablement!.connectionId, engine.id);
  assert.equal(changedEngine.enablement!.consent.provider, 'openai');
  assert.equal((await settings(f.owner, f.ws.id)).body.connectionId, saved.connectionId, 're-enable reuses the one identity');
});

test('only the owner can read/save, persisted switches are S6, and competing CAS saves have one winner', async () => {
  const f = await setup('settings'); const original = (await settings(f.owner, f.ws.id)).body;
  const other = await person('assistant-other'); const admin = await person('assistant-admin');
  await addMember(f.manager, f.ws.id, other, 'member'); await addMember(f.manager, f.ws.id, admin, 'admin');
  const endpoint = assistantSettingsPath(f.ws.id, f.owner.id);
  for (const intruder of [other, admin]) {
    expectStatus(await intruder.browser.request('GET', endpoint), 404);
    expectStatus(await intruder.browser.request('PATCH', endpoint, { body: { approvalMode: 'ask' }, headers: { 'if-match': String(original.version) } }), 404);
  }
  const changes = { approvalMode: 'ask', areas: { wiki: 'off', maps: 'read' } };
  const responses = await Promise.all([changes, { changesPerRun: 7 }].map((body) => f.owner.browser.request('PATCH', endpoint,
    { body, headers: { 'if-match': String(original.version) } })));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const winner = responses.find((r) => r.status === 200)!.json as AssistantSettings;
  assert.deepEqual((await settings(f.owner, f.ws.id)).body, winner, 'reload returns the saved state');
  expectStatus(await f.owner.browser.request('PATCH', endpoint, { body: { changesPerRun: 21 }, headers: { 'if-match': String(winner.version) } }), 400);
  expectStatus(await f.owner.browser.request('PATCH', endpoint, { body: { backgroundRunsPerDay: 25 }, headers: { 'if-match': String(winner.version) } }), 400);
  expectStatus(await f.owner.browser.request('PATCH', endpoint, { body: { approvalMode: 'ask' } }), 400);
  assert.deepEqual((await settings(f.owner, f.ws.id)).body, winner, 'refused saves change nothing');
  const saved = expectStatus(await f.owner.browser.request('PATCH', endpoint,
    { body: changes, headers: { 'if-match': String(winner.version) } }), 200) as unknown as AssistantSettings;
  assert.equal(saved.approvalMode, 'ask'); assert.equal(saved.areas.wiki, 'off'); assert.equal(saved.areas.maps, 'read');
  const s6 = (await pool.query('SELECT enabled_capability_ids, enabled_entry_ids FROM agent_connection_mcp_policies WHERE connection_id=$1', [saved.connectionId])).rows[0];
  assert.deepEqual(s6.enabled_capability_ids, saved.policy.enabledCapabilityIds);
  assert.ok(!s6.enabled_entry_ids.includes('tool:flux_get_doc')); assert.ok(!s6.enabled_entry_ids.includes('tool:flux_create_map'));
  assert.ok(s6.enabled_entry_ids.includes('tool:flux_get_map'));
});

test('a join request gives no authority, is deduplicated/manager-scoped, and manager Allow uses an ordinary contributor grant', async () => {
  const manager = await person('assistant-join-manager'); const requester = await person('assistant-join-owner'); const bystander = await person('assistant-join-bystander');
  const ws = await workspace(manager, 'Join workspace'); await addMember(manager, ws.id, requester, 'member'); await addMember(manager, ws.id, bystander, 'member');
  const destination = await project(manager, ws.id, 'Join destination', 'workspace');
  const agent = expectStatus(await requester.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Joining assistant', owner: 'self' } }), 201) as { id: string };
  const connections = new FakeConnections(); connections.connect(requester.id, randomUUID()); const queue = new FakeQueue();
  await personalRunUseCases(db, { connections, queue: queue.factory, providerEnabled: true }).enable(principal(requester), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: agent.id });
  const beforeRequest = expectStatus(await requester.browser.request('GET', `/api/v1/projects/${destination.id}/agents`), 200) as unknown as ProjectAgents;
  assert.deepEqual(beforeRequest.assistantJoin, { agentId: agent.id, canRequest: true });
  const endpoint = `/api/v1/projects/${destination.id}/assistant-join-requests`;
  const first = expectStatus(await requester.browser.request('POST', endpoint), 201) as { id: string; state: string };
  const repeated = expectStatus(await requester.browser.request('POST', endpoint), 201) as { id: string };
  assert.equal(first.id, repeated.id); assert.equal(first.state, 'pending');
  assert.equal((await pool.query('SELECT id FROM project_grants WHERE project_id=$1 AND agent_id=$2', [destination.id, agent.id])).rowCount, 0);
  const notifications = (await pool.query("SELECT user_id, reason, body FROM notifications WHERE source_id=$1 AND title LIKE '%assistant asks to join'", [destination.id])).rows;
  assert.deepEqual(notifications, [{ user_id: manager.id, reason: 'question', body: 'Join destination · Requested contributor access.' }]);
  const managerView = expectStatus(await manager.browser.request('GET', `/api/v1/projects/${destination.id}/agents`), 200) as unknown as ProjectAgents;
  assert.equal(managerView.joinRequests?.[0]?.id, first.id);
  const otherView = expectStatus(await bystander.browser.request('GET', `/api/v1/projects/${destination.id}/agents`), 200) as unknown as ProjectAgents;
  assert.equal(otherView.joinRequests, undefined, 'an ordinary reader sees no one else\'s join request');
  assert.equal(otherView.assistantJoin, undefined, 'an ordinary reader sees no one else’s assistant request action');
  expectStatus(await requester.browser.request('POST', `${endpoint}/${first.id}/allow`), 403);
  const granted = expectStatus(await manager.browser.request('POST', `${endpoint}/${first.id}/allow`), 200) as { state: string };
  assert.equal(granted.state, 'accepted');
  assert.equal((await pool.query('SELECT role FROM project_grants WHERE project_id=$1 AND agent_id=$2', [destination.id, agent.id])).rows[0].role, 'contributor');
  assert.ok((await settings(requester, ws.id)).body.policy.selectedProjectIds.includes(destination.id));
  const afterJoin = expectStatus(await requester.browser.request('GET', `/api/v1/projects/${destination.id}/agents`), 200) as unknown as ProjectAgents;
  assert.equal(afterJoin.assistantJoin?.canRequest, false); assert.equal(afterJoin.connections[0]?.assistant, true);
  const hidden = expectStatus(await manager.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Hidden destination', visibility: 'restricted' } }), 201) as { id: string };
  expectStatus(await requester.browser.request('POST', `/api/v1/projects/${hidden.id}/assistant-join-requests`), 404);
});


test('agent principals cannot enter the settings port, even if they copy an owner id', async () => {
  let accessed = false;
  const usecases = assistantSettingsUseCases({
    get: async () => { accessed = true; return null; },
    save: async () => { accessed = true; return null; },
  });
  const ownerId = randomUUID(); const workspaceId = randomUUID();
  await assert.rejects(usecases.get({ kind: 'agent', id: ownerId }, workspaceId, ownerId), /not found/i);
  await assert.rejects(usecases.save({ kind: 'agent', id: ownerId }, workspaceId, ownerId, 1, { approvalMode: 'ask' }), /not found/i);
  assert.equal(accessed, false, 'no owner data is read before refusing the principal');
});

test('a failure after assistant identity creation rolls back enablement, S6 policy and automatic grants together', async () => {
  const owner = await person('assistant-rollback'); const ws = await workspace(owner, 'Rollback workspace');
  const managed = await project(owner, ws.id, 'Rollback project', 'workspace');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Rollback assistant', owner: 'self' } }), 201) as { id: string };
  const connections = new FakeConnections(); connections.connect(owner.id, randomUUID()); const queue = new FakeQueue();
  const real = personalRunUnitOfWork(db, queue.factory);
  const runs = createPersonalRunUseCases({ connections, providerEnabled: true, uow: {
    run: (work) => real.run((ports) => work({ ...ports, assistants: { ...ports.assistants!,
      ensure: async (...args) => { await ports.assistants!.ensure(...args); throw new Error('intentional atomic rollback'); },
    } })),
  } });
  await assert.rejects(runs.enable(principal(owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: agent.id }), /intentional atomic rollback/);
  assert.equal((await pool.query('SELECT 1 FROM personal_run_enablements WHERE owner_user_id=$1', [owner.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM agent_connections WHERE owner_user_id=$1 AND compute_source='owner_assistant'", [owner.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM assistant_settings WHERE owner_user_id=$1', [owner.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM project_grants WHERE project_id=$1 AND agent_id=$2', [managed.id, agent.id])).rowCount, 0);
});


test('assistant S6 switches fence already-produced MCP bytes across two API processes, and bearer credentials cannot save settings', async () => {
  const f = await setup('delivery'); const initial = (await settings(f.owner, f.ws.id)).body;
  const doc = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.managed.id}/docs`,
    { body: { title: 'Assistant protected Wiki', body: 'ASSISTANT-WIKI-PRIVATE-68192' } }), 201) as { id: string };
  const clientId = `assistant-fixture-${randomUUID()}`; const redirect = 'http://127.0.0.1:19740/callback';
  const scopes = ['flux.context.read','flux.proposal.write','flux.action.execute'];
  await pool.query(`INSERT INTO oauth_client (id,client_id,name,redirect_uris,token_endpoint_auth_method,grant_types,response_types,scopes,require_pkce,created_at,updated_at)
    VALUES ($1,$2,'Flux HTTP test client',$3,'none',$4,$5,$6,true,now(),now())`,
  [randomUUID(),clientId,[redirect],['authorization_code','refresh_token'],['code'],[...scopes,'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource(id,client_id,resource_id,created_at) VALUES($1,$2,$3,now())', [randomUUID(),clientId,`${publicOrigin}/mcp`]);
  // Test-only AS fixture: authorize the existing connection with real OAuth/PKCE, then restore its
  // assistant provenance. Ordinary external consent cannot select an owner_assistant connection.
  await pool.query("UPDATE agent_connections SET compute_source='user_operated_external_client' WHERE id=$1", [initial.connectionId]);
  let token: string;
  try {
    token = (await oauthToken(f.owner.browser, initial.connectionId, clientId, redirect,
      await beginOauth(f.owner.browser, clientId, redirect, { scope: `${scopes.join(' ')} offline_access` }))).access_token;
  } finally { await pool.query("UPDATE agent_connections SET compute_source='owner_assistant' WHERE id=$1", [initial.connectionId]); }
  assert.equal(toolValue((await mcp(token!, 801, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: f.managed.id, id: doc.id } })).message).title, 'Assistant protected Wiki');
  const signedOut = new Browser();
  expectStatus(await signedOut.request('GET', assistantSettingsPath(f.ws.id, f.owner.id), { headers: { authorization: `Bearer ${token!}` } }), 401);
  expectStatus(await signedOut.request('PATCH', assistantSettingsPath(f.ws.id, f.owner.id), {
    headers: { authorization: `Bearer ${token!}`, 'if-match': String(initial.version) }, body: { approvalMode: 'ask' } }), 401);
  const attempted = await beginOauth(f.owner.browser, clientId, redirect, { scope: `${scopes.join(' ')} offline_access` });
  expectStatus(await f.owner.browser.request('POST', `/api/v1/agent-connections/${initial.connectionId}/select-for-oauth`,
    { body: { oauth_query: attempted.oauthQuery } }), 404);
  const otherApi = new Browser(process.env.FLUX_API_URL_2 ?? 'http://api2:8080', publicOrigin);
  for (const [name, value] of f.owner.browser.cookies) otherApi.cookies.set(name, value);
  const gate = randomUUID(); const lock = await pool.connect();
  let pending: ReturnType<typeof mcp> | undefined;
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [gate]);
    pending = mcp(token!, 802, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: f.managed.id, id: doc.id } },
      { headers: { 'x-flux-test-delivery-gate': gate } });
    const deadline = Date.now() + 10_000;
    while (!(await pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND mode='ShareLock'")).rowCount) {
      assert.ok(Date.now() < deadline, 'the actual read reached the held transport boundary');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const changed = expectStatus(await otherApi.request('PATCH', assistantSettingsPath(f.ws.id, f.owner.id),
      { body: { areas: { wiki: 'off' } }, headers: { 'if-match': String(initial.version) } }), 200) as unknown as AssistantSettings;
    assert.equal(changed.areas.wiki, 'off');
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [gate]);
    const refused = await pending;
    assert.equal(refused.status, 403, "the other process’s committed setting withholds captured protected bytes");
    assert.ok(!JSON.stringify(refused.message).includes('Assistant protected Wiki'));
    assert.ok(!JSON.stringify(refused.message).includes('ASSISTANT-WIKI-PRIVATE-68192'));
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [gate]).catch(() => undefined);
    if (pending) await pending;
    lock.release();
  }
});


test('settings reads cannot deadlock with a generic S6 writer between its policy and settings updates', async () => {
  const f = await setup('read-order'); const original = (await settings(f.owner, f.ws.id)).body;
  const holder = await pool.connect(); const pending: Promise<unknown>[] = [];
  try {
    await holder.query('BEGIN');
    const holderId = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await holder.query('SELECT connection_id FROM assistant_settings WHERE connection_id=$1 FOR SHARE', [original.connectionId]);
    const writing = f.owner.browser.request('PATCH', agentMcpPolicyPath(original.connectionId), {
      body: { enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] },
      headers: { 'if-match': `"mcp-policy-${original.policy.version}"` },
    });
    pending.push(writing);
    await waitUntilBlockedBy(pool, holderId);
    const writerId = (await pool.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) LIMIT 1', [holderId])).rows[0].pid as number;
    const reading = f.owner.browser.request('GET', assistantSettingsPath(f.ws.id, f.owner.id));
    pending.push(reading);
    await waitUntilBlockedBy(pool, writerId);
    await holder.query('COMMIT');
    const saved = expectStatus(await writing, 200) as { policy: { version: number } };
    const observed = expectStatus(await reading, 200) as unknown as AssistantSettings;
    assert.equal(observed.version, saved.policy.version);
    assert.equal(observed.projectMode, 'chosen');
    assert.ok(Object.values(observed.areas).every((value) => value === 'off'));
  } finally {
    await holder.query('ROLLBACK'); holder.release();
    await Promise.allSettled(pending);
  }
});

test('removal and concurrent enablement take the owner lock before the enablement row', { timeout: 30_000 }, async () => {
  const f = await setup('remove-order'); const queue = new FakeQueue();
  const real = personalRunUnitOfWork(db, queue.factory);
  const held = barrier<number>(); const resume = barrier();
  const pending: Promise<unknown>[] = [];
  const enablingRuns = createPersonalRunUseCases({ connections: f.connections, providerEnabled: true, uow: {
    run: (work) => real.run((ports) => work({ ...ports, assistants: { ...ports.assistants!,
      lockOwner: async (owner) => {
        await ports.assistants!.lockOwner(owner);
        // Identify the actual transaction holding this owner's 64-bit advisory lock.
        const holders = await pool.query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND objsubid=1
          AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295)
          AND objid::bigint=(hashtextextended($1,0)&4294967295)`, [`assistant-owner:${owner}`]);
        assert.equal(holders.rowCount, 1);
        held.resolve(holders.rows[0].pid as number);
        await resume.promise;
      },
    } })),
  } });
  const enabling = enablingRuns.enable(principal(f.owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: f.agent.id })
    .then(() => null, (error: unknown) => error);
  pending.push(enabling);
  try {
    const holderId = await Promise.race([held.promise, enabling.then(() => { throw new Error('Enablement ended before the lock barrier'); })]);
    const removing = f.runs.remove(principal(f.owner)).then(() => null, (error: unknown) => error);
    pending.push(removing);
    await waitUntilBlockedBy(pool, holderId);
    resume.resolve();
    const [enableError, removeError] = await Promise.all([enabling, removing]);
    assert.equal((enableError as { code?: string } | null)?.code, 'PERSONAL_RUN_ALREADY_ENABLED',
      'enablement keeps its ordinary conflict instead of becoming a PostgreSQL deadlock victim');
    assert.equal(removeError, null, 'removal completes after enablement releases the owner lock');
    assert.equal((await pool.query('SELECT 1 FROM personal_run_enablements WHERE owner_user_id=$1', [f.owner.id])).rowCount, 0);
    const retained = (await pool.query(`SELECT c.revoked_at FROM assistant_settings s
      JOIN agent_connections c ON c.id=s.connection_id WHERE s.owner_user_id=$1`, [f.owner.id])).rows;
    assert.equal(retained.length, 1, 'removal preserves the workspace assistant identity and settings');
    assert.notEqual(retained[0].revoked_at, null, 'the retained connection has no active authority');
    assert.equal((await pool.query("SELECT 1 FROM agent_connections WHERE owner_user_id=$1 AND compute_source='owner_assistant' AND revoked_at IS NULL", [f.owner.id])).rowCount, 0);
  } finally {
    resume.resolve();
    await Promise.allSettled(pending);
  }
});
