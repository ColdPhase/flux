import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { ProjectAgents } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { expect } from './support/mcp.js';
import { actionScene } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, removeFromSpace, person } from './support/people.js';

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
  assert.deepEqual(Object.keys(active).sort(), ['agent', 'clientDesignation', 'currentWork', 'id', 'lastActivity', 'mayDo', 'name', 'own', 'owner', 'recentActivity', 'requests', 'scopes', 'session', 'state']);
  assert.deepEqual([active.currentWork, active.requests], [null, []], 'no unit or open request until one is created (#160 AC-5)');

  const workspaceId = f.workspaceId;
  const member = await person('Marek');
  const ownerPerson = { id: active.owner.id, email: '', browser: f.owner };
  await addMember(ownerPerson, workspaceId, member, 'member');
  assert.equal((await member.browser.request('GET', `/api/v1/projects/${f.projectId}/agents`)).status, 404, 'restricted project before a grant');
  await grant(ownerPerson, f.projectId, member, 'contributor');
  const seen = await read(member.browser);
  assert.deepEqual(seen.connections.map((item) => [item.id, item.own, item.state]).sort(),
    [[f.connectionId, false, 'session_open'], [String(second.id), false, 'not_signed_in']].sort());

  const outsider = await person('Outsider');
  const denied = await outsider.browser.request('GET', `/api/v1/projects/${f.projectId}/agents`);
  assert.equal(denied.status, 404);
  assert.equal((denied.json as { code: string }).code, 'PROJECT_NOT_FOUND');
  assert.equal((await outsider.browser.request('GET', '/api/v1/projects/not-a-uuid/agents')).status, 404);
});

test('a revoked connection or a revoked agent is not listed', async () => {
  const f = await actionScene(pool);
  const other = expect(await f.owner.request('POST', '/api/v1/agent-connections', { body: { agentId: f.agentId,
    selectedProjectIds: [f.projectId], scopes: ['flux.context.read'], name: 'Spare client' } }), 201);
  const list = async () => (expectStatus(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/agents`), 200) as ProjectAgents)
    .connections.map((item) => item.id).sort();
  assert.deepEqual(await list(), [f.connectionId, String(other.id)].sort());
  expectStatus(await f.owner.request('DELETE', `/api/v1/agent-connections/${other.id}`), 204);
  assert.deepEqual(await list(), [f.connectionId]);
  expectStatus(await f.owner.request('DELETE', `/api/v1/agents/${f.agentId}`), 200);
  assert.deepEqual(await list(), []);
});

test('choosing a connection on the consent page is not an authorization; an expired or rotated session is offline', async () => {
  const f = await actionScene(pool);
  const chosen = expect(await f.owner.request('POST', '/api/v1/agent-connections', { body: { agentId: f.agentId,
    selectedProjectIds: [f.projectId], scopes: ['flux.context.read'], name: 'Chosen, never consented' } }), 201);
  // What select-for-oauth leaves behind when the person then denies or closes consent: a binding, no token.
  const clientId = (await pool.query('SELECT client_id FROM agent_oauth_bindings WHERE connection_id=$1', [f.connectionId])).rows[0].client_id as string;
  await pool.query('INSERT INTO agent_oauth_bindings (id, owner_user_id, connection_id, client_id) SELECT $1, owner_user_id, id, $2 FROM agent_connections WHERE id=$3',
    [randomUUID(), clientId, chosen.id]);
  const state = async (id: string) => (expectStatus(await f.owner.request('GET', `/api/v1/projects/${f.projectId}/agents`), 200) as ProjectAgents)
    .connections.find((item) => item.id === id)!.state;
  assert.equal(await state(String(chosen.id)), 'not_signed_in');
  assert.equal(await state(f.connectionId), 'session_open');
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=now() - interval '1 second' WHERE connection_id=$1", [f.connectionId]);
  assert.equal(await state(f.connectionId), 'offline', 'an expired session is not open');
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=now() + interval '1 hour' WHERE connection_id=$1", [f.connectionId]);
  assert.equal(await state(f.connectionId), 'session_open');
  await pool.query('UPDATE agent_oauth_bindings SET generation=generation + 1 WHERE connection_id=$1', [f.connectionId]);
  assert.equal(await state(f.connectionId), 'offline', 'a session of an earlier grant generation is not open');
});

test('only connections selected for this project, of owners who can still read it, are listed', async () => {
  const f = await actionScene(pool);
  const other = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/projects`,
    { body: { name: 'Another project', visibility: 'restricted' } }), 201);
  const elsewhere = expect(await f.owner.request('POST', '/api/v1/agent-connections', { body: { agentId: f.agentId,
    selectedProjectIds: [String(other.id)], scopes: ['flux.context.read'], name: 'Only the other project' } }), 201);
  const ids = async (browser = f.owner) => (expectStatus(await browser.request('GET', `/api/v1/projects/${f.projectId}/agents`), 200) as ProjectAgents)
    .connections.map((item) => item.id);
  assert.ok(!(await ids()).includes(String(elsewhere.id)), 'a connection of another project stays there');

  const member = await person('Marek');
  const ownerPerson = { id: (await pool.query('SELECT owner_user_id FROM agent_connections WHERE id=$1', [f.connectionId])).rows[0].owner_user_id as string, email: '', browser: f.owner };
  await addMember(ownerPerson, f.workspaceId, member, 'member');
  await grant(ownerPerson, f.projectId, member, 'contributor');
  const agent = expect(await member.browser.request('POST', `/api/v1/workspaces/${f.workspaceId}/agents`, { body: { name: "Marek's agent", owner: 'self' } }), 201);
  const his = expect(await member.browser.request('POST', '/api/v1/agent-connections', { body: { agentId: agent.id,
    selectedProjectIds: [f.projectId], scopes: ['flux.context.read'], name: 'Workshop PC', clientDesignation: 'claude_code' } }), 201);
  assert.ok((await ids()).includes(String(his.id)));
  await removeFromSpace(ownerPerson, f.projectId, member);
  assert.ok(!(await ids()).includes(String(his.id)), "an owner who lost access no longer shows a connection here");
});
