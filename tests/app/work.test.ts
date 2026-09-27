import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { DomainError, type Principal } from '@flux/core';
import type { Agent, Conversation, Decision, Material, Page, Project, Workspace, WorkItem, WorkResult } from '@flux/contracts';
import { workUseCases } from '../../apps/server/src/work/adapters.js';
import type { ClientResponse } from './support/http.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';
import { StreamClient } from './support/stream.js';

// Work items, decisions and results linked to conversations (issue #101): access for two
// people and outsiders, supersede history, pivot parking, If-Match conflicts, idempotent
// retries, events for the stream, and the agent rule (propose, never accept).

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());

const KINDS = ['project.work_created.v1', 'project.work_updated.v1', 'project.decision_proposed.v1', 'project.decision_accepted.v1', 'project.result_recorded.v1', 'project.link_created.v1'];
const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const patch = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('PATCH', path, { body, headers });
const get = (someone: Person, path: string) => someone.browser.request('GET', path);
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
}

describe('work, decisions and results in a project', () => {
  let owner: Person;
  let partner: Person;
  let viewer: Person;
  let outsider: Person;
  let ws: Workspace;
  let lamp: Project;
  let conversation: Conversation;
  let material: Material;
  let agent: Agent;

  before(async () => {
    [owner, partner, viewer, outsider] = await Promise.all(['work-owner', 'work-partner', 'work-viewer', 'work-outsider'].map(person));
    ws = await workspace(owner, 'Maker space');
    for (const someone of [partner, viewer, outsider]) await addMember(owner, ws.id, someone, 'member');
    lamp = await createProject(owner, ws.id, 'Gesture lamp', 'restricted');
    await grant(owner, lamp.id, partner, 'contributor');
    await grant(owner, lamp.id, viewer, 'viewer');
    conversation = json<Conversation>(await post(owner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: 'Camera or sensor? Let us test the camera in low light first.', clientMessageId: randomUUID() }), 201);
    material = json<Material>(await post(owner, `/api/v1/projects/${lamp.id}/materials`,
      { clientMutationId: randomUUID(), title: 'Low-light test plan', body: '5 lux, 20 gestures' }), 201);
    agent = json<Agent>(await post(owner, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Lab helper', owner: 'workspace' }), 201);
    json(await post(owner, `/api/v1/projects/${lamp.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }), 201);
  });

  test('work is created from a message in one action and the message stays in place', async () => {
    const message = conversation.messages[0]!;
    const work = json<WorkItem>(await post(partner, `/api/v1/projects/${lamp.id}/work`, {
      title: 'Test the camera in low light', outcome: 'Know whether the camera tracks gestures at 5 lux',
      owner: { kind: 'human', id: partner.id }, sources: [{ type: 'message', id: message.id }],
    }), 201);
    assert.equal(work.status, 'open');
    assert.equal(work.version, 1);
    assert.deepEqual(work.owner, { kind: 'human', id: partner.id, name: 'work-partner' });
    assert.deepEqual(work.audience, { kind: 'project', projectId: lamp.id });
    assert.deepEqual(work.links.map((link) => [link.role, link.to]), [['source', { type: 'message', id: message.id }]]);
    const thread = json<Conversation>(await get(owner, `/api/v1/conversations/${conversation.id}`), 200);
    assert.equal(thread.messages[0]!.body, message.body, 'the source message is unchanged');
    assert.equal(thread.messages.length, 1, 'no message is copied or moved');

    // A small task needs nothing but a title.
    const small = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Order a PIR sensor' }), 201);
    assert.equal(small.outcome, '');

    // Project readers see it; nobody else learns that it exists.
    assert.equal(json<WorkItem>(await get(viewer, `/api/v1/work/${work.id}`), 200).title, work.title);
    const missing = await get(outsider, `/api/v1/work/${randomUUID()}`);
    const hidden = await get(outsider, `/api/v1/work/${work.id}`);
    assert.equal(hidden.status, 404);
    assert.deepEqual([hidden.json, missing.json].map((body) => (body as { code: string }).code), ['WORK_NOT_FOUND', 'WORK_NOT_FOUND']);
    assert.equal((await get(outsider, `/api/v1/projects/${lamp.id}/work`)).status, 404);
    assert.equal((await post(viewer, `/api/v1/projects/${lamp.id}/work`, { title: 'Viewer cannot add' })).status, 403);
    assert.equal((await post(outsider, `/api/v1/projects/${lamp.id}/work`, { title: 'Outsider cannot add' })).status, 404);

    // Owners and links must be inside the project's audience.
    const noAccess = await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Hand to outsider', owner: { kind: 'human', id: outsider.id } });
    assert.equal(noAccess.status, 422);
    assert.equal((noAccess.json as { code: string }).code, 'OWNER_WITHOUT_ACCESS');
    const elsewhere = await createProject(owner, ws.id, 'Other project', 'restricted');
    const otherThread = json<Conversation>(await post(owner, `/api/v1/projects/${elsewhere.id}/conversations`, { body: 'Elsewhere', clientMessageId: randomUUID() }), 201);
    const foreign = await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Foreign source', sources: [{ type: 'message', id: otherThread.messages[0]!.id }] });
    assert.equal((foreign.json as { code: string }).code, 'LINK_TARGET_NOT_FOUND');
    const list = json<Page<WorkItem>>(await get(partner, `/api/v1/projects/${lamp.id}/work`), 200);
    assert.equal(list.total, 2);
  });

  test('changes need If-Match; stale and concurrent changes get 409 and retries are idempotent', async () => {
    const work = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Sketch the lamp arm' }), 201);
    assert.equal((await patch(owner, `/api/v1/work/${work.id}`, { status: 'in_progress' })).status, 428);
    const fetched = await get(owner, `/api/v1/work/${work.id}`);
    assert.equal(fetched.headers.get('etag'), '"1"');
    const moved = json<WorkItem>(await patch(owner, `/api/v1/work/${work.id}`, { status: 'blocked', blocker: 'Waiting for the hinge' }, { 'if-match': '"1"' }), 200);
    assert.deepEqual([moved.status, moved.blocker, moved.version], ['blocked', 'Waiting for the hinge', 2]);
    const stale = await patch(partner, `/api/v1/work/${work.id}`, { title: 'Stale edit' }, { 'if-match': '"1"' });
    assert.equal(stale.status, 409);
    assert.equal((stale.json as { code: string; currentVersion: number }).currentVersion, 2);

    // Two people change the same version at once: exactly one wins.
    const race = await Promise.all([
      patch(owner, `/api/v1/work/${work.id}`, { status: 'in_progress' }, { 'if-match': '"2"' }),
      patch(partner, `/api/v1/work/${work.id}`, { status: 'not_pursued' }, { 'if-match': '"2"' }),
    ]);
    assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
    const after = json<WorkItem>(await get(owner, `/api/v1/work/${work.id}`), 200);
    assert.equal(after.version, 3);
    assert.equal(after.blocker, null, 'leaving blocked clears the blocker');

    // A lost response is retried with the same Idempotency-Key: one row, one event, same body.
    const key = randomUUID();
    const before = await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id = $1', [lamp.id]);
    const first = await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Print the diffuser' }, { 'idempotency-key': key });
    const retry = await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Print the diffuser' }, { 'idempotency-key': key });
    assert.equal(first.status, 201);
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal((retry.json as WorkItem).id, (first.json as WorkItem).id);
    const rows = await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id = $1 AND title = $2', [lamp.id, 'Print the diffuser']);
    assert.equal(rows.rows[0].n, 1);
    const afterEvents = await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id = $1', [lamp.id]);
    assert.equal(afterEvents.rows[0].n, before.rows[0].n + 1);
    const reused = await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Something else' }, { 'idempotency-key': key });
    assert.equal(reused.status, 422);

    const updateKey = randomUUID();
    const change = { title: 'Print the frosted diffuser' };
    const workId = (first.json as WorkItem).id;
    const changed = await patch(owner, `/api/v1/work/${workId}`, change, { 'if-match': '"1"', 'idempotency-key': updateKey });
    const again = await patch(owner, `/api/v1/work/${workId}`, change, { 'if-match': '"1"', 'idempotency-key': updateKey });
    assert.equal(changed.status, 200);
    assert.equal(again.status, 200, 'the retry replays instead of failing as stale');
    assert.equal((again.json as WorkItem).version, 2);
    assert.equal(again.headers.get('etag'), '"2"');
  });

  test('only people accept decisions; superseding keeps history and a pivot parks obsolete work', async () => {
    const camera = json<WorkItem>(await post(partner, `/api/v1/projects/${lamp.id}/work`, { title: 'Camera gesture prototype', status: 'in_progress' }), 201);
    const enclosure = json<WorkItem>(await post(partner, `/api/v1/projects/${lamp.id}/work`, { title: 'Lamp enclosure' }), 201);
    const message = conversation.messages[0]!;
    const first = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, {
      title: 'Use a camera for gestures', rationale: 'Richest gesture set', affects: [camera.id],
      sources: [{ type: 'message', id: message.id }, { type: 'material', id: material.materialId, version: 1 }],
    }), 201);
    assert.equal(first.status, 'proposed');
    assert.deepEqual(first.links.map((link) => link.role).sort(), ['affects', 'source', 'source']);
    assert.equal((await post(viewer, `/api/v1/decisions/${first.id}/accept`, {}, { 'if-match': '"1"' })).status, 403);
    assert.equal((await post(outsider, `/api/v1/decisions/${first.id}/accept`, {}, { 'if-match': '"1"' })).status, 404);
    assert.equal((await post(owner, `/api/v1/decisions/${first.id}/accept`, {})).status, 428);
    const accepted = json<Decision>(await post(owner, `/api/v1/decisions/${first.id}/accept`, {}, { 'if-match': '"1"' }), 200);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.decidedBy?.id, owner.id);
    assert.equal((await post(owner, `/api/v1/decisions/${first.id}/accept`, {}, { 'if-match': '"2"' })).status, 409);

    // An agent with a contributor grant can propose, never accept.
    const helper: Principal = { kind: 'agent', id: agent.id };
    const agentWork = workUseCases(db);
    const proposal = await agentWork.proposeDecision(helper, lamp.id, { title: 'Try a ToF sensor', rationale: 'Works in the dark', supersedes: first.id });
    assert.deepEqual([proposal.proposedBy.kind, proposal.proposedBy.name], ['agent', 'Lab helper']);
    await rejects(agentWork.acceptDecision(helper, proposal.id, {}, 1), 'DECISION_NEEDS_PERSON');
    await rejects(agentWork.acceptDecision({ kind: 'agent', id: randomUUID() }, proposal.id, {}, 1), 'DECISION_NOT_FOUND');

    // The pivot: a person accepts the agent's proposal, keeps the enclosure, parks the camera work.
    const pivot = json<Decision>(await post(owner, `/api/v1/decisions/${proposal.id}/accept`,
      { stillApplies: [enclosure.id], park: [camera.id] }, { 'if-match': `"${proposal.version}"` }), 200);
    assert.deepEqual([pivot.status, pivot.supersedes, pivot.decidedBy?.name], ['accepted', first.id, 'work-owner']);
    assert.deepEqual(pivot.links.filter((link) => link.role === 'still_applies').map((link) => link.to), [{ type: 'work', id: enclosure.id }]);
    const history = json<Decision>(await get(partner, `/api/v1/decisions/${first.id}`), 200);
    assert.deepEqual([history.status, history.supersededBy, history.rationale, history.decidedBy?.id], ['superseded', proposal.id, 'Richest gesture set', owner.id]);
    const parked = json<WorkItem>(await get(partner, `/api/v1/work/${camera.id}`), 200);
    assert.equal(parked.status, 'in_progress', 'parked work is not called done');
    assert.equal(parked.parked?.decisionId, proposal.id);
    const kept = json<WorkItem>(await get(partner, `/api/v1/work/${enclosure.id}`), 200);
    assert.equal(kept.parked, null);
    assert.ok(kept.links.some((link) => link.role === 'still_applies' && link.from.id === proposal.id));
    const unparked = json<WorkItem>(await patch(partner, `/api/v1/work/${camera.id}`, { parked: false }, { 'if-match': `"${parked.version}"` }), 200);
    assert.equal(unparked.parked, null);

    // Two people accept competing replacements of the same rule at once: exactly one wins.
    const a = json<Decision>(await post(owner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'PIR only', supersedes: proposal.id }), 201);
    const b = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Radar sensor', supersedes: proposal.id }), 201);
    const race = await Promise.all([
      post(owner, `/api/v1/decisions/${a.id}/accept`, {}, { 'if-match': '"1"' }),
      post(partner, `/api/v1/decisions/${b.id}/accept`, {}, { 'if-match': '"1"' }),
    ]);
    assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
    const list = json<Page<Decision>>(await get(viewer, `/api/v1/projects/${lamp.id}/decisions`), 200);
    assert.equal(list.items.filter((item) => item.status === 'accepted').length, 1, 'one current rule');
    assert.equal(list.items.filter((item) => item.status === 'superseded').length, 2, 'earlier rules stay as history');
    const loser = race[0]!.status === 200 ? b : a;
    const loserCode = (race[0]!.status === 200 ? race[1]! : race[0]!).json as { code: string };
    assert.equal(loserCode.code, 'SUPERSEDED_DECISION_CHANGED');
    const invalid = await post(owner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Replace a proposal', supersedes: loser.id });
    assert.equal((invalid.json as { code: string }).code, 'SUPERSEDES_NOT_CURRENT', 'only an accepted rule can be replaced');
  });

  test('a negative result finishes an experiment and links its evidence', async () => {
    const experiment = json<WorkItem>(await post(partner, `/api/v1/projects/${lamp.id}/work`, { title: 'Camera in low light', status: 'in_progress', owner: { kind: 'human', id: partner.id } }), 201);
    const reply = json<{ id: string }>(await post(partner, `/api/v1/conversations/${conversation.id}/messages`,
      { body: '38% of gestures caught at 5 lux.', clientMessageId: randomUUID() }), 201);
    const decisions = json<Page<Decision>>(await get(partner, `/api/v1/projects/${lamp.id}/decisions`), 200).items;
    const rule = decisions.find((item) => item.status === 'accepted')!;
    const result = json<WorkResult>(await post(partner, `/api/v1/projects/${lamp.id}/results`, {
      title: 'The camera cannot track gestures below 10 lux', finding: 'negative', evidence: '38% at 5 lux over 20 gestures',
      sources: [{ type: 'message', id: reply.id }], work: [experiment.id], decisions: [rule.id], finishes: experiment.id,
    }), 201);
    assert.equal(result.finding, 'negative');
    assert.deepEqual(result.links.map((link) => `${link.role}:${link.to.type}`).sort(), ['about:decision', 'about:work', 'source:message']);
    const finished = json<WorkItem>(await get(owner, `/api/v1/work/${experiment.id}`), 200);
    assert.equal(finished.status, 'done');
    assert.ok(finished.links.some((link) => link.role === 'about' && link.from.id === result.id));
    assert.equal((await post(viewer, `/api/v1/projects/${lamp.id}/results`, { title: 'No', finding: 'positive' })).status, 403);
    assert.equal((await get(outsider, `/api/v1/results/${result.id}`)).status, 404);
    const linked = json<{ role: string }>(await post(owner, `/api/v1/projects/${lamp.id}/links`, {
      from: { type: 'result', id: result.id }, to: { type: 'material', id: material.materialId, version: 1 },
    }), 201);
    assert.equal(linked.role, 'related');
  });

  test('events reach only project readers; assigned work uses the visibility filter and access loss hides everything', async () => {
    const [partnerLive, outsiderLive] = await Promise.all([StreamClient.connect(partner.browser), StreamClient.connect(outsider.browser)]);
    try {
      await Promise.all([partnerLive.ready(), outsiderLive.ready()]);
      const work = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Wire the sensor', owner: { kind: 'human', id: partner.id } }), 201);
      await partnerLive.until(() => partnerLive.events.find((event) => event.kind === 'project.work_created.v1' && event.objectId === lamp.id), 8000, 'work event');
      const rows = await pool.query('SELECT kind, data FROM events WHERE object_id = $1 AND kind = ANY($2)', [lamp.id, KINDS]);
      assert.deepEqual([...new Set(rows.rows.map((row) => row.kind))].sort(), [...KINDS].sort());
      assert.ok(rows.rows.every((row) => !JSON.stringify(row.data).includes('sensor')), 'events carry identifiers, never text');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(outsiderLive.events.some((event) => event.objectId === lamp.id), false);

      const assigned = json<Page<WorkItem>>(await get(partner, `/api/v1/workspaces/${ws.id}/work/assigned`), 200);
      assert.ok(assigned.items.some((item) => item.id === work.id));
      assert.ok(assigned.items.every((item) => item.owner?.id === partner.id && !['done', 'not_pursued'].includes(item.status) && !item.parked));
      assert.equal(json<Page<WorkItem>>(await get(outsider, `/api/v1/workspaces/${ws.id}/work/assigned`), 200).total, 0);

      const grants = json<{ id: string; principal: { id: string } }[]>(await get(owner, `/api/v1/projects/${lamp.id}/grants`), 200);
      const partnerGrant = grants.find((item) => item.principal.id === partner.id)!;
      expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${lamp.id}/grants/${partnerGrant.id}`), 204);
      assert.equal((await get(partner, `/api/v1/work/${work.id}`)).status, 404);
      assert.equal((await get(partner, `/api/v1/projects/${lamp.id}/decisions`)).status, 404);
      const after = json<Page<WorkItem>>(await get(partner, `/api/v1/workspaces/${ws.id}/work/assigned`), 200);
      assert.equal(after.total, 0, 'the list filter hides work in projects the owner can no longer read');
      assert.equal((await patch(partner, `/api/v1/work/${work.id}`, { status: 'done' }, { 'if-match': '"1"' })).status, 404);
    } finally { await Promise.all([partnerLive.close(), outsiderLive.close()]); }
  });
});
