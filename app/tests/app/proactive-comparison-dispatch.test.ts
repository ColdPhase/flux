import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { ComparisonProvider } from '@flux/core';
import type { Conversation, Material, ProactiveComparisonProposal, WorkResult } from '@flux/contracts';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { db, pool } from './support/db.js';
import { addMember, draft, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';


describe('controlled background comparison dispatch (#58)', () => {
  let owner: Person;
  let peer: Person;
  let outsider: Person;
  let projectId: string;
  let agentGrantId: string;
  let material: Material;
  let conversation: Conversation;
  let mock: Server;
  let endpoint: string;
  let responseMode: 'good' | 'bad_citation' | 'outage' = 'good';
  const seen: string[] = [];
  const privateToken = `PRIVATE-DO-NOT-SEND-${randomUUID()}`;
  const fakeKey = `sk-ant-api03-${'dispatch-owner-key-'.repeat(4)}END8`;
  const masterKey = readFileSync('/run/secrets/flux_background_key');
  const candidates = async (resultId: string) => {
    const id = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [resultId])).rows[0].id as string;
    await comparisonDispatchFixtureDue(pool, id);
    return id;
  };
  const negative = async (title: string) => expectStatus(await peer.browser.request('POST',
    `/api/v1/projects/${projectId}/results`, { body: { title, finding: 'negative', evidence: 'Camera misses at 5 lux',
      sources: [{ type: 'material', id: material.materialId, version: 1 },
        { type: 'message', id: conversation.messages[0]!.id }] } }), 201) as WorkResult;

  before(async () => {
    [owner, peer, outsider] = await Promise.all(['dispatch-owner', 'dispatch-peer', 'dispatch-outsider'].map(person));
    const ws = await workspace(owner, 'Comparison dispatch workspace');
    await addMember(owner, ws.id, peer, 'member');
    await addMember(owner, ws.id, outsider, 'member');
    projectId = (await project(owner, ws.id, 'Low-light sensors', 'restricted')).id;
    await grant(owner, projectId, peer, 'contributor');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'Project comparison agent', owner: 'self' } }), 201) as { id: string }).id;
    agentGrantId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201) as { id: string }).id;
    const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`,
      { body: { agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
        dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
        maxRunsPerDay: 3, periodBudgetCents: 15, perRunCents: 5 } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
      apiKey: fakeKey, payerOrganization: 'Consent test payer', providerWorkspace: 'One test workspace',
      workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true,
      providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
      maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 15, perRunCents: 5,
    } }), 201);
    await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
    material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Sensor measurement', body: 'Camera A captured 38% of gestures at 5 lux.' } }), 201) as Material;
    conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
      { body: { body: 'Compare sensor measurements after the low-light trial.', clientMessageId: randomUUID() } }), 201) as Conversation;
    await draft(owner, ws.id, 'Private camera note', { body: privateToken });
    const privateSketch = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`,
      { body: { title: `Private sketch ${privateToken}`, scope: 'private' } }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', `/api/v1/sketches/${privateSketch.id}/thoughts`,
      { body: { text: privateToken, x: 0, y: 0 } }), 201);

    mock = createServer(async (request, reply) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push(body);
      assert.equal(request.headers['x-api-key'], fakeKey);
      reply.setHeader('content-type', 'application/json');
      if (request.url === '/count') { reply.end(JSON.stringify({ inputTokens: 100 })); return; }
      if (responseMode === 'outage') { reply.statusCode = 503; reply.end('{}'); return; }
      const sent = JSON.parse(body) as { sources: Array<{ type: 'result' | 'material' | 'message'; id: string; version: number }> };
      const citations = responseMode === 'bad_citation' ? [{ type: 'result', id: randomUUID(), version: 1 }] :
        sent.sources.map(({ type, id, version }) => ({ type, id, version }));
      reply.end(JSON.stringify({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 },
        answer: { kind: 'comparison', fact: 'Sensor A misses gestures in low light.', interpretation: 'Exposure may be too short.',
          suggestedAction: 'Compare a second sensor in the same test.', citations } }));
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  });
  after(async () => { await new Promise<void>((resolve) => mock?.close(() => resolve())); });

  const provider: ComparisonProvider = {
    async countInputTokens(input) {
      const response = await fetch(`${endpoint}/count`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': input.apiKey },
        body: JSON.stringify({ model: input.model, sources: input.sources }), signal: input.signal });
      if (!response.ok) throw new Error('local count failed');
      return ((await response.json()) as { inputTokens: number }).inputTokens;
    },
    async createMessage(input) {
      const response = await fetch(`${endpoint}/message`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': input.apiKey },
        body: JSON.stringify({ model: input.model, maxTokens: input.maxTokens, effort: input.effort,
          sources: input.sources }), signal: input.signal });
      if (!response.ok) throw new Error('local provider unavailable');
      return response.json() as ReturnType<ComparisonProvider['createMessage']>;
    },
  };

  test('invalid citation records quiet insufficient evidence and usage, then a valid sourced proposal stays quiet and project-scoped', async () => {
    const invalid = await negative('Initial failed camera trial');
    responseMode = 'bad_citation';
    assert.equal((await dispatchProactiveComparison({ db, candidateId: await candidates(invalid.id), masterKey, provider })).status, 'insufficient_evidence');
    assert.equal((await pool.query('SELECT status, usage_estimated_cents FROM proactive_comparison_outbox WHERE result_id=$1', [invalid.id])).rows[0].status, 'completed');
    assert.equal((await owner.browser.request('GET', `/api/v1/projects/${projectId}/proactive-comparison-proposals`)).json instanceof Array, true);

    const good = await negative('Repeated low-light failure');
    responseMode = 'good';
    const outcome = await dispatchProactiveComparison({ db, candidateId: await candidates(good.id), masterKey, provider });
    assert.equal(outcome.status, 'proposal');
    const beforeReplay = seen.length;
    assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: await candidates(good.id), masterKey, provider }), outcome,
      'a completed candidate cannot call the provider twice');
    assert.equal(seen.length, beforeReplay);
    const reconciled = await pool.query('SELECT reserved_cents, usage_input_tokens, usage_output_tokens, usage_estimated_cents FROM proactive_comparison_outbox WHERE result_id=$1', [good.id]);
    assert.deepEqual(reconciled.rows[0], { reserved_cents: 5, usage_input_tokens: 100, usage_output_tokens: 100,
      usage_estimated_cents: 1 }, 'observed usage is separate from the conservative reservation');
    const peerView = expectStatus(await peer.browser.request('GET', `/api/v1/projects/${projectId}/proactive-comparison-proposals`), 200) as ProactiveComparisonProposal[];
    assert.equal(peerView.length, 1);
    assert.equal(peerView[0]?.id, outcome.status === 'proposal' ? outcome.proposalId : '');
    assert.deepEqual(peerView[0]?.audience, { kind: 'project', projectId });
    assert.deepEqual(peerView[0]?.sources.map(({ type, version }) => [type, version]), [['result', 1], ['material', 1], ['message', 1]]);
    const citedMessage = peerView[0]?.sources.find((source) => source.type === 'message');
    assert.equal(citedMessage?.conversationId, conversation.id,
      'project message citation resolves to its inspectable conversation');
    assert.equal(peerView[0]?.computeSource, 'owner_background_claude_platform');
    assert.equal((await outsider.browser.request('GET', `/api/v1/projects/${projectId}/proactive-comparison-proposals`)).status, 404);
    assert.ok(seen.every((body) => !body.includes(privateToken)), 'private draft/sketch never enters the provider request');
    assert.ok(!JSON.stringify(peerView).includes(privateToken), 'private draft/sketch never enters the proposal');
    const notices = await pool.query('SELECT count(*)::int AS n FROM notifications WHERE source_id=$1', [good.id]);
    assert.equal(notices.rows[0].n, 0, 'the proposal does not emit a notification');

    const proposal = peerView[0]!;
    assert.equal((await outsider.browser.request('PATCH', `/api/v1/proactive-comparison-proposals/${proposal.id}`,
      { body: { expectedVersion: proposal.version, status: 'dismissed' } })).status, 404);
    const edited = expectStatus(await peer.browser.request('PATCH', `/api/v1/proactive-comparison-proposals/${proposal.id}`,
      { body: { expectedVersion: proposal.version, interpretation: 'Check sensor timing before changing hardware.' } }), 200) as ProactiveComparisonProposal;
    assert.equal(edited.version, proposal.version + 1);
    assert.equal(edited.editedByUserId, peer.id);
    assert.equal((await peer.browser.request('PATCH', `/api/v1/proactive-comparison-proposals/${proposal.id}`,
      { body: { expectedVersion: proposal.version, status: 'dismissed' } })).status, 409);
    const used = expectStatus(await peer.browser.request('POST', `/api/v1/proactive-comparison-proposals/${proposal.id}/use`,
      { body: { expectedVersion: edited.version, title: 'Compare low-light sensors' } }), 200) as {
      proposal: ProactiveComparisonProposal; work: { id: string; title: string } };
    assert.equal(used.proposal.status, 'used');
    assert.equal(used.proposal.usedWorkId, used.work.id);
    assert.equal(used.work.title, 'Compare low-light sensors');
    assert.equal((await peer.browser.request('POST', `/api/v1/proactive-comparison-proposals/${proposal.id}/use`,
      { body: { expectedVersion: used.proposal.version, title: 'Duplicate work' } })).status, 409);
    assert.equal(seen.length, beforeReplay, 'human use and edit do not request more compute');

    const dismissResult = await negative('Failure to dismiss');
    assert.equal((await dispatchProactiveComparison({ db, candidateId: await candidates(dismissResult.id), masterKey, provider })).status, 'proposal');
    const all = expectStatus(await peer.browser.request('GET', `/api/v1/projects/${projectId}/proactive-comparison-proposals`), 200) as ProactiveComparisonProposal[];
    const toDismiss = all.find((item) => item.resultId === dismissResult.id)!;
    const dismissed = expectStatus(await peer.browser.request('PATCH', `/api/v1/proactive-comparison-proposals/${toDismiss.id}`,
      { body: { expectedVersion: toDismiss.version, status: 'dismissed' } }), 200) as ProactiveComparisonProposal;
    assert.equal(dismissed.status, 'dismissed');
    const beforeDismissReplay = seen.length;
    assert.equal((await dispatchProactiveComparison({ db, candidateId: await candidates(dismissResult.id), masterKey, provider })).status, 'proposal');
    assert.equal(seen.length, beforeDismissReplay, 'dismissal suppresses this unchanged result/source candidate');
  });

  test('provider outage preserves uncertainty; stale source, missing key and lost grant stop before any request', async () => {
    // This scenario starts in a later budget period than the preceding three dispatches.
    await pool.query("UPDATE proactive_comparison_outbox SET reserved_at = now() - interval '31 days' WHERE owner_user_id=$1 AND reserved_at IS NOT NULL", [owner.id]);
    const outage = await negative('Third failed camera trial');
    responseMode = 'outage';
    assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: await candidates(outage.id), masterKey, provider }),
      { status: 'unknown', reason: 'PROVIDER_OR_STORAGE_FAILURE' });
    const afterOutage = seen.length;
    assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: await candidates(outage.id), masterKey, provider }),
      { status: 'blocked', reason: 'NOT_QUEUED' }, 'an uncertain possible charge is never retried');
    assert.equal(seen.length, afterOutage);
    const noKey = await negative('Trial without key file');
    assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: await candidates(noKey.id), masterKey: null, provider }),
      { status: 'not_run', reason: 'KEY_UNAVAILABLE' });
    assert.equal(seen.length, afterOutage);

    const stale = await negative('Trial before material revision');
    expectStatus(await owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'The measurement was corrected.' } }), 200);
    assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: await candidates(stale.id), masterKey, provider }),
      { status: 'not_run', reason: 'SOURCE_CHANGED' });
    assert.equal(seen.length, afterOutage);
    const accessLost = await negative('Trial before agent grant removed');
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${projectId}/grants/${agentGrantId}`), 204);
    assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: await candidates(accessLost.id), masterKey, provider }),
      { status: 'not_run', reason: 'OWNER_OR_AGENT_ACCESS' });
    assert.equal(seen.length, afterOutage);
    const connection = expectStatus(await owner.browser.request('GET', '/api/v1/background-compute-connections/current'), 200) as { id: string };
    expectStatus(await owner.browser.request('DELETE', `/api/v1/background-compute-connections/${connection.id}`), 204);
    const manual = expectStatus(await peer.browser.request('POST', `/api/v1/projects/${projectId}/work`,
      { body: { title: 'Compare the low-light sensors by hand' }, headers: { 'idempotency-key': randomUUID() } }), 201) as { title: string };
    assert.equal(manual.title, 'Compare the low-light sensors by hand');
    assert.equal(seen.length, afterOutage, 'human continuation does not need background compute');
  });
});
