import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { DomainError, type Principal } from '@flux/core';
import { AGENT_OPERATIONS, type Agent, type Decision, type Project, type Workspace } from '@flux/contracts';
import { workUseCases } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import type { Browser } from './support/http.js';
import { expect as expectMcp, toolValue } from './support/mcp.js';
import { actionScene } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, person, project as createProject, removeMember, workspace as createWorkspace, type Person } from './support/people.js';

// Who may accept or supersede a project decision (#250, decision O-009 in docs/product/decision-authority.md).
// DA-2: one signed-in person whose CURRENT project level is contributor or manager accepts; viewers, people
// without access, agents and the assistant never do. DA-3: superseding happens only by such an acceptance.
// DA-4: nothing accepts silently, and a refusal changes nothing. DA-5: no delegated acceptance in v0.1.
// The assistant path is proven in personal-runs.test.ts ("#250 AC-3"), next to its fake compute.

const accept = (browser: Browser, id: string, version: number, body: Record<string, unknown> = {}) =>
  browser.request('POST', `/api/v1/decisions/${id}/accept`, { body, headers: { 'if-match': `"${version}"` } });

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code, `expected ${code}`);
}

async function acceptedEvents(decisionId: string) {
  return (await pool.query("SELECT count(*)::int AS n FROM events WHERE kind = 'project.decision_accepted.v1' AND data->>'decisionId' = $1",
    [decisionId])).rows[0].n as number;
}

/** DA-4: the stored decision is still the untouched proposal and no acceptance event exists for it. */
async function stillProposed(reader: Browser, decision: Decision, label: string) {
  const current = expectStatus(await reader.request('GET', `/api/v1/decisions/${decision.id}`), 200, label) as Decision;
  assert.deepEqual([current.status, current.version, current.decidedBy, current.decidedAt], ['proposed', decision.version, null, null], label);
  assert.equal(await acceptedEvents(decision.id), 0, `${label}: no acceptance event`);
}

describe('decision acceptance authority (#250, O-009)', () => {
  // ada owns the workspace; adam is an admin; mia, nat and leo are members; vic is a member narrowed to viewer;
  // gus is a guest with a contributor grant; gil a guest without one; dee an admin denied on the project.
  let ada: Person; let adam: Person; let mia: Person; let nat: Person; let leo: Person; let vic: Person;
  let gus: Person; let gil: Person; let dee: Person; let outsider: Person;
  let ws: Workspace; let lamp: Project;
  let personalAgent: Agent; let sharedAgent: Agent;
  const work = workUseCases(db);
  const decisionsPath = () => `/api/v1/projects/${lamp.id}/decisions`;
  const propose = async (someone: Person, title: string, extra: Record<string, unknown> = {}) =>
    expectStatus(await someone.browser.request('POST', decisionsPath(), { body: { title, rationale: `Why: ${title}`, ...extra } }), 201, `propose ${title}`) as Decision;

  before(async () => {
    [ada, adam, mia, nat, leo, vic, gus, gil, dee, outsider] = await Promise.all(
      ['da-ada', 'da-adam', 'da-mia', 'da-nat', 'da-leo', 'da-vic', 'da-gus', 'da-gil', 'da-dee', 'da-outsider'].map(person));
    ws = await createWorkspace(ada, 'Decision authority');
    for (const [someone, role] of [[adam, 'admin'], [dee, 'admin'], [mia, 'member'], [nat, 'member'], [leo, 'member'], [vic, 'member'],
      [gus, 'guest'], [gil, 'guest']] as const) await addMember(ada, ws.id, someone, role);
    // A workspace-visible project: members write by default, guests only through a grant.
    lamp = await createProject(ada, ws.id, 'Gesture lamp', 'workspace');
    await grant(ada, lamp.id, vic, 'viewer');
    await grant(ada, lamp.id, gus, 'contributor');
    await grant(ada, lamp.id, dee, 'denied');
    personalAgent = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada helper', owner: 'self' } }), 201) as Agent;
    sharedAgent = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Lab agent', owner: 'workspace' } }), 201) as Agent;
    for (const agent of [personalAgent, sharedAgent])
      expectStatus(await ada.browser.request('POST', `/api/v1/projects/${lamp.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  });

  test('DA-2: a person with current project write accepts; viewers, people without access and agents are refused with nothing changed', async () => {
    const proposal = await propose(mia, 'Use a ToF sensor');
    for (const [someone, status, label] of [[vic, 403, 'a viewer'], [gil, 404, 'a guest without a grant'],
      [dee, 404, 'an admin denied on the project'], [outsider, 404, 'someone outside the workspace']] as const) {
      const refused = await accept(someone.browser, proposal.id, proposal.version);
      assert.equal(refused.status, status, `${label}: ${refused.text}`);
      await stillProposed(ada.browser, proposal, label);
    }
    // An agent never accepts, even one owned by the workspace owner or owned by the workspace, with a contributor grant.
    for (const [agent, label] of [[personalAgent, 'the owner\'s own agent'], [sharedAgent, 'a workspace-owned agent']] as const) {
      const principal: Principal = { kind: 'agent', id: agent.id };
      await rejects(work.acceptDecision(principal, proposal.id, {}, proposal.version), 'DECISION_NEEDS_PERSON');
      await stillProposed(ada.browser, proposal, label);
    }

    // The proposer may accept their own proposal; the person is recorded as the decider.
    const own = expectStatus(await accept(mia.browser, proposal.id, proposal.version), 200, 'own proposal') as Decision;
    assert.deepEqual([own.status, own.decidedBy?.id, own.proposedBy.id], ['accepted', mia.id, mia.id]);
    assert.equal(await acceptedEvents(proposal.id), 1);
    // Every other kind of person with project write: the owner and an admin (managers), and a guest with a contributor grant.
    for (const [someone, label] of [[ada, 'the workspace owner'], [adam, 'an admin'], [gus, 'a guest with a contributor grant']] as const) {
      const next = await propose(nat, `Accepted by ${label}`);
      const accepted = expectStatus(await accept(someone.browser, next.id, next.version), 200, label) as Decision;
      assert.deepEqual([accepted.status, accepted.decidedBy?.id, accepted.proposedBy.id], ['accepted', someone.id, nat.id], label);
      assert.equal(await acceptedEvents(next.id), 1, label);
    }
  });

  test('DA-2: authority is the current one at acceptance: narrowed after proposing, or gone from the workspace, is refused', async () => {
    const narrowedOwn = await propose(nat, 'Battery powered lamp');
    await grant(ada, lamp.id, nat, 'viewer');
    const refused = await accept(nat.browser, narrowedOwn.id, narrowedOwn.version);
    assert.equal(refused.status, 403, `narrowed to viewer after proposing: ${refused.text}`);
    await stillProposed(ada.browser, narrowedOwn, 'narrowed proposer');

    const leaving = await propose(leo, 'Ship in spring');
    await removeMember(ada, ws.id, leo);
    const gone = await accept(leo.browser, leaving.id, leaving.version);
    assert.equal(gone.status, 404, `removed from the workspace: ${gone.text}`);
    await stillProposed(ada.browser, leaving, 'removed proposer');
    // The proposal stays for the people who still hold authority.
    const accepted = expectStatus(await accept(gus.browser, leaving.id, leaving.version), 200, 'accepted by a remaining contributor') as Decision;
    assert.deepEqual([accepted.status, accepted.decidedBy?.id, accepted.proposedBy.id], ['accepted', gus.id, leo.id]);
  });

  test('DA-3/DA-4: a replacement supersedes only when an authorized person accepts it, and nothing accepts silently', async () => {
    const rule = await propose(mia, 'Use a camera for gestures');
    expectStatus(await accept(ada.browser, rule.id, rule.version), 200, 'current rule');
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM project_decisions WHERE project_id = $1', [lamp.id])).rows[0].n as number;
    const before = await count();
    // A create body that claims a status or a decider is still only a proposal by its actual author: the API
    // ignores fields it does not define.
    for (const body of [{ title: 'Already decided', status: 'accepted' }, { title: 'Decided by Ada', decidedBy: ada.id, decidedAt: new Date().toISOString() }]) {
      const created = expectStatus(await mia.browser.request('POST', decisionsPath(), { body }), 201, JSON.stringify(body)) as Decision;
      assert.deepEqual([created.status, created.decidedBy, created.proposedBy.id], ['proposed', null, mia.id], JSON.stringify(body));
      await stillProposed(ada.browser, created, `create body ${JSON.stringify(body)}`);
    }
    assert.equal(await count(), before + 2);
    assert.equal((await vic.browser.request('POST', decisionsPath(), { body: { title: 'Viewer replacement', supersedes: rule.id } })).status, 403,
      'a viewer cannot even propose a replacement');

    // An agent proposes the replacement; the current rule does not move.
    const agent: Principal = { kind: 'agent', id: personalAgent.id };
    const replacement = await work.proposeDecision(agent, lamp.id, { title: 'Use a ToF sensor instead', rationale: 'Works in the dark', supersedes: rule.id });
    const current = async () => expectStatus(await mia.browser.request('GET', `/api/v1/decisions/${rule.id}`), 200) as Decision;
    assert.deepEqual([replacement.status, replacement.proposedBy.kind, (await current()).status], ['proposed', 'agent', 'accepted']);
    assert.equal((await accept(vic.browser, replacement.id, replacement.version)).status, 403);
    assert.equal((await accept(vic.browser, replacement.id, replacement.version, { decidedBy: ada.id })).status, 403,
      'naming someone with authority lends none');
    await rejects(work.acceptDecision(agent, replacement.id, {}, replacement.version), 'DECISION_NEEDS_PERSON');
    await stillProposed(ada.browser, replacement, 'refused replacement');
    assert.equal((await current()).status, 'accepted', 'the current rule stays current until a person decides');

    // A guest contributor accepts the replacement: the earlier rule is superseded and keeps its history. The
    // caller is the decider, whoever the body names.
    const pivot = expectStatus(await accept(gus.browser, replacement.id, replacement.version, { decidedBy: ada.id }), 200, 'pivot') as Decision;
    assert.deepEqual([pivot.status, pivot.decidedBy?.id, pivot.supersedes], ['accepted', gus.id, rule.id]);
    const earlier = await current();
    assert.deepEqual([earlier.status, earlier.supersededBy, earlier.decidedBy?.id, earlier.rationale],
      ['superseded', replacement.id, ada.id, 'Why: Use a camera for gestures']);

    // The database refuses an accepted row without a person behind it.
    const raw = await propose(mia, 'Written around the API');
    await assert.rejects(pool.query("UPDATE project_decisions SET status = 'accepted' WHERE id = $1", [raw.id]), { code: '23514' },
      'accepted without a decider violates the CHECK');
    await assert.rejects(pool.query("UPDATE project_decisions SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1",
      [raw.id, personalAgent.id]), { code: '23503' }, 'an agent id is not a person account');
    await stillProposed(ada.browser, raw, 'raw SQL');
  });

  test('AC-3 native agent: an MCP proposal stays proposed; no tool, operation or standing grant accepts; a person with authority does', async () => {
    const f = await actionScene(pool);
    const rule = expectMcp(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/decisions`, { body: { title: 'Measure at 5 lux', rationale: 'Bedroom light' } }), 201);
    expectMcp(await f.owner.request('POST', `/api/v1/decisions/${rule.id}/accept`, { body: { expectedVersion: 1 } }), 200);
    const proposeGrant = await f.grant('decision.propose', 'plan');
    const base = (decision: Record<string, unknown>) => ({ projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: proposeGrant.id,
      clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [f.source], decision });
    const proposed = toolValue(await f.tool('flux_propose_decision', base({ title: 'Measure at 1 lux', rationale: 'Dark rooms', supersedes: rule.id })));
    const decisionId = String(proposed.decisionId);
    const read = async (id: string) => expectMcp(await f.owner.request('GET', `/api/v1/decisions/${id}`), 200) as unknown as Decision;
    const proposal = await read(decisionId);
    assert.deepEqual([proposal.status, proposal.proposedBy.kind, proposal.proposedBy.id, proposal.decidedBy], ['proposed', 'agent', f.agentId, null]);
    assert.equal((await read(String(rule.id))).status, 'accepted', 'an agent proposal does not move the current rule');

    // The tool cannot carry a status or a decider, and nothing is stored when it tries.
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM project_decisions WHERE project_id = $1', [f.projectId])).rows[0].n as number;
    const before = await count();
    for (const sneaked of [{ status: 'accepted' }, { decidedBy: 'someone' }]) {
      const refused = await f.tool('flux_propose_decision', base({ title: 'Already accepted', ...sneaked }));
      assert.ok(refused?.error || (refused?.result as { isError?: boolean } | undefined)?.isError, `a strict schema refuses ${JSON.stringify(sneaked)}`);
    }
    assert.equal(await count(), before);

    // No registered tool or agent operation accepts, supersedes or rejects a decision.
    const names = await f.toolNames();
    assert.deepEqual(names.filter((name) => name.includes('decision')).sort(), ['flux_get_decision', 'flux_list_decisions', 'flux_propose_decision']);
    assert.deepEqual(names.filter((name) => /accept|approve|reject|supersede|decide/i.test(name)), []);
    const unknown = await f.raw('flux_accept_decision', { projectId: f.projectId, decisionId, expectedVersion: 1 });
    const unknownResult = unknown.message?.result as { isError?: boolean } | undefined;
    assert.ok(unknown.status !== 200 || unknown.message?.error || unknownResult?.isError, 'an accept tool does not exist');
    assert.deepEqual(AGENT_OPERATIONS.filter((operation) => operation.startsWith('decision.')), ['decision.propose']);
    // DA-5: a standing grant has a scope and an expiry, but it can never name acceptance.
    const delegation = await f.owner.request('POST', `/api/v1/agent-connections/${f.connectionId}/action-grants`, { body: {
      clientCommandId: randomUUID(), projectId: f.projectId, operation: 'decision.accept', peerRequestClass: 'plan', maximumUses: 1,
      objectId: decisionId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    assert.equal(delegation.status, 400, delegation.text);

    // The agent itself (owned by the project's manager) is refused; so is a person who can only read.
    await rejects(work.acceptDecision({ kind: 'agent', id: f.agentId }, decisionId, {}, 1), 'DECISION_NEEDS_PERSON');
    const reader = await person('da-mcp-viewer');
    expectMcp(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/members`, { body: { email: reader.email, role: 'member' } }), 201);
    expectMcp(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/grants`, { body: { principal: { kind: 'human', id: reader.id }, role: 'viewer' } }), 201);
    assert.equal((await accept(reader.browser, decisionId, 1)).status, 403);
    await stillProposed(f.owner, proposal, 'agent proposal after refusals');
    assert.equal((await read(String(rule.id))).status, 'accepted');

    // The person with authority decides: the agent stays the proposer, the person the decider.
    const accepted = expectMcp(await accept(f.owner, decisionId, 1), 200) as unknown as Decision;
    const me = expectMcp(await f.owner.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
    assert.deepEqual([accepted.status, accepted.proposedBy.kind, accepted.decidedBy?.kind, accepted.decidedBy?.id], ['accepted', 'agent', 'human', me.user.id]);
    assert.deepEqual([(await read(String(rule.id))).status, (await read(String(rule.id))).supersededBy], ['superseded', decisionId]);
  });
});
