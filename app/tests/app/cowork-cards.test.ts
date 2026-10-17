import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { CoWorkHandoffPacket, ConversationMessage, CoWorkReviewPolicy, TaskCoordination, WorkItem } from '@flux/contracts';
import { pool } from './support/db.js';
import { toolFailure } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { expectStatus, type Person } from './support/people.js';
import { coworkScene, failureCode, type CoworkConn } from './support/cowork-scene.js';

// #153 AC-2/AC-4 and #400 AC-4 over the real OAuth bearer and the people's HTTP API: a task's request cards, the
// reference packet a person downloads, cancelling an open request, and a project's explicit review rule. Every path has
// its negative controls: another owner, a contributor who owns nothing, a viewer, a stranger and a removed reader.
// Docker regression evidence, not real-client evidence.

const coordination = (workId: string) => `/api/v1/work/${workId}/coordination`;
const cancelPath = (workId: string, requestId: string) => `${coordination(workId)}/requests/${requestId}/cancel`;
const packetPath = (workId: string, requestId: string) => `${coordination(workId)}/requests/${requestId}/packet`;
const read = async (who: Person, workId: string) => expectStatus(await who.browser.request('GET', coordination(workId)), 200) as TaskCoordination;
const cancel = (who: Person, workId: string, requestId: string, expectedVersion: number) =>
  who.browser.request('POST', cancelPath(workId, requestId), { body: { expectedVersion } });

test('a card names kind, sender and recipient with their owners, the target by title and where to open its message; each reader sees what they may do', async () => {
  const f = await coworkScene();
  const codex = await f.connect(f.hubert, 'Codex'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A');
  const thread = expectStatus(await f.hubert.browser.request('POST', `/api/v1/work/${a.id}/agent-thread`,
    { body: { body: 'Please review the finished comparison and say what is missing.', clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  const review = await f.startReview(codex, marekClaude, a);
  const sent = toolValue(await review.send('review-1', { type: 'work', id: a.id, version: a.version },
    { sourceRefs: [{ type: 'message', id: thread.id }, { type: 'material', id: f.material.materialId, version: 1 }] }));

  const hubertView = await read(f.hubert, a.id);
  const [card] = hubertView.requests;
  assert.equal(hubertView.requests.length, 1);
  assert.deepEqual({ ...card, createdAt: undefined, updatedAt: undefined, expiresAt: undefined }, {
    id: sent.requestId, kind: 'review', state: 'queued', version: 1, status: 'queued', reason: null, nextBoundary: null,
    target: { type: 'work', id: a.id, version: a.version }, targetTitle: `#${a.number} Native outcome A`, targetAvailable: true, responseRef: null,
    originalMessage: { messageId: thread.id, conversationId: thread.conversationId, space: 'agents', taskId: a.id },
    sender: { connectionId: codex.connectionId, name: 'Codex', ownerName: 'cw-hubert' },
    recipient: { connectionId: marekClaude.connectionId, name: 'Marek Claude', ownerName: 'cw-marek' },
    cancelledBy: null, canCancel: true, createdAt: undefined, updatedAt: undefined, expiresAt: undefined });
  assert.ok(Date.parse(card!.expiresAt) > Date.now(), 'the card says when the request lapses');

  // What each reader may do: a manager and the owners of the two agents may cancel; the others only read.
  const can = async (who: Person) => (await read(who, a.id)).requests[0]!.canCancel;
  assert.deepEqual([await can(f.hubert), await can(f.marek), await can(f.ada), await can(f.vera)], [true, true, false, false]);
  // Marek stops managing the project: as the recipient agent's owner he still may; Ada, who owns neither agent, still may not.
  await f.demote(f.marek);
  assert.deepEqual([await can(f.marek), await can(f.ada)], [true, false]);
  // Nothing internal reaches a reader: no owner ID, fingerprint, lease, grant or runtime.
  const text = JSON.stringify(hubertView);
  for (const secret of [f.hubert.id, f.marek.id, 'fingerprint', 'lease', 'grant', 'runtime', 'generation']) assert.ok(!text.includes(secret), `the card leaks ${secret}`);
  // A stranger, a signed-out caller and a request for another task read nothing.
  expectStatus(await f.olga.browser.request('GET', coordination(a.id)), 404);
  const other = await f.task('Another task');
  assert.deepEqual((await read(f.hubert, other.id)).requests, [], 'a task shows only its own requests');
});

test('the packet is a bounded reference packet: titles only while they exist at the named versions, the last checkpoint, no secrets', async () => {
  const f = await coworkScene();
  const codex = await f.connect(f.hubert, 'Codex'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A'), b = await f.task('Unrelated task');
  const thread = expectStatus(await f.hubert.browser.request('POST', `/api/v1/work/${a.id}/agent-thread`,
    { body: { body: 'Please review the finished comparison and say what is missing.', clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  const review = await f.startReview(codex, marekClaude, a);
  const target = { type: 'work', id: a.id, version: a.version };
  const sent = toolValue(await review.send('review-1', target,
    { sourceRefs: [{ type: 'message', id: thread.id }, { type: 'material', id: f.material.materialId, version: 1 }] }));
  const requestId = String(sent.requestId);

  // The recipient parks its unit with a checkpoint: it is what a hand-over carries.
  const release = await marekClaude.standing('cowork.release', review.reviewUnit, 'review');
  toolValue(await marekClaude.call('flux_release_unit', { ...marekClaude.base(release.id, 'review'), unitId: review.reviewUnit,
    expectedVersion: review.reviewClaim.version, generation: review.reviewClaim.generation, leaseId: review.reviewClaim.lease.id,
    checkpoint: { summary: 'Read the plan and the first finding', nextAction: 'Compare the second finding with the baseline', blocker: null },
    sources: [{ materialId: f.material.materialId, version: 1 }] }));

  const response = await f.hubert.browser.request('GET', packetPath(a.id, requestId));
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-disposition')), new RegExp(`^attachment; filename="flux-handoff-${a.number}-${requestId.slice(0, 8)}\\.json"$`));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(String(response.headers.get('content-type')), /^application\/json/);
  const packet = response.json as CoWorkHandoffPacket;
  assert.equal(packet.schema, 'flux.cowork.packet/1');
  assert.deepEqual(packet.task, { id: a.id, number: a.number, title: 'Native outcome A', status: a.status, version: a.version });
  assert.deepEqual([packet.request.id, packet.request.kind, packet.request.state, packet.request.sender, packet.request.recipient],
    [requestId, 'review', 'queued', { name: 'Codex', ownerName: 'cw-hubert' }, { name: 'Marek Claude', ownerName: 'cw-marek' }]);
  assert.deepEqual(packet.target, { type: 'work', id: a.id, version: a.version, title: `#${a.number} Native outcome A`, available: true });
  // The request keeps its sources in a canonical order of its own; the packet follows it.
  const byType = (references: CoWorkHandoffPacket['sources']) => [...references].sort((a, b) => a.type.localeCompare(b.type));
  assert.deepEqual(byType(packet.sources), [
    { type: 'material', id: f.material.materialId, version: 1, title: 'Review findings', available: true },
    { type: 'message', id: thread.id, version: null, title: 'Please review the finished comparison and say what is missing.', available: true }]);
  assert.deepEqual(packet.originalMessage, { messageId: thread.id, conversationId: thread.conversationId, space: 'agents', taskId: a.id });
  assert.deepEqual(packet.checkpoint && { ...packet.checkpoint, createdAt: undefined }, { summary: 'Read the plan and the first finding',
    nextAction: 'Compare the second finding with the baseline', blocker: null, sources: [{ materialId: f.material.materialId, version: 1 }], createdAt: undefined });
  assert.equal(packet.verdict, null);
  // No credential, grant, lease, fingerprint, owner ID, connection ID or prompt is in it.
  const text = JSON.stringify(packet);
  for (const secret of [f.hubert.id, f.marek.id, codex.connectionId, marekClaude.connectionId, 'fingerprint', 'leaseId', 'grantId', 'token', 'secret'])
    assert.ok(!text.includes(secret), `the packet leaks ${secret}`);

  // A reference that moved on is listed as unavailable with no title: nothing about it is shown.
  expectStatus(await f.hubert.browser.request('PATCH', `/api/v1/materials/${f.material.materialId}`, { body: { clientMutationId: randomUUID(),
    expectedVersion: 1, body: 'A third finding' } }), 200);
  const moved = (await f.hubert.browser.request('GET', packetPath(a.id, requestId))).json as CoWorkHandoffPacket;
  assert.deepEqual(moved.sources.find((source) => source.type === 'material'), { type: 'material', id: f.material.materialId, version: 1, title: null, available: false });

  // Anyone who can read the task downloads it; nobody else does, and it is bound to its own task.
  for (const reader of [f.vera, f.marek]) assert.equal((await reader.browser.request('GET', packetPath(a.id, requestId))).status, 200);
  assert.equal((await f.olga.browser.request('GET', packetPath(a.id, requestId))).status, 404);
  assert.equal((await f.hubert.browser.request('GET', packetPath(b.id, requestId))).status, 404, 'another task\'s path does not reach it');
  assert.equal((await f.hubert.browser.request('GET', packetPath(a.id, randomUUID()))).status, 404);
  assert.equal((await f.hubert.browser.request('GET', packetPath(a.id, 'not-an-id'))).status, 404);
  // A reader whose access is removed loses it at once.
  assert.equal((await f.ada.browser.request('GET', packetPath(a.id, requestId))).status, 200);
  await f.removeAccess(f.ada);
  assert.equal((await f.ada.browser.request('GET', packetPath(a.id, requestId))).status, 404);
  assert.equal((await f.ada.browser.request('GET', coordination(a.id))).status, 404);
});

test('cancelling: a manager and the owners of the sender and recipient may, others are refused, and the recipient is told the request is closed', async () => {
  const f = await coworkScene();
  const codex = await f.connect(f.hubert, 'Codex'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A');
  const review = await f.startReview(codex, marekClaude, a);
  const target = { type: 'work', id: a.id, version: a.version };
  const sent = toolValue(await review.send('review-1', target));
  const requestId = String(sent.requestId);
  const before = await f.request(requestId);
  // The grants are minted while Marek still manages the project; later he is only a contributor who owns his agent.
  const claimGrant = await marekClaude.standing('cowork.request.claim', review.reviewUnit, 'review');

  // Negative controls leave the request untouched: a contributor who owns neither agent, a viewer, a stranger, a wrong
  // version, a malformed command, a request of another task and a signed-out caller.
  assert.equal((await cancel(f.ada, a.id, requestId, 1)).status, 403);
  assert.equal(((await cancel(f.ada, a.id, requestId, 1)).json as { code: string }).code, 'COWORK_CANCEL_NOT_ALLOWED');
  assert.equal((await cancel(f.vera, a.id, requestId, 1)).status, 403);
  assert.equal((await cancel(f.olga, a.id, requestId, 1)).status, 404);
  assert.equal((await cancel(f.hubert, a.id, requestId, 7)).status, 409);
  assert.equal(((await cancel(f.hubert, a.id, requestId, 7)).json as { code: string }).code, 'COWORK_VERSION_CONFLICT');
  assert.equal((await f.hubert.browser.request('POST', cancelPath(a.id, requestId), { body: { expectedVersion: 1, extra: true } })).status, 400);
  assert.equal((await f.hubert.browser.request('POST', cancelPath(a.id, requestId), { body: {} })).status, 400);
  const elsewhere = await f.task('Another task');
  assert.equal((await cancel(f.hubert, elsewhere.id, requestId, 1)).status, 404, 'a request is cancelled only through its own task');
  assert.equal((await cancel(f.hubert, a.id, randomUUID(), 1)).status, 404);
  assert.deepEqual(await f.request(requestId), before);

  // The owner of the recipient agent (a contributor now, not a manager) cancels it.
  await f.demote(f.marek);
  const done = await cancel(f.marek, a.id, requestId, 1);
  assert.equal(done.status, 200);
  const card = done.json as TaskCoordination['requests'][number];
  assert.deepEqual([card.state, card.status, card.version, card.cancelledBy, card.canCancel], ['cancelled', 'cancelled', 2, { name: 'cw-marek' }, false]);
  assert.deepEqual(await f.request(requestId), { state: 'cancelled', version: 2, reason: 'cancelled_by_person', cancelledBy: f.marek.id });
  // A repeat of the same command (a lost answer) succeeds without a second change; a stranger still learns nothing.
  assert.equal((await cancel(f.marek, a.id, requestId, 1)).status, 200);
  assert.equal((await cancel(f.hubert, a.id, requestId, 1)).status, 200);
  assert.equal((await f.request(requestId)).version, 2);
  assert.equal((await cancel(f.ada, a.id, requestId, 2)).status, 403);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE kind = 'project.cowork_request_cancelled.v1'")).rows[0].n, 1, 'one change, one event');

  // The recipient agent no longer sees it, and claiming it is refused; its grant is not debited.
  const inbox = toolValue(await marekClaude.call('flux_coordination_inbox', { projectId: f.p.id })).requests as unknown[];
  assert.deepEqual(inbox, []);
  const fence = { unitId: review.reviewUnit, generation: review.reviewClaim.generation, leaseId: review.reviewClaim.lease.id, requestId };
  assert.equal(toolFailure(await marekClaude.call('flux_claim_request', { ...marekClaude.base(claimGrant.id, 'review'), ...fence, expectedRequestVersion: 2 })).code,
    'COWORK_REQUEST_CLOSED');
  assert.equal(await f.used(claimGrant.id), 0);
  // The author may ask again: a cancelled request is history, not a block.
  assert.equal(toolValue(await review.send('review-2', target)).status, 'created');
});

test('cancelling a claimed request closes it: the agent\'s answer is refused and no verdict is recorded; a resolved or expired request cannot be cancelled', async () => {
  const f = await coworkScene();
  const codex = await f.connect(f.hubert, 'Codex'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A');
  const review = await f.startReview(codex, marekClaude, a);
  const target = { type: 'work', id: a.id, version: a.version };
  const evidence = { type: 'material', id: f.material.materialId, version: 1 };
  const claimOne = async (id: string, version = 1) => {
    const g = await marekClaude.standing('cowork.request.claim', review.reviewUnit, 'review');
    return toolValue(await marekClaude.call('flux_claim_request', { ...marekClaude.base(g.id, 'review'), unitId: review.reviewUnit,
      generation: review.reviewClaim.generation, leaseId: review.reviewClaim.lease.id, requestId: id, expectedRequestVersion: version })) as { version: number };
  };
  const respond = await marekClaude.standing('cowork.request.respond', review.reviewUnit, 'review');
  const resolve = (id: string, version: number) => marekClaude.call('flux_resolve_request', { ...marekClaude.base(respond.id, 'review'),
    unitId: review.reviewUnit, generation: review.reviewClaim.generation, leaseId: review.reviewClaim.lease.id, requestId: id,
    expectedRequestVersion: version, evidence, verdict: 'passed' });

  const first = String(toolValue(await review.send('review-1', target)).requestId);
  const claimed = await claimOne(first);
  // A claimed request is cancelled at the version the person saw: the claim moved it on, so the old version is refused.
  assert.equal(((await cancel(f.hubert, a.id, first, 1)).json as { code: string }).code, 'COWORK_VERSION_CONFLICT');
  const gone = await cancel(f.hubert, a.id, first, claimed.version);
  assert.equal(gone.status, 200);
  assert.equal((gone.json as { state: string }).state, 'cancelled');
  assert.equal(toolFailure(await resolve(first, claimed.version + 1)).code, 'COWORK_REQUEST_CLOSED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_review_verdicts WHERE work_id = $1', [a.id])).rows[0].n, 0);
  assert.equal(await f.used(respond.id), 0, 'the refused answer debited nothing');

  // A resolved request is closed for good.
  const second = String(toolValue(await review.send('review-2', target)).requestId);
  const secondClaim = await claimOne(second);
  toolValue(await resolve(second, secondClaim.version));
  const closed = await cancel(f.hubert, a.id, second, secondClaim.version + 1);
  assert.deepEqual([closed.status, (closed.json as { code: string }).code], [409, 'COWORK_REQUEST_CLOSED']);
  assert.equal((await read(f.hubert, a.id)).verdicts.length, 1, 'cancelling elsewhere never touched the recorded verdict');

  // An expired request reads expired, offers no cancel and is refused with its own code.
  const third = String(toolValue(await review.send('review-3', target)).requestId);
  await pool.query("UPDATE cowork_requests SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [third]);
  const lapsed = (await read(f.hubert, a.id)).requests.find((item) => item.id === third)!;
  assert.deepEqual([lapsed.state, lapsed.status, lapsed.canCancel], ['expired', 'expired', false]);
  const refused = await cancel(f.hubert, a.id, third, 1);
  assert.deepEqual([refused.status, (refused.json as { code: string }).code], [409, 'COWORK_REQUEST_EXPIRED']);
});

test('the owner of the sender cancels, a removed reader cannot, and the owner of a revoked connection still can', async () => {
  const f = await coworkScene();
  // Marek\'s agent asks Hubert\'s: the sender\'s owner is a contributor, the recipient\'s owner a manager.
  const marekClaude = await f.connect(f.marek, 'Marek Claude'), codex = await f.connect(f.hubert, 'Codex');
  const a = await f.task('Native outcome A');
  const review = await f.startReview(marekClaude, codex, a);
  const target = { type: 'work', id: a.id, version: a.version };
  const first = String(toolValue(await review.send('review-1', target)).requestId);
  await f.demote(f.marek);
  assert.equal((await cancel(f.ada, a.id, first, 1)).status, 403);
  assert.equal((await cancel(f.marek, a.id, first, 1)).status, 200, 'the sender\'s owner may');
  const second = String(toolValue(await review.send('review-2', target)).requestId);
  // The recipient\'s owner is a manager here, so a plain contributor owning neither is still refused.
  assert.equal((await cancel(f.ada, a.id, second, 1)).status, 403);

  // Revoking the sender\'s connection leaves its owner able to clear what it asked; losing project access does not.
  expectStatus(await f.marek.browser.request('DELETE', `/api/v1/agent-connections/${marekClaude.connectionId}`), 204);
  const card = (await read(f.hubert, a.id)).requests.find((item) => item.id === second)!;
  assert.equal(card.canCancel, true);
  await f.removeAccess(f.marek);
  assert.equal((await cancel(f.marek, a.id, second, 1)).status, 404, 'a removed reader cannot reach it');
  assert.equal((await f.request(second)).state, 'queued');
  assert.equal((await cancel(f.hubert, a.id, second, 1)).status, 200, 'the manager still can');
});

test('a project\'s review rule: readers see it, only a manager changes it, and it decides who may be given a review', async () => {
  const f = await coworkScene();
  const policyPath = `/api/v1/projects/${f.p.id}/review-policy`;
  const codex = await f.connect(f.hubert, 'Codex'), hubertClaude = await f.connect(f.hubert, 'Hubert Claude'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const policy = async (who: Person) => expectStatus(await who.browser.request('GET', policyPath), 200) as CoWorkReviewPolicy;
  assert.deepEqual(await policy(f.hubert), { projectId: f.p.id, reviewSeparation: 'distinct_connection', updatedAt: null, updatedBy: null });
  for (const reader of [f.marek, f.vera]) assert.equal((await policy(reader)).reviewSeparation, 'distinct_connection');
  expectStatus(await f.olga.browser.request('GET', policyPath), 404);

  // By default another connection of the author's own owner may review.
  const a = await f.task('Native outcome A');
  const held = await f.take(codex, a);
  const sameOwner = await f.openUnit(codex, held, a, 'review', hubertClaude, 'same-owner');
  assert.ok(sameOwner);
  assert.equal(toolFailure(await codex.call('flux_create_unit', { ...codex.base((await codex.standing('cowork.unit.create', a.id, 'review')).id, 'review'),
    taskId: a.id, unitKey: 'self', expectedTaskVersion: a.version, assignmentConnectionId: codex.connectionId,
    parent: { unitId: held.unitId, generation: held.claim.generation, leaseId: held.claim.lease.id } })).code, 'COWORK_REVIEW_SEPARATION',
  'an author never reviews its own work');

  // Who may change it: not a contributor, not a viewer, not a stranger; bad values and extra fields are refused.
  const put = (who: Person, body: unknown) => who.browser.request('PUT', policyPath, { body });
  assert.equal((await put(f.ada, { reviewSeparation: 'distinct_owner' })).status, 403);
  await f.demote(f.marek);
  assert.equal((await put(f.marek, { reviewSeparation: 'distinct_owner' })).status, 403, 'owning an agent is not managing the project');
  assert.equal((await put(f.vera, { reviewSeparation: 'distinct_owner' })).status, 403);
  assert.equal((await put(f.olga, { reviewSeparation: 'distinct_owner' })).status, 404);
  assert.equal((await put(f.hubert, { reviewSeparation: 'anyone' })).status, 400);
  assert.equal((await put(f.hubert, { reviewSeparation: 'distinct_owner', extra: 1 })).status, 400);
  assert.equal((await put(f.hubert, {})).status, 400);
  assert.equal((await policy(f.hubert)).reviewSeparation, 'distinct_connection');

  // A manager requires another owner: the review that was allowed before is now refused, a new owner's is not.
  const tightened = await put(f.hubert, { reviewSeparation: 'distinct_owner' });
  assert.equal(tightened.status, 200);
  const stored = tightened.json as CoWorkReviewPolicy;
  assert.deepEqual([stored.reviewSeparation, stored.updatedBy?.name], ['distinct_owner', 'cw-hubert']);
  assert.ok(stored.updatedAt);
  assert.equal(failureCode(await codex.call('flux_create_unit', { ...codex.base((await codex.standing('cowork.unit.create', a.id, 'review')).id, 'review'),
    taskId: a.id, unitKey: 'same-owner-2', expectedTaskVersion: a.version, assignmentConnectionId: hubertClaude.connectionId,
    parent: { unitId: held.unitId, generation: held.claim.generation, leaseId: held.claim.lease.id } })), 'COWORK_REVIEW_SEPARATION');
  const otherOwner = await f.openUnit(codex, held, a, 'review', marekClaude, 'other-owner');
  assert.ok(otherOwner);
  // A request to the review unit that was created under the old rule is refused under the new one.
  const reviewClaim = await hubertClaude.claimUnit(sameOwner, 'review');
  const ask = await codex.standing('cowork.request', held.unitId, 'execute');
  assert.equal(failureCode(await codex.call('flux_send_request', { ...codex.base(ask.id, 'execute'), unitId: held.unitId, generation: held.claim.generation,
    leaseId: held.claim.lease.id, recipientUnitId: sameOwner, expectedRecipientUnitVersion: reviewClaim.version, recipientConnectionId: hubertClaude.connectionId,
    intentKey: 'review-1', parentRequestId: null, kind: 'review', target: { type: 'work', id: a.id, version: a.version },
    sourceRefs: [{ type: 'work', id: a.id, version: a.version }], criteriaRefs: [{ type: 'work', id: a.id, version: a.version }], peerUnblocking: false })),
  'COWORK_REVIEW_SEPARATION');
  assert.equal(await f.used(ask.id), 0, 'the refused request debited nothing');

  // Loosening it again takes effect for the next command, and the change is recorded once.
  assert.equal((await put(f.hubert, { reviewSeparation: 'distinct_connection' })).status, 200);
  assert.equal((await policy(f.marek)).reviewSeparation, 'distinct_connection');
  assert.equal(toolValue(await codex.call('flux_send_request', { ...codex.base(ask.id, 'execute'), unitId: held.unitId, generation: held.claim.generation,
    leaseId: held.claim.lease.id, recipientUnitId: sameOwner, expectedRecipientUnitVersion: reviewClaim.version, recipientConnectionId: hubertClaude.connectionId,
    intentKey: 'review-1', parentRequestId: null, kind: 'review', target: { type: 'work', id: a.id, version: a.version },
    sourceRefs: [{ type: 'work', id: a.id, version: a.version }], criteriaRefs: [{ type: 'work', id: a.id, version: a.version }], peerUnblocking: false })).status, 'created');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE kind = 'project.cowork_review_policy_changed.v1'")).rows[0].n, 2);
  // Agents never meet the rule as data: it is not in the inbox or bootstrap, only in a refusal.
  assert.ok(!JSON.stringify(toolValue(await hubertClaude.call('flux_coordination_inbox', { projectId: f.p.id }))).includes('distinct_'));
});

/** The four objects of a handed-over review: the task, its author and reviewer connections and the reviewer's grant helpers. */
async function reviewed(f: Awaited<ReturnType<typeof coworkScene>>, author: CoworkConn, reviewer: CoworkConn, t: WorkItem, key = 'r1') {
  const review = await f.startReview(author, reviewer, t, key);
  const respond = await reviewer.standing('cowork.request.respond', review.reviewUnit, 'review');
  const claimGrant = await reviewer.standing('cowork.request.claim', review.reviewUnit, 'review');
  const fence = (requestId: string) => ({ unitId: review.reviewUnit, generation: review.reviewClaim.generation, leaseId: review.reviewClaim.lease.id, requestId });
  const verdict = async (requestId: string, version: number, outcome: 'passed' | 'changes_requested') => {
    const claimed = toolValue(await reviewer.call('flux_claim_request', { ...reviewer.base(claimGrant.id, 'review'), ...fence(requestId), expectedRequestVersion: version })) as { version: number };
    return toolValue(await reviewer.call('flux_resolve_request', { ...reviewer.base(respond.id, 'review'), ...fence(requestId), expectedRequestVersion: claimed.version,
      evidence: { type: 'material', id: f.material.materialId, version: 1 }, verdict: outcome }));
  };
  return { ...review, respond, claimGrant, fence, verdict };
}

test('review is by a separate non-author: the author, an execution grant, another reviewer\'s unit and a stale target cannot stand in', async () => {
  const f = await coworkScene();
  const codex = await f.connect(f.hubert, 'Codex'), hubertClaude = await f.connect(f.hubert, 'Hubert Claude'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A');
  const review = await reviewed(f, codex, hubertClaude, a);
  const target = { type: 'work', id: a.id, version: a.version };
  const requestId = String(toolValue(await review.send('review-1', target)).requestId);

  // Another connection\'s grant (or a third connection) cannot answer a request addressed elsewhere; nothing is recorded.
  const wrong = await marekClaude.standing('cowork.request.respond', null, 'review');
  assert.equal(failureCode(await marekClaude.call('flux_resolve_request', { ...marekClaude.base(wrong.id, 'review'), ...review.fence(requestId),
    expectedRequestVersion: 1, evidence: { type: 'work', id: a.id, version: a.version }, verdict: 'passed' })), 'COWORK_UNIT_NOT_FOUND');
  // An execution-class grant cannot claim the review unit or its requests.
  const executeOnly = await hubertClaude.standing('cowork.request.claim', null, 'execute');
  assert.equal(failureCode(await hubertClaude.call('flux_claim_request', { ...hubertClaude.base(executeOnly.id, 'execute'), ...review.fence(requestId), expectedRequestVersion: 1 })),
    'COWORK_UNIT_NOT_FOUND');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_review_verdicts WHERE work_id = $1', [a.id])).rows[0].n, 0);

  // The reviewer (the author\'s own owner, another connection, as the default allows) passes version 1.
  const passed = await review.verdict(requestId, 1, 'passed');
  assert.equal(passed.state, 'resolved');
  let view = await read(f.hubert, a.id);
  assert.deepEqual(view.verdicts.map((v) => [v.verdict, v.reviewer.name, v.author.name, v.current]), [['passed', 'Hubert Claude', 'Codex', true]]);
  assert.notEqual(view.verdicts[0]!.reviewer.connectionId, view.verdicts[0]!.author.connectionId);

  // A new version makes it stale; a changed reviewer asks again under the same standing grant and with its own grant.
  const changed = expectStatus(await f.hubert.browser.request('PATCH', `/api/v1/work/${a.id}`, { body: { title: 'Native outcome A, fixed' },
    headers: { 'if-match': `"${a.version}"` } }), 200) as WorkItem;
  view = await read(f.hubert, a.id);
  assert.deepEqual(view.verdicts.map((v) => v.current), [false]);
  const usedBefore = await f.used(review.ask.id);
  const second = await f.openUnit(codex, review.held, changed, 'review', marekClaude, 'review-b');
  const secondClaim = await marekClaude.claimUnit(second, 'review');
  const askAgain = await codex.call('flux_send_request', { ...codex.base(review.ask.id, 'execute'), unitId: review.held.unitId, generation: review.held.claim.generation,
    leaseId: review.held.claim.lease.id, recipientUnitId: second, expectedRecipientUnitVersion: secondClaim.version, recipientConnectionId: marekClaude.connectionId,
    intentKey: 'review-2', parentRequestId: null, kind: 'review', target: { type: 'work', id: a.id, version: changed.version },
    sourceRefs: [{ type: 'work', id: a.id, version: changed.version }], criteriaRefs: [{ type: 'work', id: a.id, version: changed.version }], peerUnblocking: true });
  const requestTwo = String(toolValue(askAgain).requestId);
  assert.equal(await f.used(review.ask.id), usedBefore + 1, 'the same standing grant covers the new review: no new owner prompt');
  // Marek\'s agent needs its own grants: the first reviewer\'s do not apply to its unit.
  const mClaim = await marekClaude.standing('cowork.request.claim', second, 'review');
  const mRespond = await marekClaude.standing('cowork.request.respond', second, 'review');
  const mFence = { unitId: second, generation: secondClaim.generation, leaseId: secondClaim.lease.id, requestId: requestTwo };
  assert.equal(failureCode(await hubertClaude.call('flux_claim_request', { ...hubertClaude.base(review.claimGrant.id, 'review'), ...mFence, expectedRequestVersion: 1 })),
    'AGENT_EXECUTION_UNAVAILABLE', 'a grant for the first reviewer\'s unit does not cover another unit');
  const mClaimed = toolValue(await marekClaude.call('flux_claim_request', { ...marekClaude.base(mClaim.id, 'review'), ...mFence, expectedRequestVersion: 1 })) as { version: number };
  // Findings on a version that has since moved on are refused; the reviewer declines instead of passing a stale target.
  expectStatus(await f.hubert.browser.request('PATCH', `/api/v1/work/${a.id}`, { body: { title: 'Native outcome A, fixed again' },
    headers: { 'if-match': `"${changed.version}"` } }), 200);
  assert.equal(failureCode(await marekClaude.call('flux_resolve_request', { ...marekClaude.base(mRespond.id, 'review'), ...mFence,
    expectedRequestVersion: mClaimed.version, evidence: { type: 'material', id: f.material.materialId, version: 1 }, verdict: 'changes_requested' })), 'COWORK_SOURCE_UNAVAILABLE');
  view = await read(f.hubert, a.id);
  assert.deepEqual(view.verdicts.map((v) => [v.reviewer.name, v.verdict, v.current]), [['Hubert Claude', 'passed', false]],
    'history keeps the first reviewer\'s verdict; the stale review recorded nothing');
});

test('swapping executor and reviewer is an assignment: the finished unit and its result keep their author, the task keeps its human assignee, each side uses its own grant', async () => {
  const f = await coworkScene();
  const codex = await f.connect(f.hubert, 'Codex'), marekClaude = await f.connect(f.marek, 'Marek Claude');
  const a = await f.task('Native outcome A');
  const owner = expectStatus(await f.hubert.browser.request('GET', `/api/v1/work/${a.id}`), 200) as WorkItem;
  const held = await f.take(codex, a);
  // Codex records the first result and completes its unit with it.
  const results = await codex.standing('result.record', null, 'execute');
  const recorded = toolValue(await codex.call('flux_record_result', { ...codex.base(results.id, 'execute'), sources: [{ materialId: f.material.materialId, version: 1 }],
    result: { title: 'First comparison', finding: 'positive', evidence: 'Both runs agree', workIds: [a.id] } }));
  const complete = await codex.standing('cowork.unit.complete', held.unitId, 'execute');
  const completed = toolValue(await codex.call('flux_complete_unit', { ...codex.base(complete.id, 'execute'), unitId: held.unitId, expectedVersion: held.claim.version,
    generation: held.claim.generation, leaseId: held.claim.lease.id, outcome: { type: 'result', id: String(recorded.resultId) } }));
  assert.equal(completed.state, 'completed');

  // The roles swap: Marek\'s agent now executes in a new run and Codex reviews. Nobody changes login, assignee or past authorship.
  const next = await f.take(marekClaude, a, 'take-2');
  const reviewUnit = await f.openUnit(marekClaude, next, a, 'review', codex, 'review-swapped');
  // Codex\'s execution grant cannot claim a review unit: the swap validates the grant of the new role. A grant naming that unit
  // as an execute unit cannot even be made; a wide execute grant is refused at the claim.
  assert.equal((await codex.who.browser.request('POST', `/api/v1/agent-connections/${codex.connectionId}/action-grants`, { body: { clientCommandId: randomUUID(),
    projectId: f.p.id, operation: 'cowork.claim', peerRequestClass: 'execute', maximumUses: 3, objectId: reviewUnit, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } })).status, 404);
  const executeGrant = await codex.standing('cowork.claim', null, 'execute');
  assert.equal(failureCode(await codex.call('flux_claim_unit', { ...codex.base(executeGrant.id, 'execute'), unitId: reviewUnit, expectedVersion: 1 })), 'COWORK_UNIT_NOT_FOUND');
  assert.equal((await f.unit(reviewUnit)).state, 'pending');
  const reviewClaim = await codex.claimUnit(reviewUnit, 'review');
  assert.equal(reviewClaim.generation, 1);

  const first = await pool.query('SELECT state, assignment_connection_id AS assignee, outcome_ref AS outcome FROM cowork_units WHERE id = $1', [held.unitId]);
  assert.deepEqual(first.rows[0], { state: 'completed', assignee: codex.connectionId, outcome: { type: 'result', id: String(recorded.resultId) } });
  const result = expectStatus(await f.hubert.browser.request('GET', `/api/v1/results/${recorded.resultId}`), 200) as { createdBy: { id: string } };
  assert.equal(result.createdBy.id, codex.agentId, 'the result is still Codex\'s');
  const after = expectStatus(await f.hubert.browser.request('GET', `/api/v1/work/${a.id}`), 200) as WorkItem;
  assert.deepEqual([after.owner, after.version], [owner.owner, owner.version], 'the task\'s human assignee and version are untouched by the swap');
});
