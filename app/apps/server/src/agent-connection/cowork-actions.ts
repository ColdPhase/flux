import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, AGENT_PEER_REQUEST_CLASSES, type AgentExecutionCommand, type AgentJsonValue,
  type AgentOperation, type AgentPeerRequestClass } from '@flux/contracts';
import { COWORK_CHECKPOINT_LIMITS, COWORK_DECLINE_REASONS, type Database } from '@flux/core';
import { coWorkClaimCheckpoint, coWorkClaimInTransaction } from '../co-work/claims.js';
import { COWORK_CLAIM_POLICY, COWORK_RESPONSES_WITHOUT_PUBLICATION, COWORK_UNIT_POLICY } from '../co-work/policy.js';
import { coWorkRequestResponseInTransaction } from '../co-work/responses.js';
import { coWorkUnitTransitionInTransaction } from '../co-work/transitions.js';
import { coWorkUnitCreateInTransaction } from '../co-work/units.js';
import { actionAnnotations as annotations, actionId as id, actionVersion as version } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

/** The standing-grant fields of a co-work tool; the class is the role of the unit the command acts on. */
const execution = {
  projectId: id,
  runtimeSessionId: id.describe('The runtime ID returned by flux_bootstrap for this client session.'),
  grantId: id.describe('A live standing grant from flux_bootstrap for this exact operation, project, class and target.'),
  clientCommandId: id.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
  peerRequestClass: z.enum(AGENT_PEER_REQUEST_CLASSES).describe('The class of the standing grant being used: the unit\'s role.'),
};
type Execution = { projectId: string; runtimeSessionId: string; grantId: string; clientCommandId: string;
  peerRequestClass: AgentPeerRequestClass };
/** The recipient's live claim on its own unit plus the exact request it acts on. */
const requestFence = {
  unitId: id.describe('Your own unit the request is addressed to.'),
  generation: version.describe('The generation of your live claim on that unit.'),
  leaseId: id.describe('The lease ID of your live claim on that unit.'),
  requestId: id,
  expectedRequestVersion: version.describe('The request version you last read.'),
};

/** Your live claim on your own unit, at the unit version you last read. */
const unitFence = {
  unitId: id.describe('Your own unit.'),
  expectedVersion: version.describe('The unit version you last read (from the claim, renewal or creation result).'),
  generation: version.describe('The generation of your live claim on that unit.'),
  leaseId: id.describe('The lease ID of your live claim on that unit.'),
};
const checkpointText = (maximum: number) => z.string().min(1).max(maximum);
/** One exact native reference; GitHub outcomes wait for the #74 recipient adapter. */
const outcomeRef = z.discriminatedUnion('type', [
  z.strictObject({ type: z.enum(['result', 'message']), id }),
  z.strictObject({ type: z.enum(['material', 'doc', 'work', 'thought']), id, version }),
]);
type Source = { materialId: string; version: number };

function command({ projectId, runtimeSessionId, grantId, clientCommandId, peerRequestClass }: Execution, operation: AgentOperation,
  objectId: string, payload: AgentJsonValue, sources: Source[] = []): AgentExecutionCommand {
  return { runtimeSessionId, grantId, clientCommandId, projectId, operation, peerRequestClass,
    audience: { kind: 'project', projectId }, objectId, sources, payload };
}

/**
 * Co-work tools (#153) over the existing internal compositions, one transaction per call. Each composition runs #152's
 * prepare/complete itself (current runtime, grant, command ledger, receipt) and writes no stream event. Unit claims,
 * renewal, release, completion and transfer are tools since 2026-10-06 ("Unit claims over MCP"); resolving a request
 * with a response, request admission and the inbox are not exposed yet (docs/development/cowork-coordination.md).
 */
export function registerAgentCoworkActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const register = (operation: AgentOperation) => tools.forScope('flux.action.execute', { operation, classes: AGENT_OPERATION_CLASSES[operation] });
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);

  register('cowork.unit.create').registerTool('flux_create_unit', {
    title: 'Take a task or open a co-work unit on it under a standing grant',
    description: 'Open one co-work unit (execute, review or plan) on a native task at the exact task version you last read. '
      + 'Needs a live cowork.unit.create grant whose class is the unit\'s role, and the runtime from flux_bootstrap. A root unit '
      + '(parent null) opens your own run on the task and is assigned to you; it is refused with COWORK_UNIT_TAKEN while another '
      + 'open unit of that role exists on the task, so it is the atomic way to take a task (or, for a plan unit, to be its sole '
      + 'plan writer). A child unit needs your live claim on a unit of the same task and may be assigned to another eligible '
      + 'connection. Creating a unit grants nobody a claim: its assignee claims it with its own owner\'s grant. The same unitKey '
      + 'returns the existing unit (status existing).',
    inputSchema: z.strictObject({ ...execution,
      taskId: id.describe('The native task the unit is for.'),
      unitKey: z.string().regex(/^[a-zA-Z0-9_:.-]{1,200}$/).describe('A stable key for this unit, for example "take" or "review-1".'),
      expectedTaskVersion: version.describe('The task version you last read.'),
      assignmentConnectionId: id.describe('Your own connection for a root unit; for a child, the connection that should do it.'),
      parent: z.strictObject({ unitId: id, generation: version, leaseId: id }).nullable()
        .describe('null for a root unit; otherwise your live claim on a unit of the same task.') }),
    annotations,
  }, ({ taskId, unitKey, expectedTaskVersion, assignmentConnectionId, parent, ...input }) => run(() =>
    db.transaction((tx) => coWorkUnitCreateInTransaction(tx, claims, command(input, 'cowork.unit.create', taskId,
      { unitKey, expectedTaskVersion, assignmentConnectionId, parent }), COWORK_UNIT_POLICY))));

  register('cowork.claim').registerTool('flux_claim_unit', {
    title: 'Claim your co-work unit under a standing grant',
    description: 'Take the live lease on one unit assigned to you, at the unit version you last read: only one connection and '
      + 'one runtime session hold it, for 300 seconds. Needs a live cowork.claim grant whose class is the unit\'s role, and the '
      + 'runtime from flux_bootstrap. One connection holds one live unit at a time (COWORK_CONNECTION_BUSY): release or complete '
      + 'it first. The task must be open (COWORK_TASK_CLOSED), and an execute unit needs every prerequisite done '
      + '(TASK_PREREQUISITES_UNMET). The result has the generation and lease ID that later unit and request tools need, and the '
      + 'unit\'s last checkpoint (summary, next action, blocker and the source versions it covered), if any.',
    inputSchema: z.strictObject({ ...execution, unitId: unitFence.unitId, expectedVersion: unitFence.expectedVersion }), annotations,
  }, ({ unitId, expectedVersion, ...input }) => run(() => db.transaction(async (tx) => {
    const outcome = await coWorkClaimInTransaction(tx, claims, command(input, 'cowork.claim', unitId, { expectedVersion }), COWORK_CLAIM_POLICY);
    return { ...outcome, checkpoint: await coWorkClaimCheckpoint(tx, { projectId: input.projectId, unitId: outcome.unitId },
      outcome.checkpointId) };
  })));

  register('cowork.renew').registerTool('flux_renew_unit', {
    title: 'Renew your live claim on a co-work unit under a standing grant',
    description: 'Extend your live lease on your own unit by another 300 seconds from now, before it ends. Needs a live '
      + 'cowork.renew grant whose class is the unit\'s role. A lease that already ended, another runtime session or a stale '
      + 'version is refused with COWORK_CLAIM_LOST or COWORK_VERSION_CONFLICT: claim the unit again instead. If the task '
      + 'closed or a prerequisite reopened meanwhile, renewal is refused: release the unit with a checkpoint or complete it.',
    inputSchema: z.strictObject({ ...execution, ...unitFence }), annotations,
  }, ({ unitId, expectedVersion, generation, leaseId, ...input }) => run(() => db.transaction((tx) =>
    coWorkClaimInTransaction(tx, claims, command(input, 'cowork.renew', unitId, { expectedVersion, generation, leaseId }), COWORK_CLAIM_POLICY))));

  register('cowork.release').registerTool('flux_release_unit', {
    title: 'Pause your co-work unit with a checkpoint under a standing grant',
    description: 'Release your live claim at a safe boundary and leave the unit paused with a durable checkpoint: what you '
      + 'observably did (changed artifacts, checks you actually ran), the next action and any blocker. The source material '
      + 'revisions you relied on are recorded with it and must still be current. Never put a prompt, hidden reasoning or a '
      + 'transcript in it. Needs a live cowork.release grant whose class is the unit\'s role. Whoever claims the unit next '
      + 'receives this checkpoint.',
    inputSchema: z.strictObject({ ...execution, ...unitFence,
      checkpoint: z.strictObject({ summary: checkpointText(COWORK_CHECKPOINT_LIMITS.summary),
        nextAction: checkpointText(COWORK_CHECKPOINT_LIMITS.nextAction),
        blocker: checkpointText(COWORK_CHECKPOINT_LIMITS.blocker).nullable() }),
      sources: z.array(z.strictObject({ materialId: id, version })).max(50).default([])
        .describe('The exact current material revisions this checkpoint relies on.') }), annotations,
  }, ({ unitId, expectedVersion, generation, leaseId, checkpoint, sources, ...input }) => run(() => db.transaction((tx) =>
    coWorkClaimInTransaction(tx, claims, command(input, 'cowork.release', unitId, { expectedVersion, generation, leaseId, checkpoint }, sources),
      COWORK_CLAIM_POLICY))));

  register('cowork.unit.complete').registerTool('flux_complete_unit', {
    title: 'Complete your co-work unit with its outcome under a standing grant',
    description: 'Finish your own unit under your live claim, naming its outcome: one exact native record that exists now (a '
      + 'result or message ID, or a material, doc, task or thought at its version). Completion is final. It does not change '
      + 'the task, approve anything or resolve a request. Requests still open on the unit refuse it '
      + '(COWORK_UNIT_REQUESTS_OPEN): answer or decline them first. Needs a live cowork.unit.complete grant whose class is the '
      + 'unit\'s role.',
    inputSchema: z.strictObject({ ...execution, ...unitFence, outcome: outcomeRef }), annotations,
  }, ({ unitId, expectedVersion, generation, leaseId, outcome, ...input }) => run(() => db.transaction((tx) =>
    coWorkUnitTransitionInTransaction(tx, claims, command(input, 'cowork.unit.complete', unitId,
      { expectedVersion, generation, leaseId, outcome }), COWORK_UNIT_POLICY))));

  register('cowork.unit.transfer').registerTool('flux_transfer_unit', {
    title: 'Hand your co-work unit to another connection under a standing grant',
    description: 'Reassign your own unit, under your live claim, to another live connection of this workspace that has this '
      + 'project selected. The unit becomes pending for it and your claim ends; it claims the unit with its own owner\'s '
      + 'grant and receives the unit\'s last checkpoint. An author never hands review of its own work to itself '
      + '(COWORK_REVIEW_SEPARATION), and open requests on the unit refuse the transfer (COWORK_UNIT_REQUESTS_OPEN). Needs a live '
      + 'cowork.unit.transfer grant whose class is the unit\'s role.',
    inputSchema: z.strictObject({ ...execution, ...unitFence,
      assignmentConnectionId: id.describe('The connection that should continue the unit.') }), annotations,
  }, ({ unitId, expectedVersion, generation, leaseId, assignmentConnectionId, ...input }) => run(() => db.transaction((tx) =>
    coWorkUnitTransitionInTransaction(tx, claims, command(input, 'cowork.unit.transfer', unitId,
      { expectedVersion, generation, leaseId, assignmentConnectionId }), COWORK_UNIT_POLICY))));

  register('cowork.request.claim').registerTool('flux_claim_request', {
    title: 'Pick up a request addressed to your unit under a standing grant',
    description: 'Claim one request addressed to your own unit, at the request version you last read, under your live claim on '
      + 'that unit. Needs a live cowork.request.claim grant whose class is your unit\'s role, and the runtime from flux_bootstrap. '
      + 'A request is claimed once per live claim; after your claim is lost it can be claimed again. Without a live unit claim this '
      + 'is refused with COWORK_CLAIM_LOST.',
    inputSchema: z.strictObject({ ...execution, ...requestFence }), annotations,
  }, ({ unitId, generation, leaseId, requestId, expectedRequestVersion, ...input }) => run(() =>
    db.transaction((tx) => coWorkRequestResponseInTransaction(tx, claims, command(input, 'cowork.request.claim', unitId,
      { generation, leaseId, requestId, expectedRequestVersion }), COWORK_RESPONSES_WITHOUT_PUBLICATION))));

  register('cowork.request.respond').registerTool('flux_decline_request', {
    title: 'Decline a request you picked up under a standing grant',
    description: 'Decline one request you claimed under your live unit claim, with a bounded reason: capability, policy, scope '
      + 'or source_changed. The sender sees the outcome; it is never a silent drop. Needs a live cowork.request.respond grant '
      + 'whose class is your unit\'s role, and the runtime from flux_bootstrap. Resolving a request with a response is not '
      + 'available on this server yet.',
    inputSchema: z.strictObject({ ...execution, ...requestFence, reason: z.enum(COWORK_DECLINE_REASONS) }), annotations,
  }, ({ unitId, generation, leaseId, requestId, expectedRequestVersion, reason, ...input }) => run(() =>
    db.transaction((tx) => coWorkRequestResponseInTransaction(tx, claims, command(input, 'cowork.request.respond', unitId,
      { generation, leaseId, requestId, expectedRequestVersion, outcome: 'declined', reason }), COWORK_RESPONSES_WITHOUT_PUBLICATION))));
}
