import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { agentProposalRepository } from '@flux/db';
import { agentProposalUseCases, enforce, evaluateProject, recordEvent, validateProposalCommand } from '@flux/core';
import type { AgentProposal, Material, Project, Workspace } from '@flux/contracts';
import { register, uniqueEmail, type ClientResponse } from './support/http.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());
const store = agentProposalUseCases(agentProposalRepository(db, {
  async authorizeWrite(principal, projectId, tx) {
    const checked = enforce(await evaluateProject(principal, 'project.write', projectId, tx, { lock: true }), 'project');
    return { workspaceId: checked.project!.workspaceId };
  },
  async authorizeRead(principal, projectId, tx) {
    enforce(await evaluateProject(principal, 'project.read', projectId, tx, { lock: true }), 'project');
  },
  async recordCreated(principal, workspaceId, projectId, tx) {
    await recordEvent(tx, principal, workspaceId, 'project.proposal_created.v1', projectId, {});
  },
}));

function result(response: ClientResponse, status: number) {
  assert.equal(response.status, status, response.text);
  return response.json;
}

async function person(label: string) {
  const email = uniqueEmail(label);
  const { browser } = await register(email, 'correct horse battery staple', label);
  const me = result(await browser.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
  return { id: me.user.id, email, browser };
}

describe('sourced personal agent proposals', () => {
  let owner: Awaited<ReturnType<typeof person>>;
  let peer: Awaited<ReturnType<typeof person>>;
  let outsider: Awaited<ReturnType<typeof person>>;
  let workspace: Workspace;
  let project: Project;
  let material: Material;
  let agentId: string;
  let grantId: string;

  before(async () => {
    [owner, peer, outsider] = await Promise.all(['proposal-owner', 'proposal-peer', 'proposal-outsider'].map(person));
    workspace = result(await owner.browser.request('POST', '/api/v1/workspaces',
      { body: { name: 'Light research' } }), 201) as Workspace;
    result(await owner.browser.request('POST', `/api/v1/workspaces/${workspace.id}/members`,
      { body: { email: peer.email, role: 'member' } }), 201);
    project = result(await owner.browser.request('POST', `/api/v1/workspaces/${workspace.id}/projects`,
      { body: { name: 'Lamp sensor', visibility: 'restricted' } }), 201) as Project;
    result(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'human', id: peer.id }, role: 'viewer' } }), 201);
    agentId = (result(await owner.browser.request('POST', `/api/v1/workspaces/${workspace.id}/agents`,
      { body: { name: 'Hubert research client', owner: 'self' } }), 201) as { id: string }).id;
    grantId = (result(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201) as { id: string }).id;
    material = result(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Low light', body: 'Sensor A misses dim scenes' } }), 201) as Material;
  });

  test('source, audience, idempotency and current grant protect a proposal', async () => {
    const context = { ownerUserId: owner.id, agentId, selectedProjectIds: [project.id],
      scopes: ['flux.context.read', 'flux.proposal.write'] as const,
      computeSource: 'user_operated_claude_code' as const };
    const command = { projectId: project.id, source: { materialId: material.materialId, version: 1 },
      clientCommandId: randomUUID(), fact: 'Sensor A failed in dim scenes',
      interpretation: 'Exposure may be too short', suggestedAction: 'Compare sensor B' };
    const first = await store.create(context, command);
    assert.equal(first.status, 'proposed');
    assert.deepEqual(first.audience, { kind: 'project', projectId: project.id });
    assert.deepEqual(first.source, command.source);
    assert.equal(first.computeSource, 'user_operated_claude_code');
    assert.deepEqual(first.agentGrant, { id: grantId, role: 'contributor' });
    assert.equal((await store.create(context, command)).id, first.id);
    await assert.rejects(store.create(context, { ...command, suggestedAction: 'Publish automatically' }),
      { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(store.create({ ...context, selectedProjectIds: [] }, command), { code: 'PROJECT_NOT_FOUND' });
    await assert.rejects(store.create({ ...context, scopes: ['flux.context.read'] }, command), { code: 'MCP_SCOPE_REQUIRED' });
    await assert.rejects(store.create({ ...context, ownerUserId: peer.id }, command), { code: 'AGENT_NOT_FOUND' });
    const second = await store.create(context, { ...command, clientCommandId: randomUUID(), suggestedAction: 'Review exposure logs' });
    const peerView = result(await peer.browser.request('GET',
      `/api/v1/projects/${project.id}/agent-proposals?limit=1&offset=0`), 200) as { items: AgentProposal[]; total: number; limit: number; offset: number };
    const nextPage = result(await peer.browser.request('GET',
      `/api/v1/projects/${project.id}/agent-proposals?limit=1&offset=1`), 200) as typeof peerView;
    assert.deepEqual(new Set([...peerView.items, ...nextPage.items].map((proposal) => proposal.id)), new Set([first.id, second.id]));
    assert.equal(peerView.total, 2);
    assert.equal(peerView.limit, 1);
    assert.equal(peerView.offset, 0);
    result(await outsider.browser.request('GET', `/api/v1/projects/${project.id}/agent-proposals`), 404);

    result(await owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'New evidence' } }), 200);
    await assert.rejects(store.create(context, command), { code: 'SOURCE_VERSION_CONFLICT' });
    result(await owner.browser.request('DELETE', `/api/v1/projects/${project.id}/grants/${grantId}`), 204);
    await assert.rejects(store.create(context, command), { code: 'PROJECT_NOT_FOUND' });
    const count = await pool.query('SELECT count(*)::int AS count FROM agent_proposals WHERE id = $1', [first.id]);
    assert.equal(count.rows[0].count, 1);
    const afterRevocation = result(await owner.browser.request('GET',
      `/api/v1/projects/${project.id}/agent-proposals`), 200) as { items: AgentProposal[] };
    assert.equal(afterRevocation.items.some((proposal) => proposal.id === first.id), true,
      'human project work continues without the agent');
    assert.equal(afterRevocation.items.find((proposal) => proposal.id === first.id)?.agentGrant.id, grantId,
      'the original grant stays attributable after revocation');
  });

  test('invalid command shapes and source revision range are domain errors', () => {
    assert.throws(() => validateProposalCommand(undefined as never), { code: 'INVALID_INPUT' });
    assert.throws(() => validateProposalCommand({ projectId: project.id, source: { materialId: material.materialId,
      version: 2_147_483_648 }, clientCommandId: randomUUID(), fact: 'Fact', interpretation: 'Interpretation',
      suggestedAction: 'Action' }), { code: 'INVALID_INPUT' });
  });
});
