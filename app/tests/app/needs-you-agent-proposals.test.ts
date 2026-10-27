import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentProposalRepository } from '@flux/db';
import { agentProposalUseCases, enforce, evaluateProject, recordEvent } from '@flux/core';
import type { Material, NeedsYouResponse, Project, Workspace } from '@flux/contracts';
import { eventPorts } from '../../apps/server/src/events.js';
import { db } from './support/db.js';
import { expectStatus, person } from './support/people.js';
import { ensureWorkspaceAiAllowed, setWorkspaceAi } from './support/workspace-ai.js';

// #661: a suggestion an agent makes through MCP is a "Needs you" item for the person who connected the agent.
const store = agentProposalUseCases(agentProposalRepository(db, {
  async authorizeWrite(principal, projectId, tx) {
    return { workspaceId: enforce(await evaluateProject(principal, 'project.write', projectId, tx, { lock: true }), 'project').project!.workspaceId };
  },
  async authorizeRead(principal, projectId, tx) { enforce(await evaluateProject(principal, 'project.read', projectId, tx, { lock: true }), 'project'); },
  async recordCreated(principal, workspaceId, projectId, tx) { await recordEvent(eventPorts(tx), principal, workspaceId, 'project.proposal_created.v1', projectId, {}); },
}));

test('an agent suggestion reaches its owner in Needs you, can be answered, and hides while AI is off', async () => {
  const [owner, other] = await Promise.all(['ny-prop-owner', 'ny-prop-other'].map(person));
  const ws = expectStatus(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Suggestions' } }), 201) as Workspace;
  expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { email: other.email, role: 'member' } }), 201);
  const project = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Sensors', visibility: 'restricted' } }), 201) as Project;
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Desk agent', owner: 'self' } }), 201) as { id: string };
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Low light', body: 'Sensor A misses dim scenes' } }), 201) as Material;
  const connection = expectStatus(await owner.browser.request('POST', '/api/v1/agent-connections',
    { body: { agentId: agent.id, selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write'] } }), 201) as { id: string };
  const proposal = await store.create({ connectionId: connection.id, ownerUserId: owner.id, agentId: agent.id, selectedProjectIds: [project.id],
    scopes: ['flux.context.read', 'flux.proposal.write'] as const, computeSource: 'user_operated_claude_code' as const },
  { projectId: project.id, source: { materialId: material.materialId, version: 1 }, clientCommandId: randomUUID(),
    fact: 'Sensor A failed in dim scenes', interpretation: 'Exposure may be too short', suggestedAction: 'Compare sensor B' });
  const key = `proposal:${proposal.id}`;
  const list = async (who = owner) => expectStatus(await who.browser.request('GET', '/api/v1/needs-you'), 200) as NeedsYouResponse;

  const item = (await list()).items.find((entry) => entry.key === key)!;
  assert.equal(item.kind, 'question');
  assert.equal(item.from?.kind, 'agent');
  assert.equal(item.from?.name, 'Desk agent');
  assert.deepEqual(item.proposal, { id: proposal.id, fact: 'Sensor A failed in dim scenes', interpretation: 'Exposure may be too short',
    suggestedAction: 'Compare sensor B', source: { materialId: material.materialId, title: 'Low light', version: 1 } });
  assert.equal((await list(other)).items.some((entry) => entry.key === key), false, 'only the person who connected the agent is asked');

  await setWorkspaceAi(ws.id, 'blocked');
  assert.equal((await list()).items.some((entry) => entry.key === key), false, 'hidden while AI is off');
  expectStatus(await owner.browser.request('POST', `/api/v1/needs-you/${encodeURIComponent(key)}`, { body: { action: 'done' } }), 404);
  await ensureWorkspaceAiAllowed(ws.id);

  expectStatus(await owner.browser.request('POST', `/api/v1/needs-you/${encodeURIComponent(key)}`, { body: { action: 'decline' } }), 200);
  assert.equal((await list()).items.some((entry) => entry.key === key), false);
  expectStatus(await owner.browser.request('DELETE', `/api/v1/needs-you/${encodeURIComponent(key)}`), 204);
  assert.equal((await list()).items.some((entry) => entry.key === key), true, 'Undo brings it back');
});
