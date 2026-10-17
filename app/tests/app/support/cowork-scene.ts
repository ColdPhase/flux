import { randomUUID } from 'node:crypto';
import type { Agent, AgentStandingGrant, WorkItem } from '@flux/contracts';
import { pool } from './db.js';
import { agentConnection } from './mcp-actions.js';
import { toolValue } from './mcp.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './people.js';

// The shared starting point of the co-work card and concurrency tests (#153, #400): two owners, three real OAuth
// connections and a project with a reader of every kind. Hubert owns the workspace (so manages the project) and two agents,
// Codex and Hubert Claude; Marek is an admin (and so a manager) who owns Marek Claude and can be demoted to a plain
// contributor; Ada is a contributor who owns no agent;
// Vera only reads; Olga has no access at all.
export const ACTION_SCOPES = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];
export type Role = 'execute' | 'review' | 'plan';
export type Reply = Record<string, unknown> | null;
export interface Claim { generation: number; version: number; unitId: string; lease: { id: string } }

/** Whether a tool reply is a failure (a domain refusal or a schema error), without asserting which. */
export const failed = (reply: Reply) => !!reply?.error || (reply?.result as { isError?: boolean } | undefined)?.isError === true;
/** The domain code of a failed tool reply, or null for anything else. */
export function failureCode(reply: Reply): string | null {
  const result = reply?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  if (result?.isError !== true) return null;
  try { return (JSON.parse(result.content?.[0]?.text ?? '{}') as { code?: string }).code ?? null; } catch { return null; }
}

export async function coworkScene() {
  const [hubert, marek, ada, vera, olga] = await Promise.all(['cw-hubert', 'cw-marek', 'cw-ada', 'cw-vera', 'cw-olga'].map(person));
  const ws = await workspace(hubert, 'Co-work cards');
  // Marek is a workspace admin (so a project manager, which minting standing grants for his agent needs); Ada, Vera and Olga are members.
  await addMember(hubert, ws.id, marek, 'admin');
  for (const member of [ada, vera, olga]) await addMember(hubert, ws.id, member, 'member');
  const p = await project(hubert, ws.id, 'Shared outcome', 'restricted');
  /** The project grants by person, so a test can remove one and watch the reader lose access. */
  const grants = new Map<string, string>();
  for (const [who, role] of [[marek, 'contributor'], [ada, 'contributor'], [vera, 'viewer']] as const)
    grants.set(who.id, (expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
      { body: { principal: { kind: 'human', id: who.id }, role } }), 201) as { id: string }).id);
  /** Marek stops managing: he is a contributor who still owns his agent (and so can still clear what it sent or was sent). */
  const demote = async (who: Person) => expectStatus(await hubert.browser.request('PATCH', `/api/v1/workspaces/${ws.id}/members/${who.id}`, { body: { role: 'member' } }), 200);
  /** Removes the person's project grant: they no longer read the project. */
  const removeAccess = async (who: Person) => expectStatus(await hubert.browser.request('DELETE', `/api/v1/projects/${p.id}/grants/${grants.get(who.id)}`), 204);

  const connect = async (who: Person, name: string) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as Agent;
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const connected = await agentConnection(pool, who.browser, String(agent.id), [p.id], ACTION_SCOPES);
    const standing = async (operation: string, objectId: string | null, role: Role, maximumUses = 10) =>
      expectStatus(await who.browser.request('POST', `/api/v1/agent-connections/${connected.connectionId}/action-grants`, { body: {
        clientCommandId: randomUUID(), projectId: p.id, operation, peerRequestClass: role, maximumUses, ...(objectId ? { objectId } : {}),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as AgentStandingGrant;
    /** The command fields of one runtime session of this connection. */
    const sessionOf = (runtimeSessionId: string) => {
      const base = (grantId: string, role: Role, clientCommandId: string = randomUUID()) => ({ projectId: p.id, runtimeSessionId, grantId,
        clientCommandId, peerRequestClass: role });
      const claimUnit = async (unitId: string, role: Role, expectedVersion = 1) => {
        const g = await standing('cowork.claim', unitId, role);
        return { ...toolValue(await connected.tool('flux_claim_unit', { ...base(g.id, role), unitId, expectedVersion })), unitId } as unknown as Claim;
      };
      return { runtimeSessionId, base, claimUnit };
    };
    const main = sessionOf(connected.runtimeSessionId);
    /** Another live runtime session of the same connection (a second window of the same client). */
    const extraSession = async () => sessionOf(String((toolValue(await connected.tool('flux_bootstrap',
      { projectId: p.id, clientSessionId: randomUUID() })).runtime as { id: string }).id));
    const call = (name: string, args: Record<string, unknown>) => connected.tool(name, args);
    return { ...connected, who, name, agentId: String(agent.id), standing, ...main, sessionOf, extraSession, call };
  };
  type Conn = Awaited<ReturnType<typeof connect>>;

  const task = async (title: string) => expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`,
    { body: { title } }), 201) as WorkItem;
  const material = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Review findings', body: 'Two findings, both fixed' } }), 201) as { materialId: string };
  const used = async (grantId: string) => Number((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0]?.used ?? -1);
  const unit = async (unitId: string) => (await pool.query(
    'SELECT state, generation, version, assignment_connection_id AS assignee, transferred_from_connection_id AS "from", lease_id AS lease FROM cowork_units WHERE id=$1',
    [unitId])).rows[0] as { state: string; generation: number; version: number; assignee: string; from: string | null; lease: string | null };
  const request = async (requestId: string) => (await pool.query('SELECT state, version, reason, cancelled_by AS "cancelledBy" FROM cowork_requests WHERE id=$1', [requestId])).rows[0] as
    { state: string; version: number; reason: string | null; cancelledBy: string | null };

  /** `owner` takes a task (a root execute unit it claims) and returns the unit with its live claim. */
  async function take(owner: Conn, t: WorkItem, key = 'take') {
    const grantOf = await owner.standing('cowork.unit.create', t.id, 'execute');
    const created = toolValue(await owner.call('flux_create_unit', { ...owner.base(grantOf.id, 'execute'), taskId: t.id, unitKey: key,
      expectedTaskVersion: t.version, assignmentConnectionId: owner.connectionId, parent: null }));
    const unitId = String(created.unitId);
    return { unitId, claim: await owner.claimUnit(unitId, 'execute') };
  }
  /** The holder opens a child unit of `role` on the same task for `assignee` (not yet claimed by it). */
  async function openUnit(holder: Conn, held: { unitId: string; claim: Claim }, t: WorkItem, role: Role, assignee: Conn, key: string) {
    const grantOf = await holder.standing('cowork.unit.create', t.id, role);
    const created = toolValue(await holder.call('flux_create_unit', { ...holder.base(grantOf.id, role), taskId: t.id, unitKey: key,
      expectedTaskVersion: t.version, assignmentConnectionId: assignee.connectionId,
      parent: { unitId: held.unitId, generation: held.claim.generation, leaseId: held.claim.lease.id } }));
    return String(created.unitId);
  }
  /**
   * The author takes `t`, opens a review unit for `reviewer`, which claims it, and a standing request grant is ready: the
   * normal start of a review. `send` is the author's flux_send_request.
   */
  async function startReview(author: Conn, reviewer: Conn, t: WorkItem, key = 'r1') {
    const held = await take(author, t);
    const reviewUnit = await openUnit(author, held, t, 'review', reviewer, key);
    const reviewClaim = await reviewer.claimUnit(reviewUnit, 'review');
    const ask = await author.standing('cowork.request', held.unitId, 'execute', 50);
    const send = (intentKey: string, target: Record<string, unknown>, options: { clientCommandId?: string; kind?: string; sourceRefs?: unknown[] } = {}) =>
      author.call('flux_send_request', { ...author.base(ask.id, 'execute', options.clientCommandId), unitId: held.unitId, generation: held.claim.generation,
        leaseId: held.claim.lease.id, recipientUnitId: reviewUnit, expectedRecipientUnitVersion: reviewClaim.version, recipientConnectionId: reviewer.connectionId,
        intentKey, parentRequestId: null, kind: options.kind ?? 'review', target,
        sourceRefs: options.sourceRefs ?? [{ type: 'material', id: material.materialId, version: 1 }], criteriaRefs: [target], peerUnblocking: true });
    return { held, reviewUnit, reviewClaim, ask, send };
  }

  return { hubert, marek, ada, vera, olga, ws, p, removeAccess, demote, connect, task, material, used, unit, request, take, openUnit, startReview };
}
export type CoworkScene = Awaited<ReturnType<typeof coworkScene>>;
export type CoworkConn = Awaited<ReturnType<CoworkScene['connect']>>;
