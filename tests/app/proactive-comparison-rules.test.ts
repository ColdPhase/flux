import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { ProactiveComparisonRule, Workspace, Project } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());
const body = (agentId: string) => ({ agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
  dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
  maxRunsPerDay: 1, periodBudgetCents: 25, perRunCents: 5 });
const path = (id: string) => `/api/v1/projects/${id}/proactive-comparison-rules`;

describe('owner standing comparison rule', () => {
  let owner: Person;
  let peer: Person;
  let outsider: Person;
  let ws: Workspace;
  let project: Project;
  let agentId: string;
  let agentGrantId: string;
  let rule: ProactiveComparisonRule;

  before(async () => {
    [owner, peer, outsider] = await Promise.all(['rule-owner', 'rule-peer', 'rule-outsider'].map(person));
    ws = await workspace(owner, 'Rule workspace');
    await addMember(owner, ws.id, peer, 'member');
    await addMember(owner, ws.id, outsider, 'member');
    project = await createProject(owner, ws.id, 'Low light', 'restricted');
    await grant(owner, project.id, peer, 'contributor');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'My comparison agent', owner: 'self' } }), 201) as { id: string }).id;
    agentGrantId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201) as { id: string }).id;
  });

  test('owner alone persists a fixed audience, purpose, effect and bounded cost', async () => {
    assert.equal((await peer.browser.request('POST', path(project.id), { body: body(agentId) })).status, 404);
    assert.equal((await outsider.browser.request('GET', path(project.id))).status, 404);
    assert.equal((await owner.browser.request('POST', path(project.id), { body: { ...body(agentId), perRunCents: 51 } })).status, 400);
    assert.equal((await owner.browser.request('POST', path(project.id), { body: { ...body(agentId), dataScope: 'all_my_dms' } })).status, 400);
    rule = expectStatus(await owner.browser.request('POST', path(project.id), { body: body(agentId) }), 201) as ProactiveComparisonRule;
    assert.equal(rule.ownerUserId, owner.id);
    assert.equal(rule.status, 'paused');
    assert.deepEqual([rule.projectId, rule.purpose, rule.dataScope, rule.permittedEffect, rule.periodBudgetCents],
      [project.id, 'camera_sensor_comparison', 'current_project_published', 'quiet_project_proposal', 25]);
    assert.equal((await owner.browser.request('POST', path(project.id), { body: body(agentId) })).status, 409);
    assert.deepEqual((expectStatus(await owner.browser.request('GET', path(project.id)), 200) as ProactiveComparisonRule[]).map((r) => r.id), [rule.id]);
    assert.deepEqual(expectStatus(await peer.browser.request('GET', path(project.id)), 200), [],
      'a project peer cannot see a personal rule or its spending limits');
    const persisted = await pool.query('SELECT trigger_kind, owner_user_id, project_id, status FROM proactive_comparison_rules WHERE id = $1', [rule.id]);
    assert.deepEqual(persisted.rows[0], { trigger_kind: 'human_negative_result', owner_user_id: owner.id, project_id: project.id, status: 'paused' });
  });

  test('pause and permanent revocation require owner, current project access and version', async () => {
    const change = (someone: Person, expectedVersion: number, status: string) => someone.browser.request('PATCH',
      `/api/v1/proactive-comparison-rules/${rule.id}`, { body: { expectedVersion, status } });
    assert.equal((await change(peer, 1, 'enabled')).status, 404);
    assert.equal((await change(owner, 1, 'enabled')).status, 409,
      'no owner-supplied background key means the rule cannot be activated');
    rule = expectStatus(await change(owner, 1, 'paused'), 200) as ProactiveComparisonRule;
    assert.equal(rule.status, 'paused');
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${project.id}/grants/${agentGrantId}`), 204);
    assert.equal((await change(owner, 2, 'enabled')).status, 404,
      'lost agent grant prevents enabling the rule again');
    rule = expectStatus(await change(owner, 2, 'revoked'), 200) as ProactiveComparisonRule;
    assert.equal(rule.status, 'revoked');
    assert.equal((await change(owner, 3, 'enabled')).status, 409);
    assert.ok(rule.revokedAt);
  });
});
