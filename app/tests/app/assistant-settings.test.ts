import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_ASSISTANT_AREAS, PERSONAL_RUN_CONSENT_VERSION, agentConnectionPath, assistantSettingsPath,
  compileAssistantAreas, type AgentConnection, type AssistantSettings, type ProjectAgents } from '@flux/contracts';
import { authorize } from '@flux/core';
import { accessReader } from '@flux/db';
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

test('the assistant\'s tools cover its areas; reserved co-work tools and the project policy are absent', () => {
  const enabled = compileAssistantAreas(DEFAULT_ASSISTANT_AREAS);
  for (const operation of ['doc.create','doc.update','conversation.reply','cowork.unit.create']) assert.ok(enabled.enabledCapabilityIds.includes(operation as never));
  for (const name of ['flux_bootstrap','flux_claim_unit','flux_renew_unit','flux_release_unit','flux_complete_unit','flux_transfer_unit','flux_claim_request','flux_decline_request','flux_resolve_request','flux_send_request','flux_coordination_inbox'])
    assert.ok(!enabled.enabledEntryIds.includes(`tool:${name}`), name);
  assert.ok(!enabled.enabledEntryIds.includes('resource:flux_project_policy'), 'no project agent policy (F-036)');
});

test('#522: private assistant discovery is owner-only while an MCP connection sharing its identity stays visible', async () => {
  const f = await setup('roster-privacy');
  const roster = async (reader: Person) => expectStatus(await reader.browser.request('GET', `/api/v1/projects/${f.managed.id}/agents`), 200) as unknown as ProjectAgents;
  const people = async (reader: Person) => expectStatus(await reader.browser.request('GET', `/api/v1/projects/${f.managed.id}/people`), 200) as { id: string }[];
  const agents = async (reader: Person) => expectStatus(await reader.browser.request('GET', `/api/v1/workspaces/${f.ws.id}/agents`), 200) as { id: string }[];
  const grants = async (reader: Person) => expectStatus(await reader.browser.request('GET', `/api/v1/projects/${f.managed.id}/grants`), 200) as { principal: { kind: string; id: string } }[];
  assert.equal((await grants(f.owner)).some((row) => row.principal.id === f.agent.id), false, 'an assistant has no grant of its own (F-036 AG-3)');
  const own = await roster(f.owner);
  assert.equal(own.connections.length, 1); assert.equal(own.connections[0]?.assistant, true, 'the owner retains its eligible hand-off choice');
  assert.deepEqual((await roster(f.manager)).connections, [], 'even a workspace owner never discovers another person’s assistant connection');
  assert.equal((await people(f.manager)).some((row) => row.id === f.agent.id), false, 'private identity absent from another member’s project people');
  assert.equal((await agents(f.manager)).some((row) => row.id === f.agent.id), false, 'private identity absent from another member’s workspace agent picker');
  assert.equal((await people(f.owner)).some((row) => row.id === f.agent.id), true, 'own identity remains available for own authorized use');
  expectStatus(await f.manager.browser.request('GET', assistantSettingsPath(f.ws.id, f.owner.id)), 404);

  const external = expectStatus(await f.owner.browser.request('POST', '/api/v1/agent-connections', { body: {
    agentId: f.agent.id, selectedProjectIds: [f.managed.id], scopes: ['flux.context.read'], name: 'Ines coding client', clientDesignation: 'codex',
  } }), 201) as { id: string };
  const shared = await roster(f.manager);
  assert.deepEqual(shared.connections.map((row) => row.id), [external.id], 'the explicitly connected MCP client is still public to project members');
  assert.equal(shared.connections[0]?.assistant, undefined);
  assert.equal(shared.connections[0]?.own, false);
  assert.equal(shared.connections[0]?.owner.id, f.owner.id);
  assert.equal((await people(f.manager)).some((row) => row.id === f.agent.id), true, 'public MCP identity is not hidden merely because its owner also selected it for their assistant');
  expectStatus(await f.manager.browser.request('DELETE', `/api/v1/agent-connections/${external.id}`), 404);
});

test('enablement creates one identity and settings with "Do it and tell me"; it reaches exactly what its owner can; engine changes retain it', async () => {
  const f = await setup('identity'); const saved = (await settings(f.owner, f.ws.id)).body;
  assert.equal(saved.mayDo, 'act'); assert.equal(saved.backgroundRunsPerDay, 24);
  assert.deepEqual(Object.keys(saved).sort(), ['agentId', 'backgroundRunsPerDay', 'connectionId', 'createdAt', 'mayDo', 'ownerUserId', 'updatedAt', 'version', 'workspaceId'],
    'no approval mode, switches, change limit or project list (F-036)');
  const row = (await pool.query('SELECT compute_source, may_do FROM agent_connections WHERE id=$1', [saved.connectionId])).rows[0];
  assert.deepEqual([row.compute_source, row.may_do], ['owner_assistant', 'act']);
  assert.equal((await pool.query("SELECT count(*)::int n FROM agent_connections WHERE owner_user_id=$1 AND workspace_id=$2 AND compute_source='owner_assistant'", [f.owner.id, f.ws.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM agent_connection_projects WHERE connection_id=$1', [saved.connectionId])).rows[0].n, 0, 'no stored project list');
  const read = (projectId: string) => authorize({ kind: 'agent', id: f.agent.id }, 'project.read', { type: 'project', id: projectId }, accessReader(db));
  assert.deepEqual(await read(f.managed.id), { allowed: true, visible: true }, 'where its owner can');
  assert.deepEqual(await read(f.blocked.id), { allowed: false, visible: false }, 'never where its owner is kept out');
  const later = await project(f.manager, f.ws.id, 'Later project', 'workspace');
  assert.deepEqual(await read(later.id), { allowed: true, visible: true }, 'a later project its owner can open, at once, with no join');
  const engine = f.connections.connect(f.owner.id, randomUUID(), { provider: 'openai', model: 'fixture-engine' });
  assert.equal((await settings(f.owner, f.ws.id)).body.connectionId, saved.connectionId, 'payer/engine lookup does not replace identity');
  await f.runs.remove(principal(f.owner));
  const changedEngine = await f.runs.enable(principal(f.owner), { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: f.agent.id });
  assert.equal(changedEngine.enablement!.connectionId, engine.id);
  assert.equal(changedEngine.enablement!.consent.provider, 'openai');
  assert.equal((await settings(f.owner, f.ws.id)).body.connectionId, saved.connectionId, 're-enable reuses the one identity');
});

test('only the owner reads the settings and sets "What it may do"; each choice is kept; competing settings saves have one winner', async () => {
  const f = await setup('settings'); const original = (await settings(f.owner, f.ws.id)).body;
  const other = await person('assistant-other'); const admin = await person('assistant-admin');
  await addMember(f.manager, f.ws.id, other, 'member'); await addMember(f.manager, f.ws.id, admin, 'admin');
  const endpoint = assistantSettingsPath(f.ws.id, f.owner.id);
  const mayDo = agentConnectionPath(original.connectionId);
  for (const intruder of [other, admin, f.manager]) {
    expectStatus(await intruder.browser.request('GET', endpoint), 404);
    expectStatus(await intruder.browser.request('PATCH', endpoint, { body: { backgroundRunsPerDay: 3 }, headers: { 'if-match': String(original.version) } }), 404);
    expectStatus(await intruder.browser.request('PATCH', mayDo, { body: { mayDo: 'read' } }), 404);
  }
  for (const choice of ['read', 'ask', 'act'] as const) {
    const saved = expectStatus(await f.owner.browser.request('PATCH', mayDo, { body: { mayDo: choice } }), 200) as unknown as AgentConnection;
    assert.equal(saved.mayDo, choice);
    assert.equal((await settings(f.owner, f.ws.id)).body.mayDo, choice, 'the settings read back what was kept');
  }
  expectStatus(await f.owner.browser.request('PATCH', mayDo, { body: { mayDo: 'everything' } }), 400);
  const scopes = (await pool.query('SELECT scopes FROM agent_connections WHERE id = $1', [original.connectionId])).rows[0].scopes as string[];
  expectStatus(await f.owner.browser.request('PATCH', mayDo, { body: { mayDo: 'act', scopes: [] } }), 200);
  assert.deepEqual((await pool.query('SELECT scopes FROM agent_connections WHERE id = $1', [original.connectionId])).rows[0].scopes, scopes, 'only "What it may do" can be set here');
  const responses = await Promise.all([{ backgroundRunsPerDay: 4 }, { backgroundRunsPerDay: 7 }].map((body) => f.owner.browser.request('PATCH', endpoint,
    { body, headers: { 'if-match': String(original.version) } })));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const winner = responses.find((r) => r.status === 200)!.json as AssistantSettings;
  expectStatus(await f.owner.browser.request('PATCH', endpoint, { body: { backgroundRunsPerDay: 25 }, headers: { 'if-match': String(winner.version) } }), 400);
  for (const removed of [{ approvalMode: 'ask' }, { changesPerRun: 7 }, { areas: { wiki: 'off' } }, { projectMode: 'chosen' }])
    expectStatus(await f.owner.browser.request('PATCH', endpoint, { body: removed, headers: { 'if-match': String(winner.version) } }), 400);
  assert.deepEqual((await settings(f.owner, f.ws.id)).body, winner, 'refused saves change nothing');
});

test('agent principals cannot enter the settings port, even if they copy an owner id', async () => {
  let accessed = false;
  const usecases = assistantSettingsUseCases({
    get: async () => { accessed = true; return null; },
    save: async () => { accessed = true; return null; },
  });
  const ownerId = randomUUID(); const workspaceId = randomUUID();
  await assert.rejects(usecases.get({ kind: 'agent', id: ownerId }, workspaceId, ownerId), /not found/i);
  await assert.rejects(usecases.save({ kind: 'agent', id: ownerId }, workspaceId, ownerId, 1, { backgroundRunsPerDay: 1 }), /not found/i);
  assert.equal(accessed, false, 'no owner data is read before refusing the principal');
});

test('a failure after assistant identity creation rolls back enablement, its connection and settings together', async () => {
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
  void managed;
});


test('"Only read" set from another API process keeps reads, and a bearer credential cannot change "What it may do" or the settings', async () => {
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
  await pool.query('INSERT INTO agent_connection_projects (workspace_id, connection_id, project_id) VALUES ($1, $2, $3)', [f.ws.id, initial.connectionId, f.managed.id]);
  let token: string;
  try {
    token = (await oauthToken(f.owner.browser, initial.connectionId, clientId, redirect,
      await beginOauth(f.owner.browser, clientId, redirect, { scope: `${scopes.join(' ')} offline_access` }))).access_token;
  } finally {
    await pool.query('DELETE FROM agent_connection_projects WHERE connection_id = $1', [initial.connectionId]);
    await pool.query("UPDATE agent_connections SET compute_source='owner_assistant' WHERE id=$1", [initial.connectionId]);
  }
  assert.equal(toolValue((await mcp(token!, 801, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: f.managed.id, id: doc.id } })).message).title, 'Assistant protected Wiki');
  const signedOut = new Browser();
  expectStatus(await signedOut.request('GET', assistantSettingsPath(f.ws.id, f.owner.id), { headers: { authorization: `Bearer ${token!}` } }), 401);
  expectStatus(await signedOut.request('PATCH', assistantSettingsPath(f.ws.id, f.owner.id), {
    headers: { authorization: `Bearer ${token!}`, 'if-match': String(initial.version) }, body: { backgroundRunsPerDay: 1 } }), 401);
  expectStatus(await signedOut.request('PATCH', agentConnectionPath(initial.connectionId), { headers: { authorization: `Bearer ${token!}` }, body: { mayDo: 'act' } }), 401);
  const attempted = await beginOauth(f.owner.browser, clientId, redirect, { scope: `${scopes.join(' ')} offline_access` });
  expectStatus(await f.owner.browser.request('POST', `/api/v1/agent-connections/${initial.connectionId}/select-for-oauth`,
    { body: { oauth_query: attempted.oauthQuery } }), 404);
  // Only read set from the other API process: reads go on (F-036 AG-3: it reads and answers).
  const otherApi = new Browser(process.env.FLUX_API_URL_2 ?? 'http://api2:8080', publicOrigin);
  for (const [name, value] of f.owner.browser.cookies) otherApi.cookies.set(name, value);
  expectStatus(await otherApi.request('PATCH', agentConnectionPath(initial.connectionId), { body: { mayDo: 'read' } }), 200);
  assert.equal(toolValue((await mcp(token!, 803, 'tools/call', { name: 'flux_get_doc', arguments: { projectId: f.managed.id, id: doc.id } })).message).title, 'Assistant protected Wiki');
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

test('F-027 Journey 6: "Tell whoever runs Flux" sends one Needs-you item to the workspace\'s owners, once, and never to the asker', async () => {
  const owner = await person('operator-owner'); const member = await person('operator-member'); const outsider = await person('operator-outsider');
  const ws = await workspace(owner, 'Operated Flux');
  await addMember(owner, ws.id, member, 'member');
  const path = `/api/v1/workspaces/${ws.id}/assistant-operator-requests`;
  const sent = expectStatus(await member.browser.request('POST', path, { body: {} }), 201) as { sent: number };
  assert.equal(sent.sent, 1);
  const inbox = expectStatus(await owner.browser.request('GET', '/api/v1/inbox'), 200) as { items: { title: string; body: string; reason: string }[] };
  const item = inbox.items.find((entry) => entry.title.endsWith('would like to use their Claude plan here'));
  assert.ok(item, JSON.stringify(inbox.items.map((entry) => entry.title)));
  assert.deepEqual([item.reason, item.body], ['question', 'Whoever runs this Flux turns it on with ./flux ai on.']);
  assert.equal((expectStatus(await member.browser.request('POST', path, { body: {} }), 201) as { sent: number }).sent, 0, 'the same ask is not sent twice');
  const codex = expectStatus(await member.browser.request('POST', path, { body: { client: 'codex' } }), 201) as { sent: number };
  assert.equal(codex.sent, 1, 'another plan is another ask');
  assert.equal((expectStatus(await owner.browser.request('POST', path, { body: {} }), 201) as { sent: number }).sent, 0, 'the owner has no one else to tell');
  assert.equal((await outsider.browser.request('POST', path, { body: {} })).status, 404, 'someone outside the workspace learns nothing');
  const mine = expectStatus(await member.browser.request('GET', '/api/v1/inbox'), 200) as { items: { title: string }[] };
  assert.ok(!mine.items.some((entry) => entry.title.includes('would like to use')), 'the asker gets no item of their own');
});

