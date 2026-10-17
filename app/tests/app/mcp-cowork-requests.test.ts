import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Agent, AgentStandingGrant, TaskCoordination, WorkItem } from '@flux/contracts';
import { pool } from './support/db.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// #153 AC-2/AC-4 over the real OAuth bearer: flux_send_request, flux_coordination_inbox, flux_resolve_request with a
// review verdict pinned to the exact target version, and the task's coordination read for people (#400 AC-4/AC-5).
// Docker regression evidence, not real-client evidence.
const ACTION_SCOPES = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];
type Role = 'execute' | 'review' | 'plan';

async function scene() {
  const hubert = await person('mcp-requests-hubert'), marek = await person('mcp-requests-marek'), olga = await person('mcp-requests-olga');
  const ws = await workspace(hubert, 'MCP requests');
  await addMember(hubert, ws.id, marek, 'admin');
  await addMember(hubert, ws.id, olga, 'member');
  const p = await project(hubert, ws.id, 'Shared outcome', 'restricted');
  await grant(hubert, p.id, marek, 'contributor');
  const connect = async (who: Person, name: string) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as Agent;
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const connected = await agentConnection(pool, who.browser, String(agent.id), [p.id], ACTION_SCOPES);
    const standing = async (operation: string, objectId: string | null, role: Role, maximumUses = 10) =>
      expectStatus(await who.browser.request('POST', `/api/v1/agent-connections/${connected.connectionId}/action-grants`, { body: {
        clientCommandId: randomUUID(), projectId: p.id, operation, peerRequestClass: role, maximumUses, ...(objectId ? { objectId } : {}),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as AgentStandingGrant;
    const base = (grantId: string, role: Role, clientCommandId: string = randomUUID()) => ({ projectId: p.id,
      runtimeSessionId: connected.runtimeSessionId, grantId, clientCommandId, peerRequestClass: role });
    const claimUnit = async (unitId: string, role: Role, expectedVersion = 1) => {
      const g = await standing('cowork.claim', unitId, role);
      return toolValue(await connected.tool('flux_claim_unit', { ...base(g.id, role), unitId, expectedVersion })) as
        { generation: number; version: number; lease: { id: string } };
    };
    return { ...connected, standing, base, claimUnit };
  };
  const task = async (title: string) => expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`,
    { body: { title } }), 201) as WorkItem;
  const material = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Review findings', body: 'Two findings, both fixed' } }), 201) as { materialId: string };
  const used = async (grantId: string) => (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0].used as number;
  const unitVersion = async (unitId: string) => (await pool.query('SELECT version FROM cowork_units WHERE id=$1', [unitId])).rows[0].version as number;
  return { hubert, marek, olga, ws, p, connect, task, material, used, unitVersion };
}

test('a review request travels send -> inbox -> claim -> resolve with a pinned verdict; a new version stales it; the same grant asks again', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A');
  // Codex takes task A and opens a review unit for Marek's connection (another owner).
  const take = await codex.standing('cowork.unit.create', a.id, 'execute');
  const root = toolValue(await codex.tool('flux_create_unit', { ...codex.base(take.id, 'execute'), taskId: a.id, unitKey: 'take',
    expectedTaskVersion: a.version, assignmentConnectionId: codex.connectionId, parent: null }));
  const rootUnit = String(root.unitId);
  const rootClaim = await codex.claimUnit(rootUnit, 'execute');
  const openReview = await codex.standing('cowork.unit.create', a.id, 'review');
  const review = toolValue(await codex.tool('flux_create_unit', { ...codex.base(openReview.id, 'review'), taskId: a.id, unitKey: 'review',
    expectedTaskVersion: a.version, assignmentConnectionId: marekClaude.connectionId,
    parent: { unitId: rootUnit, generation: rootClaim.generation, leaseId: rootClaim.lease.id } }));
  const reviewUnit = String(review.unitId);
  const reviewClaim = await marekClaude.claimUnit(reviewUnit, 'review');

  // One standing request grant covers every later request of this unit: no per-request owner prompt.
  const ask = await codex.standing('cowork.request', rootUnit, 'execute');
  const send = (intentKey: string, target: Record<string, unknown>, clientCommandId: string = randomUUID(), kind = 'review') =>
    codex.tool('flux_send_request', { ...codex.base(ask.id, 'execute', clientCommandId), unitId: rootUnit, generation: rootClaim.generation,
      leaseId: rootClaim.lease.id, recipientUnitId: reviewUnit, expectedRecipientUnitVersion: reviewClaim.version,
      recipientConnectionId: marekClaude.connectionId, intentKey, parentRequestId: null, kind, target,
      sourceRefs: [{ type: 'material', id: f.material.materialId, version: 1 }], criteriaRefs: [target], peerUnblocking: true });
  const first = randomUUID();
  const sent = toolValue(await send('review-1', { type: 'work', id: a.id, version: a.version }, first));
  assert.equal(sent.status, 'created');
  assert.equal(sent.state, 'queued');
  // A lost response retried with the same command replays; the same intent under a new command returns the request.
  assert.deepEqual(toolValue(await send('review-1', { type: 'work', id: a.id, version: a.version }, first)), sent);
  assert.equal((toolValue(await send('review-1', { type: 'work', id: a.id, version: a.version }))).status, 'existing');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_requests WHERE work_id=$1', [a.id])).rows[0].n, 1, 'retries never duplicate');
  // A stale target is refused: a request names the current version only.
  assert.equal(toolFailure(await send('review-old', { type: 'work', id: a.id, version: a.version + 1 })).code, 'COWORK_SOURCE_UNAVAILABLE');

  // The recipient finds it in its inbox; reading is not an acknowledgement.
  const inbox = toolValue(await marekClaude.tool('flux_coordination_inbox', { projectId: f.p.id }));
  const pending = (inbox.requests as { id: string; kind: string; state: string; target: unknown }[]);
  assert.deepEqual(pending.map(({ id, kind, state, target }) => ({ id, kind, state, target })),
    [{ id: sent.requestId, kind: 'review', state: 'queued', target: { type: 'work', id: a.id, version: a.version } }]);
  assert.equal(inbox.recovery, 'snapshot');
  assert.equal((toolValue(await codex.tool('flux_coordination_inbox', { projectId: f.p.id })).requests as unknown[]).length, 0,
    'the sender\'s inbox holds only what is addressed to it');

  // An execution-class grant cannot pick up a review request.
  const wideExecute = await marekClaude.standing('cowork.request.claim', null, 'execute');
  const fence = { unitId: reviewUnit, generation: reviewClaim.generation, leaseId: reviewClaim.lease.id, requestId: String(sent.requestId) };
  assert.equal(toolFailure(await marekClaude.tool('flux_claim_request', { ...marekClaude.base(wideExecute.id, 'execute'), ...fence,
    expectedRequestVersion: 1 })).code, 'COWORK_UNIT_NOT_FOUND');
  const claimGrant = await marekClaude.standing('cowork.request.claim', reviewUnit, 'review');
  const claimed = toolValue(await marekClaude.tool('flux_claim_request', { ...marekClaude.base(claimGrant.id, 'review'), ...fence, expectedRequestVersion: 1 }));
  assert.equal(claimed.state, 'claimed');

  // Resolution needs evidence that exists now and, for a review, a verdict; refusals leave no verdict or debit.
  const respond = await marekClaude.standing('cowork.request.respond', reviewUnit, 'review');
  const evidence = { type: 'material', id: f.material.materialId, version: 1 };
  const resolve = (change: Record<string, unknown>, clientCommandId: string = randomUUID()) => marekClaude.tool('flux_resolve_request',
    { ...marekClaude.base(respond.id, 'review', clientCommandId), ...fence, expectedRequestVersion: Number(claimed.version), evidence, ...change });
  assert.equal(toolFailure(await resolve({})).code, 'COWORK_VERDICT_REQUIRED');
  assert.equal(toolFailure(await resolve({ verdict: 'passed', evidence: { type: 'result', id: randomUUID() } })).code, 'COWORK_RESPONSE_UNAVAILABLE');
  assert.equal(await f.used(respond.id), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_review_verdicts')).rows[0].n, 0);
  const resolvedCommand = randomUUID();
  const resolved = toolValue(await resolve({ verdict: 'passed' }, resolvedCommand));
  assert.deepEqual(resolved, { requestId: sent.requestId, version: Number(claimed.version) + 1, state: 'resolved', responseRef: evidence });
  assert.deepEqual(toolValue(await resolve({ verdict: 'passed' }, resolvedCommand)), resolved, 'a retry replays the resolution');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_review_verdicts')).rows[0].n, 1);

  // People who can read the task see the request card and the verdict; it applies to the current version.
  const read = async (who: Person = f.hubert) => expectStatus(await who.browser.request('GET', `/api/v1/work/${a.id}/coordination`), 200) as TaskCoordination;
  let coordination = await read();
  assert.deepEqual(coordination.requests.map((r) => ({ kind: r.kind, state: r.state, sender: r.sender.name, recipient: r.recipient.name, target: r.target })),
    [{ kind: 'review', state: 'resolved', sender: 'Hubert Codex', recipient: 'Marek Claude', target: { type: 'work', id: a.id, version: a.version } }]);
  assert.deepEqual(coordination.verdicts.map((v) => ({ verdict: v.verdict, reviewer: v.reviewer.name, author: v.author.name, current: v.current,
    evidence: v.evidenceRef })), [{ verdict: 'passed', reviewer: 'Marek Claude', author: 'Hubert Codex', current: true, evidence }]);
  assert.deepEqual((await read(f.marek)).verdicts.length, 1);
  // Someone who cannot read the task reads nothing.
  expectStatus(await f.olga.browser.request('GET', `/api/v1/work/${a.id}/coordination`), 404);

  // A new version of the target makes the verdict stale without rewriting it.
  const changed = expectStatus(await f.hubert.browser.request('PATCH', `/api/v1/work/${a.id}`, { body: { title: 'Native outcome A, fixed' },
    headers: { 'if-match': `"${a.version}"` } }), 200) as WorkItem;
  coordination = await read();
  assert.deepEqual(coordination.verdicts.map((v) => ({ verdict: v.verdict, current: v.current, target: v.target })),
    [{ verdict: 'passed', current: false, target: { type: 'work', id: a.id, version: a.version } }]);

  // The author asks again for the new version under the same standing grant: no other owner prompt or grant.
  const grantsBefore = (await pool.query('SELECT count(*)::int AS n FROM agent_standing_grants')).rows[0].n as number;
  const again = toolValue(await send('review-2', { type: 'work', id: a.id, version: changed.version }));
  assert.equal(again.status, 'created');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_standing_grants')).rows[0].n, grantsBefore);
  coordination = await read();
  assert.deepEqual(coordination.requests.map((r) => [r.state, (r.target as { version: number }).version]),
    [['queued', changed.version], ['resolved', a.version]], 'history is kept, newest first');
});

test('a non-review request is resolved with evidence only; a verdict on it is refused', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), claude = await f.connect(f.hubert, 'Hubert Claude');
  const a = await f.task('Native outcome B');
  const take = await codex.standing('cowork.unit.create', a.id, 'execute');
  const root = toolValue(await codex.tool('flux_create_unit', { ...codex.base(take.id, 'execute'), taskId: a.id, unitKey: 'take',
    expectedTaskVersion: a.version, assignmentConnectionId: codex.connectionId, parent: null }));
  const rootUnit = String(root.unitId);
  const rootClaim = await codex.claimUnit(rootUnit, 'execute');
  const child = await codex.standing('cowork.unit.create', a.id, 'execute');
  const helper = toolValue(await codex.tool('flux_create_unit', { ...codex.base(child.id, 'execute'), taskId: a.id, unitKey: 'help',
    expectedTaskVersion: a.version, assignmentConnectionId: claude.connectionId,
    parent: { unitId: rootUnit, generation: rootClaim.generation, leaseId: rootClaim.lease.id } }));
  const helperUnit = String(helper.unitId);
  // The helper unit is pending; claim it so the request can be answered.
  const ask = await codex.standing('cowork.request', rootUnit, 'execute');
  const helperClaim = await claude.claimUnit(helperUnit, 'execute');
  const sent = toolValue(await codex.tool('flux_send_request', { ...codex.base(ask.id, 'execute'), unitId: rootUnit, generation: rootClaim.generation,
    leaseId: rootClaim.lease.id, recipientUnitId: helperUnit, expectedRecipientUnitVersion: await f.unitVersion(helperUnit),
    recipientConnectionId: claude.connectionId, intentKey: 'help-1', parentRequestId: null, kind: 'handoff',
    target: { type: 'work', id: a.id, version: a.version }, sourceRefs: [{ type: 'material', id: f.material.materialId, version: 1 }],
    criteriaRefs: [{ type: 'work', id: a.id, version: a.version }], peerUnblocking: false }));
  // Sending to yourself is refused.
  assert.equal(toolFailure(await codex.tool('flux_send_request', { ...codex.base(ask.id, 'execute'), unitId: rootUnit, generation: rootClaim.generation,
    leaseId: rootClaim.lease.id, recipientUnitId: rootUnit, expectedRecipientUnitVersion: await f.unitVersion(rootUnit),
    recipientConnectionId: codex.connectionId, intentKey: 'self', parentRequestId: null, kind: 'help',
    target: { type: 'work', id: a.id, version: a.version }, sourceRefs: [{ type: 'work', id: a.id, version: a.version }],
    criteriaRefs: [{ type: 'work', id: a.id, version: a.version }], peerUnblocking: false })).code, 'COWORK_SELF_REQUEST');
  const fence = { unitId: helperUnit, generation: helperClaim.generation, leaseId: helperClaim.lease.id, requestId: String(sent.requestId) };
  const claimGrant = await claude.standing('cowork.request.claim', helperUnit, 'execute');
  const claimed = toolValue(await claude.tool('flux_claim_request', { ...claude.base(claimGrant.id, 'execute'), ...fence, expectedRequestVersion: 1 }));
  const respond = await claude.standing('cowork.request.respond', helperUnit, 'execute');
  const evidence = { type: 'material', id: f.material.materialId, version: 1 };
  const input = { ...claude.base(respond.id, 'execute'), ...fence, expectedRequestVersion: Number(claimed.version), evidence };
  assert.equal(toolFailure(await claude.tool('flux_resolve_request', { ...input, verdict: 'passed' })).code, 'COWORK_VERDICT_NOT_REVIEW');
  const resolved = toolValue(await claude.tool('flux_resolve_request', { ...input, clientCommandId: randomUUID() }));
  assert.equal(resolved.state, 'resolved');
  const coordination = expectStatus(await f.hubert.browser.request('GET', `/api/v1/work/${a.id}/coordination`), 200) as TaskCoordination;
  assert.deepEqual(coordination.requests.map((r) => [r.kind, r.state, r.responseRef]), [['handoff', 'resolved', evidence]]);
  assert.deepEqual(coordination.verdicts, []);
});

test('the recipient defers a queued request with a reason and boundary without claiming; status is honest: queued, deferred, offline, working, cancelled', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A');
  const take = await codex.standing('cowork.unit.create', a.id, 'execute');
  const root = toolValue(await codex.tool('flux_create_unit', { ...codex.base(take.id, 'execute'), taskId: a.id, unitKey: 'take',
    expectedTaskVersion: a.version, assignmentConnectionId: codex.connectionId, parent: null }));
  const rootUnit = String(root.unitId);
  const rootClaim = await codex.claimUnit(rootUnit, 'execute');
  const openHelp = await codex.standing('cowork.unit.create', a.id, 'plan');
  const helper = toolValue(await codex.tool('flux_create_unit', { ...codex.base(openHelp.id, 'plan'), taskId: a.id, unitKey: 'help',
    expectedTaskVersion: a.version, assignmentConnectionId: marekClaude.connectionId,
    parent: { unitId: rootUnit, generation: rootClaim.generation, leaseId: rootClaim.lease.id } }));
  const helpUnit = String(helper.unitId);
  const ask = await codex.standing('cowork.request', rootUnit, 'execute');
  const target = { type: 'work', id: a.id, version: a.version };
  const send = async (intentKey: string, kind: string) => { const reply = await codex.tool('flux_send_request', { ...codex.base(ask.id, 'execute'),
    unitId: rootUnit, generation: rootClaim.generation, leaseId: rootClaim.lease.id, recipientUnitId: helpUnit,
    expectedRecipientUnitVersion: await f.unitVersion(helpUnit), recipientConnectionId: marekClaude.connectionId, intentKey, parentRequestId: null,
    kind, target, sourceRefs: [{ type: 'material', id: f.material.materialId, version: 1 }], criteriaRefs: [target], peerUnblocking: false });
    if ((reply?.result as { isError?: boolean } | undefined)?.isError) assert.fail(JSON.stringify(toolFailure(reply)));
    return toolValue(reply); };
  const sent = await send('help-1', 'help');
  const requestId = String(sent.requestId);
  const second = await send('handoff-1', 'handoff');
  const read = async () => (expectStatus(await f.hubert.browser.request('GET', `/api/v1/work/${a.id}/coordination`), 200) as TaskCoordination).requests;
  const card = async (id = requestId) => (await read()).find((r) => r.id === id)!;
  assert.deepEqual([(await card()).state, (await card()).status, (await card()).nextBoundary], ['queued', 'queued', null]);

  // Deferral: no claim on the recipient's unit is needed, a busy peer is not interrupted, and the sender sees why.
  const respond = await marekClaude.standing('cowork.request.respond', helpUnit, 'plan');
  const defer = (change: Record<string, unknown> = {}, clientCommandId: string = randomUUID()) => marekClaude.tool('flux_defer_request',
    { ...marekClaude.base(respond.id, 'plan', clientCommandId), unitId: helpUnit, requestId, expectedRequestVersion: 1, reason: 'busy',
      nextBoundary: 'after_step', ...change });
  assert.equal(toolFailure(await defer({ reason: 'dependency', nextBoundary: 'after_step' })).code, 'INVALID_INPUT', 'a dependency names its record');
  assert.ok(schemaRefused(await defer({ reason: 'because' })), 'free-text reasons are refused by the schema');
  assert.equal(toolFailure(await defer({ expectedRequestVersion: 7 })).code, 'COWORK_VERSION_CONFLICT');
  assert.equal(await f.used(respond.id), 0, 'refusals debit nothing');
  const command = randomUUID();
  const deferred = toolValue(await defer({}, command));
  assert.deepEqual(deferred, { requestId, version: 2, state: 'deferred', responseRef: null });
  assert.deepEqual(toolValue(await defer({}, command)), deferred, 'a retry replays');
  assert.equal(await f.used(respond.id), 1);
  assert.deepEqual([await card()].map((r) => [r.state, r.status, r.reason, r.nextBoundary]), [['deferred', 'deferred', 'busy', 'after_step']]);
  const inbox = toolValue(await marekClaude.tool('flux_coordination_inbox', { projectId: f.p.id })).requests as { id: string; state: string; status: string }[];
  assert.deepEqual(inbox.map((r) => [r.id === requestId ? 'deferred one' : 'other', r.state, r.status]),
    [['deferred one', 'deferred', 'deferred'], ['other', 'queued', 'queued']]);
  // It can be deferred again to a dependency, naming an exact current record.
  const redeferred = toolValue(await defer({ expectedRequestVersion: 2, reason: 'dependency', nextBoundary: 'on_dependency',
    dependencyRef: { type: 'material', id: f.material.materialId, version: 1 } }));
  assert.equal(redeferred.version, 3);
  // Another connection cannot defer it.
  const codexRespond = await codex.standing('cowork.request.respond', null, 'plan');
  assert.equal(toolFailure(await codex.tool('flux_defer_request', { ...codex.base(codexRespond.id, 'plan'), unitId: helpUnit, requestId,
    expectedRequestVersion: 3, reason: 'busy', nextBoundary: 'after_step' })).code, 'COWORK_UNIT_NOT_FOUND');

  // A recipient without a live session is offline, whatever the request says; its return makes it deferred again.
  await pool.query('UPDATE agent_runtime_sessions SET revoked_at = now() WHERE connection_id = $1', [marekClaude.connectionId]);
  assert.equal((await card()).status, 'offline');
  await pool.query('UPDATE agent_runtime_sessions SET revoked_at = NULL WHERE connection_id = $1', [marekClaude.connectionId]);
  assert.equal((await card()).status, 'deferred');

  // Taking it up shows it as working; a claimed request is answered, not deferred.
  const unitClaim = await marekClaude.claimUnit(helpUnit, 'plan', await f.unitVersion(helpUnit));
  const claimGrant = await marekClaude.standing('cowork.request.claim', helpUnit, 'plan');
  const claimed = toolValue(await marekClaude.tool('flux_claim_request', { ...marekClaude.base(claimGrant.id, 'plan'), unitId: helpUnit,
    generation: unitClaim.generation, leaseId: unitClaim.lease.id, requestId, expectedRequestVersion: 3 }));
  assert.equal(claimed.state, 'claimed');
  assert.deepEqual([(await card()).state, (await card()).status], ['claimed', 'working']);
  assert.equal(toolFailure(await defer({ expectedRequestVersion: Number(claimed.version) })).code, 'COWORK_REQUEST_CLAIMED');
  // A claim its unit no longer backs (the lease ran out) is reported as lost, not as still claimed.
  await pool.query("UPDATE cowork_units SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [helpUnit]);
  assert.equal(toolFailure(await defer({ expectedRequestVersion: Number(claimed.version) })).code, 'COWORK_CLAIM_LOST');

  // A cancelled request is shown as cancelled, not as lost or still waiting.
  await pool.query(`UPDATE cowork_requests SET state='cancelled', reason='sender_cancelled', version=version+1 WHERE id=$1`, [second.requestId]);
  assert.deepEqual([(await card(String(second.requestId))).state, (await card(String(second.requestId))).status], ['cancelled', 'cancelled']);
});

/** A strict schema refusal: the SDK reports it as a tool error or a JSON-RPC error, never a domain effect. */
function schemaRefused(message: Record<string, unknown> | null) {
  return !!message?.error || (message?.result as { isError?: boolean } | undefined)?.isError === true;
}
