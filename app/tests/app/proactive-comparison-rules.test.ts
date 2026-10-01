import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { BackgroundComputeConnection, ProactiveComparisonRule, Workspace, Project } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());
const body = (agentId: string) => ({ agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
  dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
  maxRunsPerDay: 1, periodBudgetCents: 25, perRunCents: 5 });
const path = (id: string) => `/api/v1/projects/${id}/proactive-comparison-rules`;
const connectionPath = '/api/v1/background-compute-connections';
const codeOf = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;
const fakeKey = `sk-ant-api03-${'owner-budget-key-'.repeat(4)}END9`;
const connectionBody = (periodBudgetCents = 50) => ({
  apiKey: fakeKey, payerOrganization: 'Example payer org', providerWorkspace: 'Dedicated maker workspace',
  workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true,
  providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
  maxRunsPerDay: 1, periodDays: 30, periodBudgetCents, perRunCents: 5,
});

function decryptForTest(blob: string, ownerId: string, connectionId: string) {
  const [version, nonce, tag, encrypted] = blob.split('.');
  assert.equal(version, 'v1');
  const decipher = createDecipheriv('aes-256-gcm', readFileSync('/run/secrets/flux_background_key'), Buffer.from(nonce!, 'base64url'));
  decipher.setAAD(Buffer.from(`flux-background-key:v1:${ownerId}:${connectionId}`));
  decipher.setAuthTag(Buffer.from(tag!, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted!, 'base64url')), decipher.final()]).toString('utf8');
}

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

  test('owner-only payer consent stores authenticated ciphertext and safe metadata', async () => {
    assert.equal((await owner.browser.request('POST', connectionPath,
      { body: { ...connectionBody(), payerAuthorityConfirmed: false } })).status, 400);
    assert.equal((await owner.browser.request('POST', connectionPath,
      { body: { ...connectionBody(), periodDays: 0 } })).status, 400);
    const firstResponse = await owner.browser.request('POST', connectionPath, { body: connectionBody(5) });
    const first = expectStatus(firstResponse, 201) as BackgroundComputeConnection;
    assert.equal(first.ownerUserId, owner.id);
    assert.equal(first.periodDays, 30);
    assert.equal(first.periodBudgetCents, 5);
    assert.equal(first.keyLastFour, 'END9');
    assert.equal(first.model, 'claude-sonnet-5');
    assert.ok(!firstResponse.text.includes(fakeKey));
    const record = await pool.query('SELECT encrypted_key, key_last_four, consent_version FROM background_compute_connections WHERE id=$1', [first.id]);
    const blob = record.rows[0].encrypted_key as string;
    assert.ok(blob.startsWith('v1.') && !blob.includes(fakeKey));
    assert.equal(decryptForTest(blob, owner.id, first.id), fakeKey);
    assert.throws(() => decryptForTest(blob, peer.id, first.id), /auth|authenticate|Unsupported state/i);
    assert.equal(record.rows[0].consent_version, 'o-007-2026-09-28');
    assert.equal(expectStatus(await peer.browser.request('GET', `${connectionPath}/current`), 200), null);
    assert.equal((await peer.browser.request('DELETE', `${connectionPath}/${first.id}`)).status, 404);

    // Replacement must retire and erase the earlier ciphertext in one transaction.
    const second = expectStatus(await owner.browser.request('POST', connectionPath,
      { body: connectionBody(50) }), 201) as BackgroundComputeConnection;
    assert.notEqual(second.id, first.id);
    assert.deepEqual(expectStatus(await owner.browser.request('GET', `${connectionPath}/current`), 200), second);
    const old = await pool.query('SELECT encrypted_key, revoked_at FROM background_compute_connections WHERE id=$1', [first.id]);
    assert.equal(old.rows[0].encrypted_key, null);
    assert.ok(old.rows[0].revoked_at);
    assert.equal((await owner.browser.request('DELETE', `${connectionPath}/${first.id}`)).status, 404);
    expectStatus(await owner.browser.request('DELETE', `${connectionPath}/${second.id}`), 204);
    const erased = await pool.query('SELECT encrypted_key, revoked_at FROM background_compute_connections WHERE id=$1', [second.id]);
    assert.equal(erased.rows[0].encrypted_key, null);
    assert.ok(erased.rows[0].revoked_at);
    assert.equal(expectStatus(await owner.browser.request('GET', `${connectionPath}/current`), 200), null);
  });

  test('activation checks owner connection, grant, budget and execution readiness; pause/revoke are versioned', async () => {
    const change = (someone: Person, expectedVersion: number, status: string) => someone.browser.request('PATCH',
      `/api/v1/proactive-comparison-rules/${rule.id}`, { body: { expectedVersion, status } });
    assert.equal((await change(peer, 1, 'enabled')).status, 404);
    assert.equal((await change(owner, 1, 'enabled')).status, 409,
      'no owner-supplied background key means the rule cannot be activated');
    const tooSmall = expectStatus(await owner.browser.request('POST', connectionPath, { body: connectionBody(5) }), 201) as BackgroundComputeConnection;
    assert.equal(codeOf(await change(owner, 1, 'enabled')), 'BACKGROUND_BUDGET_TOO_LOW');
    const enough = expectStatus(await owner.browser.request('POST', connectionPath, { body: connectionBody(50) }), 201) as BackgroundComputeConnection;
    assert.equal(codeOf(await change(owner, 1, 'enabled')), 'BACKGROUND_RUNTIME_UNAVAILABLE',
      'a configured key alone cannot activate a rule before the budgeted worker exists');
    assert.equal((expectStatus(await owner.browser.request('GET', path(project.id)), 200) as ProactiveComparisonRule[])[0]?.status, 'paused');
    assert.equal((await peer.browser.request('DELETE', `${connectionPath}/${enough.id}`)).status, 404);
    expectStatus(await owner.browser.request('DELETE', `${connectionPath}/${enough.id}`), 204);
    assert.equal(codeOf(await change(owner, 1, 'enabled')), 'BACKGROUND_CONNECTION_REQUIRED');
    assert.equal((await owner.browser.request('DELETE', `${connectionPath}/${tooSmall.id}`)).status, 404);
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

  test('revocation preserves its row while concurrent fresh authorizations admit only one paused rule', async () => {
    const oldRow = (await pool.query('SELECT * FROM proactive_comparison_rules WHERE id=$1', [rule.id])).rows[0];
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${project.id}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    const attempts = await Promise.all([1, 2].map(() => owner.browser.request('POST', path(project.id), { body: body(agentId) })));
    assert.deepEqual(attempts.map((response) => response.status).sort(), [201, 409]);
    const fresh = expectStatus(attempts.find((response) => response.status === 201)!, 201) as ProactiveComparisonRule;
    assert.notEqual(fresh.id, rule.id); assert.equal(fresh.status, 'paused'); assert.equal(fresh.version, 1);
    assert.deepEqual((await pool.query('SELECT * FROM proactive_comparison_rules WHERE id=$1', [rule.id])).rows[0], oldRow,
      'fresh authorization leaves the revoked row and its timestamps unchanged');
    const all = expectStatus(await owner.browser.request('GET', path(project.id)), 200) as ProactiveComparisonRule[];
    assert.equal(all.filter((row) => row.status !== 'revoked').length, 1);
    assert.equal(all.find((row) => row.id === rule.id)?.status, 'revoked');
    assert.equal(codeOf(await owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${rule.id}`,
      { body: { expectedVersion: rule.version, status: 'enabled' } })), 'RULE_REVOKED');
  });
});
