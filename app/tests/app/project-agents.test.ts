import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { ProjectAgents } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { expect, toolValue } from './support/mcp.js';
import { actionScene } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, person } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

// The Agents view (UI116-2, #136) lists every current connection selected for a project, whoever
// owns it, with a state Flux can prove: never signed in, offline, or an open client session.

test('project readers see every current connection with owner, client and truthful state; outsiders see nothing', async () => {
  const f = await actionScene(pool);
  const ownerName = (await pool.query('SELECT name FROM auth_users WHERE id=(SELECT owner_user_id FROM agent_connections WHERE id=$1)', [f.connectionId])).rows[0].name as string;
  const second = expect(await f.owner.request('POST', '/api/v1/agent-connections', { body: { agentId: f.agentId,
    selectedProjectIds: [f.projectId], scopes: ['flux.context.read'], name: 'Codex laptop', clientDesignation: 'codex' } }), 201);
  const read = async (browser: typeof f.owner) => expectStatus(await browser.request('GET', `/api/v1/projects/${f.projectId}/agents`), 200) as ProjectAgents;

  const own = await read(f.owner);
  assert.equal(own.projectId, f.projectId);
  const byId = new Map(own.connections.map((item) => [item.id, item]));
  assert.equal(own.connections.length, 2);
  const active = byId.get(f.connectionId)!;
  assert.equal(active.state, 'session_open');
  assert.equal(active.own, true);
  assert.deepEqual(active.owner, { id: active.owner.id, name: ownerName });
  assert.deepEqual(active.agent, { id: f.agentId, name: 'Planning agent' });
  assert.ok(active.session && Date.parse(active.session.expiresAt) > Date.now());
  assert.equal(active.lastActivity, null);
  const configured = byId.get(String(second.id))!;
  assert.deepEqual({ state: configured.state, name: configured.name, client: configured.clientDesignation, session: configured.session },
    { state: 'not_signed_in', name: 'Codex laptop', client: 'codex', session: null });
  // Nothing beyond identity and state reaches the browser.
  assert.deepEqual(Object.keys(active).sort(), ['agent', 'clientDesignation', 'id', 'lastActivity', 'name', 'own', 'owner', 'session', 'state']);

  const workspaceId = f.workspaceId;
  const member = await person('Marek');
  const ownerPerson = { id: active.owner.id, email: '', browser: f.owner };
  await addMember(ownerPerson, workspaceId, member, 'member');
  assert.equal((await member.browser.request('GET', `/api/v1/projects/${f.projectId}/agents`)).status, 404, 'restricted project before a grant');
  await grant(ownerPerson, f.projectId, member, 'viewer');
  const seen = await read(member.browser);
  assert.deepEqual(seen.connections.map((item) => [item.id, item.own, item.state]).sort(),
    [[f.connectionId, false, 'session_open'], [String(second.id), false, 'not_signed_in']].sort());

  const outsider = await person('Outsider');
  const denied = await outsider.browser.request('GET', `/api/v1/projects/${f.projectId}/agents`);
  assert.equal(denied.status, 404);
  assert.equal((denied.json as { code: string }).code, 'PROJECT_NOT_FOUND');
  assert.equal((await outsider.browser.request('GET', '/api/v1/projects/not-a-uuid/agents')).status, 404);
});

test('a completed native action becomes the last activity; closing the session leaves the connection offline', async () => {
  const f = await actionScene(pool);
  const create = await f.grant('work.create', 'plan');
  const created = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
    grantId: create.id, clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [f.source],
    task: { title: 'Measure the remote lamp', criteria: ['Both readings are recorded'] } }));
  assert.equal(created.replayed, false);
  assert.ok(created.workId);
  const after = expectStatus(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/agents`), 200) as ProjectAgents;
  const activity = after.connections.find((item) => item.id === f.connectionId)!.lastActivity;
  assert.equal(activity?.operation, 'work.create');
  assert.ok(activity && Math.abs(Date.parse(activity.at) - Date.now()) < 60_000);

  await pool.query('UPDATE agent_runtime_sessions SET revoked_at=now() WHERE connection_id=$1', [f.connectionId]);
  const closed = expectStatus(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/agents`), 200) as ProjectAgents;
  const offline = closed.connections.find((item) => item.id === f.connectionId)!;
  assert.deepEqual({ state: offline.state, session: offline.session, operation: offline.lastActivity?.operation },
    { state: 'offline', session: null, operation: 'work.create' });
});

test('a revoked connection or an agent without project access is not listed', async () => {
  const f = await actionScene(pool);
  const other = expect(await f.owner.request('POST', '/api/v1/agent-connections', { body: { agentId: f.agentId,
    selectedProjectIds: [f.projectId], scopes: ['flux.context.read'], name: 'Spare client' } }), 201);
  const list = async () => (expectStatus(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/agents`), 200) as ProjectAgents)
    .connections.map((item) => item.id).sort();
  assert.deepEqual(await list(), [f.connectionId, String(other.id)].sort());
  expectStatus(await f.owner.request('DELETE', `/api/v1/agent-connections/${other.id}`), 204);
  assert.deepEqual(await list(), [f.connectionId]);
  expectStatus(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/grants`,
    { body: { principal: { kind: 'agent', id: f.agentId }, role: 'denied' } }), 201);
  assert.deepEqual(await list(), []);
});
